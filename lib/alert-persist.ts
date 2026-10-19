/**
 * Odin 9:09 AM AST 2026-10-19: best-effort persistence of rail alerts to our existing Upstash, so alert counts survive
 * past Vercel's live-only runtime log stream. console.error stays exactly as it was; this is an ADDITIONAL sink.
 *
 *   - Capped lists hp:alerts:xrpl / hp:alerts:solana: LPUSH then LTRIM 0..ALERT_LIST_CAP-1.
 *     Entry = { ts, code, severity, route, payer } where payer is TRUNCATED (first 6 + "…" + last 4) or null.
 *     No secrets, full addresses, payloads, tx blobs, hashes or reasons are written.
 *   - Daily counter hp:alerts:<rail>:count:YYYY-MM-DD (UTC day), INCR + EXPIRE ALERT_COUNT_TTL_S (~35 days).
 *   - Fire-and-forget: one pipeline request, ALERT_PERSIST_TIMEOUT_MS abort, every error swallowed. Never awaited by
 *     the payment path, never throws, never delays a response.
 *   - Credentials: the app's existing server env via resolveSharedReplayStoreEnv (the claim store's read-write creds).
 *     KV_REST_API_READ_ONLY_TOKEN is never read.
 *   - /status shows counts only (today, last 7 days), cached 300 s (cachedAlertSummary).
 *   - Preview isolation (Sentinel LOW-2): writes and /status reads only when VERCEL_ENV === "production" exactly;
 *     unset or any other value = off. Previews would otherwise resolve to the prod Upstash and pollute the prod lists.
 *   - Budget (Sentinel LOW-1): warn_rate alerts are never persisted (attacker-inflatable via unpaid junk), and each
 *     instance writes at most ALERT_WRITE_CAP_PER_DAY alerts per UTC day; past the cap only an in-memory count grows.
 *   - route is stored as a pathname only (query string / fragment stripped, Sentinel INFO-2 / Odin (c)).
 */
import { resolveSharedReplayStoreEnv } from "@/lib/xrpl-replay-store";

export type AlertRail = "xrpl" | "solana" | "premium";
export const ALERT_LIST_CAP = 500;
export const ALERT_COUNT_TTL_S = 35 * 86_400;
export const ALERT_PERSIST_TIMEOUT_MS = 500;
export const ALERT_STATUS_TIMEOUT_MS = 800;

type Env = Record<string, string | undefined>;
type FetchFn = typeof fetch;
export type PersistedAlert = { ts: string; code: string; severity: string; route: string | null; payer: string | null };

let fetchOverride: FetchFn | null = null;
let envOverride: Env | null = null;
/** Tests only. */
export function setAlertPersistForTests(o: { fetch?: FetchFn | null; env?: Env | null } | null): void {
  memo = null;
  stats = { day: "", written: 0, overCap: { xrpl: 0, solana: 0, premium: 0 }, skippedKind: 0 };
  fetchOverride = o?.fetch ?? null;
  envOverride = o?.env ?? null;
}
const inflight = new Set<Promise<void>>();
/** Tests only: wait for fire-and-forget writes. */
export async function flushAlertPersistForTests(): Promise<void> {
  await Promise.allSettled([...inflight]);
}

export const listKey = (rail: AlertRail) => `hp:alerts:${rail}`;
export const countKey = (rail: AlertRail, day: string) => `hp:alerts:${rail}:count:${day}`;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** First 6 + "…" + last 4; anything too short / not a string → null (never a full address). */
export function truncateAddress(a: unknown): string | null {
  if (typeof a !== "string") return null;
  const s = a.trim();
  if (s.length < 14) return null;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function creds(): { url: string; token: string } | null {
  try {
    // Under vitest the sink stays off unless a test opts in (keeps every existing fetch-counting test unchanged).
    if (!envOverride && process.env.VITEST) return null;
    const env = envOverride ?? (process.env as Env);
    // Sentinel LOW-2 (Odin 9:25 AM AST): fail closed. Writes AND reads only when VERCEL_ENV is exactly "production";
    // unset (local, scripts, a Vercel project with system env exposure off) or anything else means off.
    if (env.VERCEL_ENV !== "production") return null;
    const c = resolveSharedReplayStoreEnv(env);
    return c ? { url: c.url.replace(/\/+$/, ""), token: c.token } : null;
  } catch {
    return null;
  }
}

async function pipeline(c: { url: string; token: string }, cmds: (string | number)[][], timeoutMs: number): Promise<unknown[] | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await (fetchOverride ?? fetch)(`${c.url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
      body: JSON.stringify(cmds),
      signal: ctl.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: unknown; error?: string }[];
    return Array.isArray(j) ? j.map((x) => (x && !x.error ? x.result : null)) : null;
  } finally {
    clearTimeout(t);
  }
}

/** Pathname only: drop any query string and fragment (Odin 9:25 AM AST (c)). */
export function stripQuery(route: string): string {
  const i = route.search(/[?#]/);
  return (i === -1 ? route : route.slice(0, i)).trim();
}

/** Alert kinds never persisted (Sentinel LOW-1: warn_rate is driven by unpaid junk, so an attacker could inflate it). */
export const NEVER_PERSIST = new Set(["warn_rate"]);
/** Hard per-instance cap on alert writes per UTC day (both rails together). */
export const ALERT_WRITE_CAP_PER_DAY = 50;
/** Odin C5: premium alerts have their OWN per-instance daily cap, so a premium burst can never crowd out xrpl/solana. */
export const PREMIUM_ALERT_WRITE_CAP_PER_DAY = 50;
type WriteStats = { day: string; written: number; premiumWritten?: number; overCap: Record<AlertRail, number>; skippedKind: number };
let stats: WriteStats = { day: "", written: 0, overCap: { xrpl: 0, solana: 0, premium: 0 }, skippedKind: 0 };
function statsFor(day: string): WriteStats {
  if (stats.day !== day) stats = { day, written: 0, overCap: { xrpl: 0, solana: 0, premium: 0 }, skippedKind: 0 };
  return stats;
}
/** Tests / diagnostics: this instance's write counters for the current UTC day. */
export function alertWriteStats(): Readonly<WriteStats> {
  return { ...stats, overCap: { ...stats.overCap } };
}

/** Build the stored entry from a rail alert object. Only whitelisted, non-secret fields. */
export function alertEntry(alert: unknown, now: Date = new Date()): PersistedAlert {
  const a = (alert && typeof alert === "object" ? alert : {}) as Record<string, unknown>;
  const code = typeof a.kind === "string" ? a.kind.slice(0, 64) : "unknown";
  const severity = typeof a.severity === "string" ? a.severity.slice(0, 16) : "alert";
  const route = typeof a.route === "string" ? stripQuery(a.route).slice(0, 80) || null : null;
  return { ts: now.toISOString(), code, severity, route, payer: truncateAddress(a.payer) };
}

/** Fire-and-forget. Never throws, never returns a promise the caller must await. */
export function persistAlert(rail: AlertRail, alert: unknown, opts: { exemptFromCap?: boolean } = {}): void {
  try {
    const kind = alert && typeof alert === "object" ? (alert as { kind?: unknown }).kind : undefined;
    const c = creds();
    if (!c) return;
    const now = new Date();
    const day = utcDay(now);
    const st = statsFor(day);
    if (typeof kind === "string" && NEVER_PERSIST.has(kind)) {
      st.skippedKind++;
      return;
    }
    if (rail === "premium") {
      // Odin P3: charged_not_delivered / refund_owed alerts are never capped
      if (!opts.exemptFromCap && (st.premiumWritten ?? 0) >= PREMIUM_ALERT_WRITE_CAP_PER_DAY) {
        st.overCap.premium++;
        return;
      }
      st.premiumWritten = (st.premiumWritten ?? 0) + 1;
    } else {
      if (st.written >= ALERT_WRITE_CAP_PER_DAY) {
        st.overCap[rail]++; // in-memory only past the cap
        return;
      }
      st.written++;
    }
    const entry = alertEntry(alert, now);
    const ck = countKey(rail, day);
    const p = pipeline(
      c,
      [
        ["LPUSH", listKey(rail), JSON.stringify(entry)],
        ["LTRIM", listKey(rail), 0, ALERT_LIST_CAP - 1],
        ["INCR", ck],
        ["EXPIRE", ck, ALERT_COUNT_TTL_S],
      ],
      ALERT_PERSIST_TIMEOUT_MS,
    )
      .then(() => undefined)
      .catch(() => undefined);
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  } catch {
    /* an alert sink must never break a request */
  }
}

/** Public /status shape: counts only (Odin 9:16 AM AST CHANGES REQUIRED: no code, timestamp or route in public markup). */
export type RailAlertSummary = { today: number; last7d: number };
export type AlertSummary = { status: "ok" | "unavailable" | "not_applicable"; xrpl: RailAlertSummary | null; solana: RailAlertSummary | null };

/** Uncached server-side read: today + last 7 UTC days per rail (one MGET pipeline, 800 ms bound). Never throws. */
export async function readAlertSummary(now: Date = new Date()): Promise<AlertSummary> {
  try {
    const c = creds();
    if (!c) return { status: "not_applicable", xrpl: null, solana: null };
    const days = Array.from({ length: 7 }, (_, i) => utcDay(new Date(now.getTime() - i * 86_400_000)));
    const rails: AlertRail[] = ["xrpl", "solana"];
    const out = await pipeline(c, rails.map((r) => ["MGET", ...days.map((d) => countKey(r, d))]), ALERT_STATUS_TIMEOUT_MS);
    if (!out) return { status: "unavailable", xrpl: null, solana: null };
    const sum = (i: number): RailAlertSummary => {
      const counts = (Array.isArray(out[i]) ? (out[i] as unknown[]) : []).map((v) => Number(v ?? 0) || 0);
      return { today: counts[0] ?? 0, last7d: counts.reduce((a, b) => a + b, 0) };
    };
    return { status: "ok", xrpl: sum(0), solana: sum(1) };
  } catch {
    return { status: "unavailable", xrpl: null, solana: null };
  }
}

/**
 * /status read, cached so public traffic cannot burn the Upstash budget shared with the Solana claim store
 * (Odin 9:16 AM AST): at most one Upstash read per ALERT_STATUS_CACHE_S.
 *   - Next data cache (unstable_cache, revalidate 300 s, shared across instances on Vercel) when available;
 *   - wrapped in a per-instance memory cache with the same TTL + single-flight, which also covers environments where
 *     unstable_cache is unavailable (tests, scripts). A failed/unavailable result is cached too (bounded budget).
 * /status itself stays force-dynamic, so its other content and meta (live balance, replay-eval fields) are unchanged.
 * Never throws.
 */
export const ALERT_STATUS_CACHE_S = 300;
let memo: { at: number; p: Promise<AlertSummary> } | null = null;
let nextCacheRead: (() => Promise<AlertSummary>) | null | undefined;

async function viaNextCache(): Promise<AlertSummary> {
  if (nextCacheRead === undefined) {
    try {
      const { unstable_cache } = await import("next/cache");
      nextCacheRead = unstable_cache(() => readAlertSummary(), ["hp-alert-counts-v1"], { revalidate: ALERT_STATUS_CACHE_S });
    } catch {
      nextCacheRead = null;
    }
  }
  if (nextCacheRead) {
    try {
      return await nextCacheRead();
    } catch {
      /* outside a Next request context (no incremental cache): fall through to the direct read */
    }
  }
  return readAlertSummary();
}

export function cachedAlertSummary(nowMs: number = Date.now()): Promise<AlertSummary> {
  try {
    if (memo && nowMs - memo.at < ALERT_STATUS_CACHE_S * 1000) return memo.p;
    const p = viaNextCache().catch((): AlertSummary => ({ status: "unavailable", xrpl: null, solana: null }));
    memo = { at: nowMs, p };
    return p;
  } catch {
    return Promise.resolve({ status: "unavailable", xrpl: null, solana: null });
  }
}

/** Tests only. */
export function resetAlertSummaryCacheForTests(opts?: { disableNextCache?: boolean }): void {
  memo = null;
  nextCacheRead = opts?.disableNextCache ? null : undefined;
}
