/**
 * Per-route request log (Class A; Michael yes 10/16 9:56 PM ET, plan
 * oversight/team-room/03-exchange/to-odin/2026-10-16-pulse-route-log-proposal.md).
 *
 * One record per request that reaches createX402GetHandler (all 27 paid
 * routes): ts, route, method, outcome, rail, amount, tx, payer. Nothing else:
 * no IP, no headers, no query string, no body, no payment payload or
 * signature, no keys. tx and payer come from the settle (PAYMENT-RESPONSE)
 * header and are already public on-chain.
 *
 * Sink: the existing free Upstash database (same credentials the XRPL replay
 * store resolves; no new account, no paid plan). ONE billed command per
 * request: a single EVAL whose Lua body does
 *   HINCRBY hp:rl:d:<ET date> "<route>|<method>|<outcome>" 1   (daily counters)
 *   LPUSH/LTRIM hp:rl:r:<ET date> <record>  (capped at RECORDS_PER_DAY_CAP = 5,000)
 *   SET hp:rl:tx:<tx> <record> EX 30d       (paid_settled only: tx -> route)
 * Counters keep a 90-day TTL; raw records and tx keys (which carry payer) 30 days. Upstash bills EVAL once regardless of
 * the redis.call()s inside it (free plan: 500K commands/month).
 *
 * Fire-and-forget: logRouteRequest() never throws, never awaits on the
 * request path, and is scheduled with next/server after() so the response is
 * returned first (outside a request scope it falls back to a detached
 * promise). Upstash errors/timeouts are swallowed (one warn per instance).
 * A logging failure can never block, delay or fail a request.
 *
 * Quota guard (shared DB with the XRPL replay store, which fails CLOSED if
 * Upstash refuses commands): unpaid/err records stop after
 * HP_ROUTE_LOG_DAILY_CAP per instance per ET day (default 3000);
 * paid_settled is always logged. HP_ROUTE_LOG=off disables the sink entirely.
 */
import { after } from "next/server";
import { resolveSharedReplayStoreEnv } from "./xrpl-replay-store";

export type RouteOutcome = "402_unpaid" | "402_rejected" | "paid_settled" | "free_200" | "error";

export type RouteLogRecord = {
  ts: string;
  route: string;
  method: string;
  outcome: RouteOutcome;
  rail: string | null;
  amount: string | null;
  tx: string | null;
  payer: string | null;
};

/** Daily per-route counters (no payer): 90 days. */
export const ROUTE_LOG_COUNTER_TTL_S = 90 * 24 * 3600;
/** Raw records and hp:rl:tx keys (carry payer): 30 days (Odin C1, 10/17). */
export const ROUTE_LOG_RECORD_TTL_S = 30 * 24 * 3600;
export const RECORDS_PER_DAY_CAP = 5_000;
export const DEFAULT_DAILY_CAP = 3000;
export const ROUTE_LOG_TIMEOUT_MS = 1500;

/** Lua: KEYS[1]=counter hash, KEYS[2]=record list, KEYS[3]=tx key (paid_settled only; numkeys 2 otherwise); ARGV[1]=field, ARGV[2]=record, ARGV[3]=counter ttl, ARGV[4]=list cap-1, ARGV[5]=record ttl */
export const ROUTE_LOG_LUA = [
  "redis.call('HINCRBY', KEYS[1], ARGV[1], 1)",
  "redis.call('EXPIRE', KEYS[1], ARGV[3])",
  "redis.call('LPUSH', KEYS[2], ARGV[2])",
  "redis.call('LTRIM', KEYS[2], 0, ARGV[4])",
  "redis.call('EXPIRE', KEYS[2], ARGV[5])",
  "if KEYS[3] then redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[5]) end",
  "return 1",
].join("\n");

function settleHeader(res: Response): string | null {
  return res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
}

/** tx, network and payer from the settle header (base64 JSON); {} when absent or unreadable. */
export function settleFields(res: Response): { tx?: string; network?: string; payer?: string } {
  const h = settleHeader(res);
  if (!h) return {};
  try {
    const j = JSON.parse(Buffer.from(h, "base64").toString("utf8")) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 256 ? v : undefined);
    return { tx: str(j.transaction), network: str(j.network), payer: str(j.payer) };
  } catch {
    return {};
  }
}

export function classifyOutcome(status: number, paidHeader: boolean, settled: boolean): RouteOutcome {
  if (status === 402) return paidHeader ? "402_rejected" : "402_unpaid";
  if (status >= 200 && status < 300) return settled ? "paid_settled" : "free_200";
  return "error";
}

/** America/New_York calendar date (the team reports in ET). */
export function etDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function buildRouteLogRecord(opts: {
  route: string;
  method: string;
  res: Response;
  paidHeader: boolean;
  amountAtomic: string;
  now?: Date;
}): RouteLogRecord {
  const s = settleFields(opts.res);
  const outcome = classifyOutcome(opts.res.status, opts.paidHeader, Boolean(settleHeader(opts.res)));
  const paid = outcome === "paid_settled";
  return {
    ts: (opts.now ?? new Date()).toISOString(),
    route: opts.route,
    method: opts.method,
    outcome,
    rail: paid ? (s.network ?? "unknown") : null,
    amount: paid ? opts.amountAtomic : null,
    tx: paid ? (s.tx ?? null) : null,
    payer: paid ? (s.payer ?? null) : null,
  };
}

type Env = Record<string, string | undefined>;
type FetchFn = typeof fetch;

/** EVAL args for one record (exported for tests). */
export function evalCommand(rec: RouteLogRecord): string[] {
  const day = etDate(new Date(rec.ts));
  const keys = [`hp:rl:d:${day}`, `hp:rl:r:${day}`];
  if (rec.outcome === "paid_settled" && rec.tx) keys.push(`hp:rl:tx:${rec.tx.toLowerCase()}`);
  return [
    "EVAL",
    ROUTE_LOG_LUA,
    String(keys.length),
    ...keys,
    `${rec.route}|${rec.method}|${rec.outcome}`,
    JSON.stringify(rec),
    String(ROUTE_LOG_COUNTER_TTL_S),
    String(RECORDS_PER_DAY_CAP - 1),
    String(ROUTE_LOG_RECORD_TTL_S),
  ];
}

const capState = { day: "", n: 0 };
let warned = false;

/** Test hook. */
export function resetRouteLogState(): void {
  capState.day = "";
  capState.n = 0;
  warned = false;
}

function underCap(rec: RouteLogRecord, env: Env): boolean {
  if (rec.outcome === "paid_settled") return true;
  const day = etDate(new Date(rec.ts));
  if (capState.day !== day) {
    capState.day = day;
    capState.n = 0;
  }
  const raw = Number((env.HP_ROUTE_LOG_DAILY_CAP ?? "").trim());
  const cap = Number.isFinite(raw) && raw >= 0 && (env.HP_ROUTE_LOG_DAILY_CAP ?? "").trim() !== "" ? raw : DEFAULT_DAILY_CAP;
  if (capState.n >= cap) return false;
  capState.n++;
  return true;
}

/** Send one record. Resolves (never rejects) to true when Upstash accepted it. */
export async function sendRouteLog(rec: RouteLogRecord, env: Env = process.env, fetchFn: FetchFn = fetch): Promise<boolean> {
  try {
    if ((env.HP_ROUTE_LOG ?? "").trim().toLowerCase() === "off") return false;
    const c = resolveSharedReplayStoreEnv(env);
    if (!c) return false;
    if (!underCap(rec, env)) return false;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ROUTE_LOG_TIMEOUT_MS);
    try {
      const res = await fetchFn(c.url.replace(/\/+$/, ""), {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(evalCommand(rec)),
        signal: ctl.signal,
        cache: "no-store",
      });
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok || !body || body.error !== undefined) throw new Error(`upstash ${res.status}`);
      return true;
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn(`[route-log] write failed (ignored, request unaffected): ${e instanceof Error ? e.message : "error"}`);
    }
    return false;
  }
}

/**
 * Fire-and-forget entry point used by createX402GetHandler. Never throws and
 * never delays the response.
 */
export function logRouteRequest(opts: {
  route: string;
  method: string;
  res: Response;
  paidHeader: boolean;
  amountAtomic: string;
}): void {
  try {
    // Unit tests drive sendRouteLog() directly with their own env/fetch; the
    // wired path stays silent under vitest so no suite ever reaches a real
    // Upstash (or a shared global fetch stub) unless it opts in.
    if (process.env.VITEST && process.env.HP_ROUTE_LOG_IN_TESTS !== "true") return;
    const rec = buildRouteLogRecord(opts);
    const task = () => sendRouteLog(rec).then(() => undefined);
    try {
      after(task);
    } catch {
      void task();
    }
  } catch {
    /* never affect the request */
  }
}
