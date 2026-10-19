/**
 * Premium reconcile line + HIGH alert (spec §4).
 *
 * Every settle timeout (504), ambiguous settle (502) and used-nonce retry (409) writes ONE append-only reconcile line
 * and raises ONE HIGH alert. The line holds what the manual refund runbook (docs/premium-refund-runbook.md) needs:
 * route, tier, payer, nonce, amount, payTo, tx hash if known, request fingerprint, timestamp, outcome.
 * No signature, no raw payload, no query text (the fingerprint is a sha256 of method + path + sorted query).
 *
 * Sinks:
 *   - console.error "[premium][RECONCILE]" and "[premium][ALERT][HIGH]" lines (always; Vercel runtime log).
 *   - Upstash (same read-write claim-store creds as lib/alert-persist.ts, never KV_REST_API_READ_ONLY_TOKEN):
 *     RPUSH hp:premium:reconcile:YYYY-MM + EXPIRE RECONCILE_RETENTION_S (<= 12 months, matches privacy text);
 *     the HIGH alert also goes through persistAlert("premium", …) (today's alert-persistence path).
 *     Production only (VERCEL_ENV === "production"), fire-and-forget, never throws.
 */
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { persistAlert, truncateAddress } from "@/lib/alert-persist";
import { resolveSharedReplayStoreEnv } from "@/lib/xrpl-replay-store";
import { RECONCILE_RETENTION_S } from "./copy";

export type ReconcileOutcome = "settle_timeout" | "settle_ambiguous" | "authorization_already_used" | "charged_not_delivered" | "refund_owed" | "redeem_mismatch" | "failed_charged";
export type ReconcileLine = {
  reconcile_id: string;
  ts: string;
  route: string;
  tier: string;
  payer: string | null;
  nonce: string | null;
  amount: string | null;
  payTo: string | null;
  tx: string | null;
  fingerprint: string;
  outcome: ReconcileOutcome;
  job_id?: string | null;
  refund_owed?: string | null;
};

/** Per-instance daily cap on reconcile writes (Sentinel MEDIUM-1); past it only console + an in-memory count. */
export const RECONCILE_WRITE_CAP_PER_DAY = 50;
/** Odin P3: money-owed records are never dropped by the daily cap (their volume is bounded by P2 + the open-job caps). */
export const CAP_EXEMPT_OUTCOMES: ReadonlySet<ReconcileOutcome> = new Set(["charged_not_delivered", "refund_owed", "failed_charged"]);
let capDay = "";
let capWritten = 0;
let capDropped = 0;
export function reconcileWriteStats() {
  return { day: capDay, written: capWritten, dropped: capDropped };
}

/**
 * Counsel C2 note: keyed one-way hash of the request fingerprint for the stored line (HKDF of the existing
 * HP_FREE_IP_HMAC_KEY, info "premium-reconcile-fingerprint"). Without that key the plain request fingerprint is kept.
 */
export function storedFingerprint(rq: string, env: Record<string, string | undefined> = process.env): string {
  const raw = env.HP_FREE_IP_HMAC_KEY ?? "";
  if (raw.length < 43) return rq;
  const k = Buffer.from(hkdfSync("sha256", raw, "horizon-pulse/premium/v1", "premium-reconcile-fingerprint", 32));
  return `k1:${createHmac("sha256", k).update(rq).digest("hex")}`;
}

type Env = Record<string, string | undefined>;
let sinkOverride: ((line: ReconcileLine) => void) | null = null;
let fetchOverride: typeof fetch | null = null;
let envOverride: Env | null = null;
const inflight = new Set<Promise<unknown>>();

/** Tests only. */
export function setReconcileForTests(o: { sink?: ((l: ReconcileLine) => void) | null; fetch?: typeof fetch | null; env?: Env | null } | null) {
  sinkOverride = o?.sink ?? null;
  capDay = "";
  capWritten = 0;
  capDropped = 0;
  fetchOverride = o?.fetch ?? null;
  envOverride = o?.env ?? null;
}
export async function flushReconcileForTests() {
  await Promise.allSettled([...inflight]);
}

/** Legacy URL-only fingerprint (kept for callers without a Request); premium now uses lib/request-fingerprint.ts. */
export function urlFingerprint(method: string, url: URL): string {
  const q = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(`${method.toUpperCase()} ${url.pathname}?${new URLSearchParams(q).toString()}`).digest("hex");
}

export function newReconcileId(): string {
  return `rc_${createHash("sha256").update(`${Date.now()}:${Math.random()}:${process.hrtime.bigint()}`).digest("hex").slice(0, 24)}`;
}

function creds(): { url: string; token: string } | null {
  try {
    if (!envOverride && process.env.VITEST) return null;
    const env = envOverride ?? (process.env as Env);
    if (env.VERCEL_ENV !== "production") return null;
    const c = resolveSharedReplayStoreEnv(env);
    return c ? { url: c.url.replace(/\/+$/, ""), token: c.token } : null;
  } catch {
    return null;
  }
}

/** Write the reconcile line and raise the HIGH alert. Never throws, never awaited by the response path. */
export function recordReconcile(line: Omit<ReconcileLine, "ts">): ReconcileLine {
  const full: ReconcileLine = { ...line, fingerprint: storedFingerprint(line.fingerprint, envOverride ?? process.env), ts: new Date().toISOString() };
  try {
    // Sentinel INFO-3: payer truncated in log lines (full payer only in the stored payment record).
    console.error(`[premium][RECONCILE] ${JSON.stringify({ ...full, payer: truncateAddress(full.payer) })}`);
    console.error(
      `[premium][ALERT][HIGH] ${JSON.stringify({ kind: `premium_${full.outcome}`, severity: "high", route: full.route, tier: full.tier, reconcile_id: full.reconcile_id })}`,
    );
    persistAlert("premium", { kind: `premium_${full.outcome}`, severity: "high", route: full.route, payer: full.payer }, { exemptFromCap: CAP_EXEMPT_OUTCOMES.has(full.outcome) });
    sinkOverride?.(full);
    const day = full.ts.slice(0, 10);
    if (capDay !== day) [capDay, capWritten, capDropped] = [day, 0, 0];
    const c = creds();
    const exempt = CAP_EXEMPT_OUTCOMES.has(full.outcome);
    if (c && !exempt && capWritten >= RECONCILE_WRITE_CAP_PER_DAY) capDropped++;
    else if (c) {
      capWritten++;
      const key = `hp:premium:reconcile:${full.ts.slice(0, 7)}`;
      const p = (fetchOverride ?? fetch)(`${c.url}/pipeline`, {
        method: "POST",
        headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
        body: JSON.stringify([
          ["RPUSH", key, JSON.stringify(full)],
          // Counsel C2: expiry set on the FIRST write of the monthly key only (NX), so no line outlives 12 months.
          ["EXPIRE", key, RECONCILE_RETENTION_S, "NX"],
        ]),
        signal: AbortSignal.timeout(1500),
        cache: "no-store",
      }).catch(() => undefined);
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    }
  } catch {
    /* never break the response */
  }
  return full;
}
