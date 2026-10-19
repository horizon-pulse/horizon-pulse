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
import { createHash } from "node:crypto";
import { persistAlert } from "@/lib/alert-persist";
import { resolveSharedReplayStoreEnv } from "@/lib/xrpl-replay-store";
import { RECONCILE_RETENTION_S } from "./copy";

export type ReconcileOutcome = "settle_timeout" | "settle_ambiguous" | "authorization_already_used";
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
};

type Env = Record<string, string | undefined>;
let sinkOverride: ((line: ReconcileLine) => void) | null = null;
let fetchOverride: typeof fetch | null = null;
let envOverride: Env | null = null;
const inflight = new Set<Promise<unknown>>();

/** Tests only. */
export function setReconcileForTests(o: { sink?: ((l: ReconcileLine) => void) | null; fetch?: typeof fetch | null; env?: Env | null } | null) {
  sinkOverride = o?.sink ?? null;
  fetchOverride = o?.fetch ?? null;
  envOverride = o?.env ?? null;
}
export async function flushReconcileForTests() {
  await Promise.allSettled([...inflight]);
}

export function requestFingerprint(method: string, url: URL): string {
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
  const full: ReconcileLine = { ...line, ts: new Date().toISOString() };
  try {
    console.error(`[premium][RECONCILE] ${JSON.stringify(full)}`);
    console.error(
      `[premium][ALERT][HIGH] ${JSON.stringify({ kind: `premium_${full.outcome}`, severity: "high", route: full.route, tier: full.tier, reconcile_id: full.reconcile_id })}`,
    );
    persistAlert("premium", { kind: `premium_${full.outcome}`, severity: "high", route: full.route, payer: full.payer });
    sinkOverride?.(full);
    const c = creds();
    if (c) {
      const key = `hp:premium:reconcile:${full.ts.slice(0, 7)}`;
      const p = (fetchOverride ?? fetch)(`${c.url}/pipeline`, {
        method: "POST",
        headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
        body: JSON.stringify([
          ["RPUSH", key, JSON.stringify(full)],
          ["EXPIRE", key, RECONCILE_RETENTION_S],
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
