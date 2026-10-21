/**
 * Sentinel L-5: on-chain watch on the dd-tester wallet (Base). Run by /api/seller-dd/cron (does nothing while the flag is off).
 * HIGH alert on:
 *   - any outbound USDC Transfer from the tester whose tx has no AuthorizationUsed(tester, nonce) for a nonce WE reserved
 *   - any USDC Approval with owner = tester (approve/permit both emit Approval)
 *   - any inbound USDC Transfer to the tester from an address not in HP_DD_FUNDING_ALLOWLIST (full strings, from
 *     approved-addresses.md; unset = every inbound transfer alerts)
 *   - the tester's account nonce > 0 (it must never send its own transaction; it only signs EIP-3009 authorizations)
 *   - the HP_DD_TESTPAY kill switch value changed since the last run
 *   - LOW-2: cumulative inbound USDC > $25 (lifetime funding cap) or balance > $10 (float)
 * Scans from a stored block cursor in WATCH_MAX_BLOCKS chunks until head (W1), saving the cursor after each chunk; an RPC failure leaves the cursor unchanged (retry next run)
 * and reports `rpc_unavailable` (an alert itself, so a blind watch is never silent).
 */
import { USDC_BASE } from "@/lib/config";
import { defaultRpcDeps, hexToBig, rpcs, type RpcDeps } from "@/lib/chain-rpc";
import type { PremiumStore } from "@/lib/premium/store";
import { ddKeys } from "./caps";
import { DD_WATCH_START_BLOCK } from "./config";
import { isEvmAddress } from "./screen";
import { observeKillSwitch, setPause } from "./pause";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
export const AUTH_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const WATCH_MAX_BLOCKS = 9_000;
/** W1: per-run bounds (maxDuration 60 s). 12 chunks = 108k blocks (~2.5 days of Base) per run; a day is ~43.2k. */
export const WATCH_MAX_CHUNKS = 12;
export const WATCH_TIME_BUDGET_MS = 40_000;
/** LOW-2 (Sentinel): the approved-addresses row's limits, enforced by alert: lifetime inbound funding and float. */
export const FUNDING_CAP_USD = 25;
export const FLOAT_CAP_USD = 10;
const BALANCE_OF = "0x70a08231";
const CURSOR_TTL_S = 400 * 86_400;
const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const addrOf = (topic: unknown) => (typeof topic === "string" ? `0x${topic.slice(-40)}`.toLowerCase() : "");

export type WatchAlert = { kind: string; severity: "high"; tx?: string; block?: number; detail?: string };
export type WatchResult = { ok: boolean; from_block: number | null; to_block: number | null; alerts: WatchAlert[] };
export type Rpc = (method: string, params: unknown) => Promise<unknown>;

export function defaultWatchRpc(deps: RpcDeps = defaultRpcDeps()): Rpc {
  const url = rpcs("base")[0]!;
  return async (method, params) => {
    const res = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const j = (await res.json()) as { result?: unknown; error?: unknown };
    if (j.error || !("result" in j)) throw new Error("rpc_error");
    return j.result;
  };
}

export const watchKeys = { cursor: () => "dd:watch:cursor", killSwitch: () => "dd:watch:testpay", inboundUsd: () => "dd:watch:inbound_usd" };

export async function runWatch(store: PremiumStore, tester: string, rpc: Rpc, env: Record<string, string | undefined> = process.env, now: () => number = () => Date.now(), startBlock: bigint = BigInt(DD_WATCH_START_BLOCK)): Promise<WatchResult> {
  const alerts: WatchAlert[] = [];
  // kill-switch flip (independent of RPC)
  const ks = env.HP_DD_TESTPAY === "on" ? "on" : "off";
  const prevKs = await store.get(watchKeys.killSwitch()).catch(() => null);
  if (prevKs !== null && prevKs !== ks) alerts.push({ kind: "seller_dd_kill_switch_flipped", severity: "high", detail: `${prevKs}->${ks}` });
  await store.set(watchKeys.killSwitch(), ks, CURSOR_TTL_S).catch(() => undefined);
  // Odin 10/21 #5: kill-switch cycle (off, then on) clears an auto-pause latch. Runs before this scan, so a NEW trigger
  // found below re-arms the latch in the same run.
  const ksObs = await observeKillSwitch(store, ks).catch(() => "none" as const);
  if (ksObs === "cleared") alerts.push({ kind: "seller_dd_auto_pause_cleared", severity: "high", detail: "kill switch cycled off->on" });
  const pause = async (cause: "outflow_not_ours" | "tester_nonce_above_zero", detail: string) => {
    const ok = await setPause(store, cause, now(), detail);
    alerts.push({ kind: ok ? "seller_dd_auto_paused" : "seller_dd_auto_pause_write_failed", severity: "high", detail: `${cause}: ${detail}` });
  };

  const allow = new Set((env.HP_DD_FUNDING_ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(isEvmAddress));
  let firstFrom: bigint | null = null, lastTo: bigint | null = null;
  try {
    const head = hexToBig(await rpc("eth_blockNumber", []));
    if (head === null) throw new Error("head");
    const cur = await store.get(watchKeys.cursor());
    let from = cur && /^\d+$/.test(cur) ? BigInt(cur) + 1n : startBlock <= head ? startBlock : head - BigInt(WATCH_MAX_BLOCKS) + 1n;
    if (from < head - BigInt(WATCH_MAX_BLOCKS) * BigInt(WATCH_MAX_CHUNKS)) alerts.push({ kind: "seller_dd_watch_gap", severity: "high", detail: `cursor ${cur} more than ${WATCH_MAX_CHUNKS} chunks behind head` });
    const t = pad(tester);
    const deadline = now() + WATCH_TIME_BUDGET_MS;
    // W1 (Odin): scan in WATCH_MAX_BLOCKS chunks until head, saving the cursor after EACH chunk; alert if the run ends behind.
    for (let chunk = 0; from <= head && chunk < WATCH_MAX_CHUNKS && now() < deadline; chunk++) {
      const to = from + BigInt(WATCH_MAX_BLOCKS) - 1n < head ? from + BigInt(WATCH_MAX_BLOCKS) - 1n : head;
      const range = { address: USDC_BASE, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
      const [outLogs, inLogs, apprLogs, authLogs] = await Promise.all([
        rpc("eth_getLogs", [{ ...range, topics: [TRANSFER_TOPIC, t] }]),
        rpc("eth_getLogs", [{ ...range, topics: [TRANSFER_TOPIC, null, t] }]),
        rpc("eth_getLogs", [{ ...range, topics: [APPROVAL_TOPIC, t] }]),
        rpc("eth_getLogs", [{ ...range, topics: [AUTH_USED_TOPIC, t] }]),
      ]);
      if (![outLogs, inLogs, apprLogs, authLogs].every(Array.isArray)) throw new Error("logs");
      const authByTx = new Map<string, string[]>();
      for (const l of authLogs as any[]) { const a = authByTx.get(l.transactionHash) ?? []; a.push(String(l.topics?.[2] ?? "")); authByTx.set(l.transactionHash, a); }
      for (const l of outLogs as any[]) {
        let matched = false;
        for (const n of authByTx.get(l.transactionHash) ?? []) if (await store.get(ddKeys.nonce(n)).catch(() => null)) matched = true;
        if (!matched) {
          alerts.push({ kind: "seller_dd_outbound_without_reservation", severity: "high", tx: l.transactionHash, block: Number(hexToBig(l.blockNumber) ?? 0n) });
          await pause("outflow_not_ours", `tx ${String(l.transactionHash).slice(0, 66)}`);
        }
      }
      for (const l of apprLogs as any[]) alerts.push({ kind: "seller_dd_approval_event", severity: "high", tx: l.transactionHash, block: Number(hexToBig(l.blockNumber) ?? 0n) });
      // LOW-2: total ALL inbound USDC (allowlisted or not) into a lifetime counter
      let inAtomic = 0n;
      for (const l of inLogs as any[]) inAtomic += hexToBig(l.data) ?? 0n;
      if (inAtomic > 0n) await store.spendAdjust(watchKeys.inboundUsd(), Number(inAtomic) / 1e6, CURSOR_TTL_S);
      for (const l of inLogs as any[]) if (!allow.has(addrOf(l.topics?.[1]))) alerts.push({ kind: "seller_dd_inbound_from_unapproved", severity: "high", tx: l.transactionHash, block: Number(hexToBig(l.blockNumber) ?? 0n) });
      await store.set(watchKeys.cursor(), to.toString(), CURSOR_TTL_S);
      firstFrom ??= from;
      lastTo = to;
      from = to + 1n;
    }
    if (from <= head) alerts.push({ kind: "seller_dd_watch_behind", severity: "high", detail: `${(head - from + 1n).toString()} blocks behind head after this run` });
    const inbound = Number((await store.get(watchKeys.inboundUsd())) ?? 0);
    if (!Number.isFinite(inbound) || inbound > FUNDING_CAP_USD) alerts.push({ kind: "seller_dd_funding_over_cap", severity: "high", detail: `cumulative inbound ${inbound} USDC > ${FUNDING_CAP_USD}` });
    const bal = hexToBig(await rpc("eth_call", [{ to: USDC_BASE, data: BALANCE_OF + tester.toLowerCase().replace(/^0x/, "").padStart(64, "0") }, "latest"]));
    if (bal === null || bal > BigInt(FLOAT_CAP_USD * 1_000_000)) alerts.push({ kind: "seller_dd_balance_over_float", severity: "high", detail: `balance ${bal === null ? "unreadable" : (Number(bal) / 1e6).toString()} USDC > ${FLOAT_CAP_USD}` });
    const n = hexToBig(await rpc("eth_getTransactionCount", [tester, "latest"]));
    if (n === null || n > 0n) alerts.push({ kind: "seller_dd_tester_sent_own_tx", severity: "high", detail: `account nonce ${n === null ? "unreadable" : n.toString()}` });
    // pause only on a READ nonce above 0 (unreadable alerts above; the per-pay pre-flight refuses on unreadable anyway)
    if (n !== null && n > 0n) await pause("tester_nonce_above_zero", `account nonce ${n.toString()}`);
    // inflows (any source, any size), funding over cap and balance over float never pause: alerts only
    return { ok: true, from_block: firstFrom === null ? null : Number(firstFrom), to_block: lastTo === null ? null : Number(lastTo), alerts };
  } catch {
    alerts.push({ kind: "seller_dd_watch_rpc_unavailable", severity: "high" });
    return { ok: false, from_block: firstFrom === null ? null : Number(firstFrom), to_block: lastTo === null ? null : Number(lastTo), alerts };
  }
}
