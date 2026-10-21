/**
 * Seller DD on-chain reads with typed failure reasons (Odin outside review #1, 10/21).
 * Before: readHistory/authorizationTx asked ONE provider (base.drpc.org, whose free plan refuses eth_getLogs) and
 * swallowed every error, so history_and_lookalike was skipped on every verdict.
 * Now:
 *   - History: Blockscout public Base API (keyless) first, then eth_getLogs over an ordered provider list
 *     (BASE_RPC_URL if set, publicnode, mainnet.base.org, drpc last), chunked at <= 2,000 blocks.
 *   - Hard caps for the whole read: <= 12 HTTP calls and <= 6 s, inside the request deadline.
 *   - One retry per provider only on 429 / 5xx / timeout. No retry on 4xx: go to the next source.
 *   - Every failed source is recorded as {source, reason}; the caller writes them into the verdict evidence.
 */
import { USDC_BASE } from "@/lib/config";
import type { RpcDeps } from "@/lib/chain-rpc";
import { isEvmAddress } from "./screen";

export const HISTORY_MAX_CALLS = 12;
export const HISTORY_BUDGET_MS = 6_000;
export const LOG_CHUNK_BLOCKS = 2_000;
export const HISTORY_WINDOW_BLOCKS = 9_000;
/** Blockscout v2 page size (newest page only). */
export const BLOCKSCOUT_PAGE_TRANSFERS = 50;
export const BLOCKSCOUT_BASE = "https://base.blockscout.com";
const PER_CALL_TIMEOUT_MS = 3_000;
const RETRY_BACKOFF_MS = 250;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTH_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;

export type SourceAttempt = { source: string; reason: string };
/**
 * Sentinel LOW-1: every reason that can reach a signed verdict is one of these fixed tokens (an HTTP code is the only
 * variable part; getLogs reasons carry our own block range). Anything else is replaced with "other".
 */
export const HISTORY_REASON_TOKENS = ["call_cap", "time_cap", "timeout", "network_error", "bad_json", "bad_shape", "bad_head", "rpc_error", "payTo_malformed", "no_matching_log"] as const;
const TOKEN_RE = new RegExp(`^(?:http_[1-5][0-9]{2}|${HISTORY_REASON_TOKENS.join("|")})$`);
function safeToken(t: string): string { return TOKEN_RE.test(t) ? t : "other"; }
/** "a;retry:b", "head:a", "getLogs 1-2:a;retry:b" -> each token checked against the fixed list. */
export function safeReason(reason: string): string {
  const m = /^(head:|getLogs [0-9]+-[0-9]+:)?(.*)$/.exec(reason)!;
  const parts = m[2]!.split(";retry:").map(safeToken);
  return `${m[1] ?? ""}${parts.join(";retry:")}`;
}
const pushAttempt = (a: SourceAttempt[], source: string, reason: string) => { a.push({ source, reason: safeReason(reason) }); };
export type History = { window_blocks: number; window_days: number; unique_payers: number; repeat_payers: number; first_seen_block: number | null; volume_usdc: string; from_block: number; to_block: number; source: string; window_kind?: "newest_transfers" | "blocks" };
export type HistoryRead = { ok: true; history: History; attempts: SourceAttempt[] } | { ok: false; attempts: SourceAttempt[] };
export type ReadDeps = RpcDeps & { sleep?: (ms: number) => Promise<void>; env?: Record<string, string | undefined> };

/** Ordered Base log providers: BASE_RPC_URL (if set) first, publicnode, mainnet.base.org, drpc LAST. Deduplicated. */
export function baseLogRpcs(env: Record<string, string | undefined> = process.env): string[] {
  const raw = [env.BASE_RPC_URL ?? "", "https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"].filter(Boolean);
  return [...new Set(raw)];
}
/** Host only (never a path or query, so a keyed BASE_RPC_URL never leaks into a verdict). */
export const hostOf = (u: string) => { try { return new URL(u).host; } catch { return "invalid_url"; } };

class Budget {
  calls = 0;
  constructor(private deps: ReadDeps, private until: number) {}
  remaining() { return this.until - this.deps.now(); }
  take(): string | null {
    if (this.calls >= HISTORY_MAX_CALLS) return "call_cap";
    if (this.remaining() <= 0) return "time_cap";
    this.calls++;
    return null;
  }
}

type CallOut = { ok: true; json: unknown } | { ok: false; reason: string; retryable: boolean };
async function once(deps: ReadDeps, b: Budget, url: string, init: RequestInit): Promise<CallOut> {
  const cap = b.take();
  if (cap) return { ok: false, reason: cap, retryable: false };
  try {
    const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(PER_CALL_TIMEOUT_MS, b.remaining()))) });
    // Sentinel LOW-1 (10/21): HTTP status code only; provider error text never enters a reason (reasons land in signed verdicts).
    if (!res.ok) return { ok: false, reason: `http_${res.status}`, retryable: res.status === 429 || res.status >= 500 };
    let json: unknown;
    try { json = await res.json(); } catch { return { ok: false, reason: "bad_json", retryable: false }; }
    const err = (json as { error?: { message?: string } } | null)?.error;
    if (err && typeof err === "object") return { ok: false, reason: "rpc_error", retryable: false };
    return { ok: true, json };
  } catch (e) {
    const n = (e as { name?: string })?.name;
    return { ok: false, reason: n === "TimeoutError" || n === "AbortError" ? "timeout" : "network_error", retryable: n === "TimeoutError" || n === "AbortError" };
  }
}
/** One call plus at most ONE retry, only on 429 / 5xx / timeout. */
async function call(deps: ReadDeps, b: Budget, url: string, init: RequestInit): Promise<CallOut> {
  const first = await once(deps, b, url, init);
  if (first.ok || !first.retryable) return first;
  await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(RETRY_BACKOFF_MS);
  const second = await once(deps, b, url, init);
  return second.ok ? second : { ok: false, reason: `${first.reason};retry:${second.reason}`, retryable: false };
}
const rpcBody = (method: string, params: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
const hex = (v: unknown): bigint | null => { try { return typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? BigInt(v === "0x" ? "0x0" : v) : null; } catch { return null; } };

function summarize(rows: { from: string; value: bigint; block: number }[], fromBlock: number, toBlock: number, source: string): History {
  const counts = new Map<string, number>();
  let vol = 0n, first: number | null = null;
  for (const r of rows) {
    counts.set(r.from, (counts.get(r.from) ?? 0) + 1);
    vol += r.value;
    if (first === null || r.block < first) first = r.block;
  }
  const blocks = Math.max(0, toBlock - fromBlock + 1);
  return { window_blocks: blocks, window_days: Math.round((blocks * 2) / 864) / 100, unique_payers: counts.size, repeat_payers: [...counts.values()].filter((n) => n > 1).length, first_seen_block: first, volume_usdc: `${vol / 1_000_000n}.${(vol % 1_000_000n).toString().padStart(6, "0")}`, from_block: fromBlock, to_block: toBlock, source };
}

/** Source 1: Blockscout v2 token-transfers TO payTo (USDC only), newest page (up to 50 transfers). */
async function fromBlockscout(payTo: string, deps: ReadDeps, b: Budget): Promise<{ ok: true; history: History } | { ok: false; reason: string }> {
  const url = `${BLOCKSCOUT_BASE}/api/v2/addresses/${payTo}/token-transfers?type=ERC-20&filter=to&token=${USDC_BASE}`;
  const r = await call(deps, b, url, { method: "GET", headers: { accept: "application/json" } });
  if (!r.ok) return { ok: false, reason: r.reason };
  const items = (r.json as { items?: unknown })?.items;
  if (!Array.isArray(items)) return { ok: false, reason: "bad_shape" };
  const rows: { from: string; value: bigint; block: number }[] = [];
  for (const it of items as Record<string, any>[]) {
    const token = String(it?.token?.address_hash ?? it?.token?.address ?? "").toLowerCase();
    const to = String(it?.to?.hash ?? "").toLowerCase();
    const from = String(it?.from?.hash ?? "").toLowerCase();
    const block = Number(it?.block_number);
    let value: bigint;
    try { value = BigInt(String(it?.total?.value ?? "")); } catch { return { ok: false, reason: "bad_shape" }; }
    if (token !== USDC_BASE.toLowerCase() || to !== payTo.toLowerCase() || !isEvmAddress(from) || !Number.isInteger(block)) continue;
    rows.push({ from, value, block });
  }
  const blocks = rows.map((x) => x.block);
  const lo = blocks.length ? Math.min(...blocks) : 0, hi = blocks.length ? Math.max(...blocks) : 0;
  // Sentinel LOW-2: Blockscout's window is the newest page of transfers, not a block range
  return { ok: true, history: { ...summarize(rows, lo, hi, hostOf(BLOCKSCOUT_BASE)), window_kind: "newest_transfers" } };
}

/**
 * Read `windowBlocks` blocks of logs ending at head, in chunks of <= LOG_CHUNK_BLOCKS, each chunk trying providers in
 * order (starting at the last one that answered). Any chunk unreadable on all providers -> failure (never a partial count).
 */
async function logsWindow(filter: Record<string, unknown>, windowBlocks: number, deps: ReadDeps, b: Budget, attempts: SourceAttempt[]): Promise<{ logs: Record<string, any>[]; from: number; to: number; source: string } | null> {
  const urls = baseLogRpcs(deps.env ?? process.env);
  let head: bigint | null = null, start = 0;
  for (let i = 0; i < urls.length && head === null; i++) {
    const r = await call(deps, b, urls[i]!, rpcBody("eth_blockNumber", []));
    if (r.ok) { head = hex((r.json as { result?: unknown })?.result); if (head === null) pushAttempt(attempts, hostOf(urls[i]!), "bad_head"); else start = i; }
    else pushAttempt(attempts, hostOf(urls[i]!), `head:${r.reason}`);
  }
  if (head === null) return null;
  const from = head - BigInt(windowBlocks - 1);
  const out: Record<string, any>[] = [];
  const used = new Set<string>();
  for (let lo = from; lo <= head; lo += BigInt(LOG_CHUNK_BLOCKS)) {
    const hi = lo + BigInt(LOG_CHUNK_BLOCKS - 1) < head ? lo + BigInt(LOG_CHUNK_BLOCKS - 1) : head;
    let got = false;
    for (let k = 0; k < urls.length && !got; k++) {
      const i = (start + k) % urls.length;
      const r = await call(deps, b, urls[i]!, rpcBody("eth_getLogs", [{ ...filter, fromBlock: `0x${lo.toString(16)}`, toBlock: `0x${hi.toString(16)}` }]));
      const res = r.ok ? (r.json as { result?: unknown })?.result : null;
      if (r.ok && Array.isArray(res)) { out.push(...(res as Record<string, any>[])); used.add(hostOf(urls[i]!)); start = i; got = true; }
      else pushAttempt(attempts, hostOf(urls[i]!), `getLogs ${lo}-${hi}:${r.ok ? "bad_shape" : r.reason}`);
      if (!r.ok && (r.reason === "call_cap" || r.reason === "time_cap")) return null;
    }
    if (!got) return null;
  }
  return { logs: out, from: Number(from), to: Number(head), source: [...used].join("+") };
}

/** history_and_lookalike source read. Blockscout first, then chunked eth_getLogs. Failure records every source's reason. */
export async function readHistoryDetailed(payTo: string, deadline: number, deps: ReadDeps, windowBlocks = HISTORY_WINDOW_BLOCKS): Promise<HistoryRead> {
  const b = new Budget(deps, Math.min(deadline, deps.now() + HISTORY_BUDGET_MS));
  const attempts: SourceAttempt[] = [];
  if (!isEvmAddress(payTo)) return { ok: false, attempts: [{ source: "input", reason: "payTo_malformed" }] };
  const bs = await fromBlockscout(payTo, deps, b);
  if (bs.ok) return { ok: true, history: bs.history, attempts };
  pushAttempt(attempts, hostOf(BLOCKSCOUT_BASE), bs.reason);
  const w = await logsWindow({ address: USDC_BASE, topics: [TRANSFER_TOPIC, null, pad(payTo)] }, windowBlocks, deps, b, attempts);
  if (!w) return { ok: false, attempts };
  const rows = w.logs.map((l) => ({ from: `0x${String(l?.topics?.[1] ?? "").slice(-40)}`.toLowerCase(), value: hex(l?.data) ?? 0n, block: Number(hex(l?.blockNumber) ?? 0n) }));
  return { ok: true, history: { ...summarize(rows, w.from, w.to, w.source), window_kind: "blocks" }, attempts };
}

/** tx hash of our AuthorizationUsed(tester, nonce) event (recent 300 blocks), with provider fallback and reasons. */
export async function authorizationTxDetailed(tester: string, nonce: string, deadline: number, deps: ReadDeps, lookback = 300): Promise<{ tx: string | null; attempts: SourceAttempt[] }> {
  const b = new Budget(deps, Math.min(deadline, deps.now() + HISTORY_BUDGET_MS));
  const attempts: SourceAttempt[] = [];
  const w = await logsWindow({ address: USDC_BASE, topics: [AUTH_USED_TOPIC, pad(tester), nonce.toLowerCase()] }, lookback, deps, b, attempts);
  if (!w) return { tx: null, attempts };
  const tx = w.logs.map((l) => l?.transactionHash).find((h) => typeof h === "string") ?? null;
  if (!tx) pushAttempt(attempts, w.source, "no_matching_log");
  return { tx, attempts };
}
