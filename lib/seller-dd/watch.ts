/**
 * Sentinel L-5: on-chain watch on the dd-tester wallet (Base). Run by /api/seller-dd/cron (does nothing while the flag is off).
 * HIGH alert on:
 *   - any outbound USDC Transfer from the tester whose tx has no AuthorizationUsed(tester, nonce) for a nonce WE reserved
 *   - any USDC Approval with owner = tester (approve/permit both emit Approval)
 *   - any inbound USDC Transfer to the tester from an address not in HP_DD_FUNDING_ALLOWLIST (full strings, from
 *     approved-addresses.md; unset = every inbound transfer alerts)
 *   - the tester's account nonce > 0 (it must never send its own transaction; it only signs EIP-3009 authorizations)
 *   - the HP_DD_TESTPAY kill switch value changed since the last run
 * Scans from a stored block cursor (max WATCH_MAX_BLOCKS per run); an RPC failure leaves the cursor unchanged (retry next run)
 * and reports `rpc_unavailable` (an alert itself, so a blind watch is never silent).
 */
import { USDC_BASE } from "@/lib/config";
import { defaultRpcDeps, hexToBig, rpcs, type RpcDeps } from "@/lib/chain-rpc";
import type { PremiumStore } from "@/lib/premium/store";
import { ddKeys } from "./caps";
import { isEvmAddress } from "./screen";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
export const AUTH_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const WATCH_MAX_BLOCKS = 9_000;
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

export const watchKeys = { cursor: () => "dd:watch:cursor", killSwitch: () => "dd:watch:testpay" };

export async function runWatch(store: PremiumStore, tester: string, rpc: Rpc, env: Record<string, string | undefined> = process.env): Promise<WatchResult> {
  const alerts: WatchAlert[] = [];
  // kill-switch flip (independent of RPC)
  const ks = env.HP_DD_TESTPAY === "on" ? "on" : "off";
  const prevKs = await store.get(watchKeys.killSwitch()).catch(() => null);
  if (prevKs !== null && prevKs !== ks) alerts.push({ kind: "seller_dd_kill_switch_flipped", severity: "high", detail: `${prevKs}->${ks}` });
  await store.set(watchKeys.killSwitch(), ks, CURSOR_TTL_S).catch(() => undefined);

  const allow = new Set((env.HP_DD_FUNDING_ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(isEvmAddress));
  let from: bigint, to: bigint;
  try {
    const head = hexToBig(await rpc("eth_blockNumber", []));
    if (head === null) throw new Error("head");
    const cur = await store.get(watchKeys.cursor());
    from = cur && /^\d+$/.test(cur) ? BigInt(cur) + 1n : head - BigInt(WATCH_MAX_BLOCKS) + 1n;
    if (from < head - BigInt(WATCH_MAX_BLOCKS) * 10n) { alerts.push({ kind: "seller_dd_watch_gap", severity: "high", detail: `cursor ${cur} far behind head` }); }
    to = from + BigInt(WATCH_MAX_BLOCKS) - 1n < head ? from + BigInt(WATCH_MAX_BLOCKS) - 1n : head;
    if (to < from) return { ok: true, from_block: Number(from), to_block: Number(to), alerts };
    const range = { address: USDC_BASE, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
    const t = pad(tester);
    const [outLogs, inLogs, apprLogs, authLogs, txCount] = await Promise.all([
      rpc("eth_getLogs", [{ ...range, topics: [TRANSFER_TOPIC, t] }]),
      rpc("eth_getLogs", [{ ...range, topics: [TRANSFER_TOPIC, null, t] }]),
      rpc("eth_getLogs", [{ ...range, topics: [APPROVAL_TOPIC, t] }]),
      rpc("eth_getLogs", [{ ...range, topics: [AUTH_USED_TOPIC, t] }]),
      rpc("eth_getTransactionCount", [tester, "latest"]),
    ]);
    if (![outLogs, inLogs, apprLogs, authLogs].every(Array.isArray)) throw new Error("logs");
    const authByTx = new Map<string, string[]>();
    for (const l of authLogs as any[]) { const a = authByTx.get(l.transactionHash) ?? []; a.push(String(l.topics?.[2] ?? "")); authByTx.set(l.transactionHash, a); }
    for (const l of outLogs as any[]) {
      const nonces = authByTx.get(l.transactionHash) ?? [];
      let matched = false;
      for (const n of nonces) if (await store.get(ddKeys.nonce(n)).catch(() => null)) matched = true;
      if (!matched) alerts.push({ kind: "seller_dd_outbound_without_reservation", severity: "high", tx: l.transactionHash, block: Number(hexToBig(l.blockNumber) ?? 0n) });
    }
    for (const l of apprLogs as any[]) alerts.push({ kind: "seller_dd_approval_event", severity: "high", tx: l.transactionHash, block: Number(hexToBig(l.blockNumber) ?? 0n) });
    for (const l of inLogs as any[]) {
      if (!allow.has(addrOf(l.topics?.[1]))) alerts.push({ kind: "seller_dd_inbound_from_unapproved", severity: "high", tx: l.transactionHash, block: Number(hexToBig(l.blockNumber) ?? 0n) });
    }
    const n = hexToBig(txCount);
    if (n === null || n > 0n) alerts.push({ kind: "seller_dd_tester_sent_own_tx", severity: "high", detail: `account nonce ${n === null ? "unreadable" : n.toString()}` });
    await store.set(watchKeys.cursor(), to.toString(), CURSOR_TTL_S);
    return { ok: true, from_block: Number(from), to_block: Number(to), alerts };
  } catch {
    alerts.push({ kind: "seller_dd_watch_rpc_unavailable", severity: "high" });
    return { ok: false, from_block: null, to_block: null, alerts };
  }
}
