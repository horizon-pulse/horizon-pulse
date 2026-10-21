/**
 * Seller DD auto-pause (Odin 10/21 #5, Claude's version) + per-pay pre-flight.
 *
 * PAUSE (store latch dd:autopause, kill switch effectively ON, HIGH alert) on:
 *   - a tester-wallet USDC outflow WE did not make (no AuthorizationUsed for a nonce we reserved), or
 *   - the tester's account nonce above 0 (it only signs EIP-3009 authorizations; it must never send its own tx).
 * NEVER on inflows: inbound transfers (approved or not), funding over cap and balance over float only ALERT.
 *
 * PRE-FLIGHT before each test pay: tester USDC balance >= the amount needed AND account nonce == 0, read on two
 * distinct operators (min balance / max nonce). Otherwise no_charge with no spend (no reservation, no signature).
 * A nonce > 0 seen at pre-flight also sets the pause latch.
 *
 * RECOVERY needs no new env, key or approval from Michael: cycle the existing kill switch. Set HP_DD_TESTPAY to
 * anything other than "on" (route refuses), let one seller-dd cron run or one paid request see it (marks the latch
 * "seen_off"), then set HP_DD_TESTPAY=on: the next cron run / paid request clears the latch (HIGH alert
 * seller_dd_auto_pause_cleared). A latch that was never seen with the switch off is never cleared.
 * Store unreadable -> treated as paused (fail closed).
 */
import { USDC_BASE } from "@/lib/config";
import { defaultRpcDeps, rpcs, type RpcDeps } from "@/lib/chain-rpc";
import { distinctOperators } from "@/lib/premium/onchain";
import type { PremiumStore } from "@/lib/premium/store";

export const PAUSE_KEY = "dd:autopause";
const PAUSE_TTL_S = 400 * 86_400;
export type PauseCause = "outflow_not_ours" | "tester_nonce_above_zero";
export type PauseLatch = { cause: PauseCause; at: number; detail?: string; seen_off?: boolean };

/**
 * Sentinel LOW-1: if the pause-marker WRITE fails, this instance latches itself paused in memory (same rule as the
 * settle-fail B2 latch) and refuses every test pay (no_charge) until it is recycled (a redeploy, e.g. the kill-switch
 * cycle). Other instances still see the HIGH alert seller_dd_auto_pause_write_failed.
 */
let memLatch: PauseLatch | null = null;
export function resetPauseLatchForTests() { memLatch = null; }
export function pauseMemLatched(): boolean { return memLatch !== null; }

export async function readPause(store: PremiumStore): Promise<{ paused: boolean; latch: PauseLatch | null; readable: boolean }> {
  if (memLatch) return { paused: true, latch: memLatch, readable: true };
  try {
    const raw = await store.get(PAUSE_KEY);
    if (!raw) return { paused: false, latch: null, readable: true };
    try { return { paused: true, latch: JSON.parse(raw) as PauseLatch, readable: true }; } catch { return { paused: true, latch: null, readable: true }; }
  } catch {
    return { paused: true, latch: null, readable: false };
  }
}

/** Set (or re-arm) the latch. A new trigger always re-arms: seen_off goes back to false, so a fresh cycle is needed. */
export async function setPause(store: PremiumStore, cause: PauseCause, now: number, detail?: string): Promise<boolean> {
  const latch: PauseLatch = { cause, at: now, ...(detail ? { detail: detail.slice(0, 120) } : {}), seen_off: false };
  try { await store.set(PAUSE_KEY, JSON.stringify(latch), PAUSE_TTL_S); return true; } catch { memLatch = latch; return false; }
}

/**
 * Kill-switch cycle. ks = current HP_DD_TESTPAY state. Returns "cleared" when the latch had been seen with the switch
 * off and the switch is now on.
 */
export async function observeKillSwitch(store: PremiumStore, ks: "on" | "off"): Promise<"none" | "marked_off" | "cleared" | "still_paused"> {
  const p = await readPause(store);
  if (!p.readable || !p.paused) return "none";
  const latch = p.latch ?? ({ cause: "outflow_not_ours", at: 0 } as PauseLatch);
  if (ks === "off") {
    if (latch.seen_off) return "marked_off";
    try { await store.set(PAUSE_KEY, JSON.stringify({ ...latch, seen_off: true }), PAUSE_TTL_S); return "marked_off"; } catch { return "still_paused"; }
  }
  if (!latch.seen_off) return "still_paused";
  try { await store.del(PAUSE_KEY); return "cleared"; } catch { return "still_paused"; }
}

export type Preflight = { ok: true; balance_atomic: string; nonce: number } | { ok: false; code: "preflight_balance_low" | "preflight_nonce_nonzero" | "preflight_unavailable" };
export type PreflightFn = (tester: string, neededAtomic: bigint, deadline: number) => Promise<Preflight>;

const BALANCE_OF = "0x70a08231";
async function post(deps: RpcDeps, url: string, method: string, params: unknown, deadline: number): Promise<unknown> {
  const res = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(Math.max(1, Math.min(3_000, deadline - deps.now()))) });
  if (!res.ok) throw new Error("http");
  const j = (await res.json()) as { result?: unknown; error?: unknown };
  if (j.error || typeof j.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(j.result)) throw new Error("rpc");
  return BigInt(j.result === "0x" ? "0x0" : j.result);
}

/** Two distinct operators must both answer; conservative merge (lowest balance, highest nonce). */
export function defaultPreflight(deps: RpcDeps = defaultRpcDeps()): PreflightFn {
  return async (tester, needed, deadline) => {
    const urls = distinctOperators(rpcs("base")).slice(0, 3);
    const got: { bal: bigint; nonce: bigint }[] = [];
    for (const url of urls) {
      if (got.length >= 2) break;
      try {
        const bal = (await post(deps, url, "eth_call", [{ to: USDC_BASE, data: BALANCE_OF + tester.toLowerCase().replace(/^0x/, "").padStart(64, "0") }, "latest"], deadline)) as bigint;
        const nonce = (await post(deps, url, "eth_getTransactionCount", [tester, "latest"], deadline)) as bigint;
        got.push({ bal, nonce });
      } catch { /* next operator */ }
    }
    if (got.length < 2) return { ok: false, code: "preflight_unavailable" };
    return judgePreflight(got, needed);
  };
}
export function judgePreflight(answers: { bal: bigint; nonce: bigint }[], needed: bigint): Preflight {
  if (!answers.length) return { ok: false, code: "preflight_unavailable" };
  const bal = answers.reduce((m, a) => (a.bal < m ? a.bal : m), answers[0]!.bal);
  const nonce = answers.reduce((m, a) => (a.nonce > m ? a.nonce : m), answers[0]!.nonce);
  if (nonce !== 0n) return { ok: false, code: "preflight_nonce_nonzero" };
  if (needed <= 0n || bal < needed) return { ok: false, code: "preflight_balance_low" };
  return { ok: true, balance_atomic: bal.toString(), nonce: 0 };
}
