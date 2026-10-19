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
 *   - Preview isolation: writes (and /status reads) only when VERCEL_ENV is unset (local/tests) or "production".
 *     Previews would otherwise resolve to the prod Upstash and pollute the prod lists.
 */
import { resolveSharedReplayStoreEnv } from "@/lib/xrpl-replay-store";

export type AlertRail = "xrpl" | "solana";
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
    const ve = (env.VERCEL_ENV ?? "").trim();
    if (ve && ve !== "production") return null;
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

/** Build the stored entry from a rail alert object. Only whitelisted, non-secret fields. */
export function alertEntry(alert: unknown, now: Date = new Date()): PersistedAlert {
  const a = (alert && typeof alert === "object" ? alert : {}) as Record<string, unknown>;
  const code = typeof a.kind === "string" ? a.kind.slice(0, 64) : "unknown";
  const severity = typeof a.severity === "string" ? a.severity.slice(0, 16) : "alert";
  const route = typeof a.route === "string" ? a.route.slice(0, 80) : null;
  return { ts: now.toISOString(), code, severity, route, payer: truncateAddress(a.payer) };
}

/** Fire-and-forget. Never throws, never returns a promise the caller must await. */
export function persistAlert(rail: AlertRail, alert: unknown): void {
  try {
    const c = creds();
    if (!c) return;
    const now = new Date();
    const entry = alertEntry(alert, now);
    const ck = countKey(rail, utcDay(now));
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

export type RailAlertSummary = { today: number; last7d: number; lastAt: string | null; lastCode: string | null };
export type AlertSummary = { status: "ok" | "unavailable" | "not_applicable"; xrpl: RailAlertSummary | null; solana: RailAlertSummary | null };

/** Server-side read for /status: counts (today + last 7 UTC days) and newest entry per rail. Never throws. */
export async function readAlertSummary(now: Date = new Date()): Promise<AlertSummary> {
  const c = creds();
  if (!c) return { status: "not_applicable", xrpl: null, solana: null };
  const days = Array.from({ length: 7 }, (_, i) => utcDay(new Date(now.getTime() - i * 86_400_000)));
  const rails: AlertRail[] = ["xrpl", "solana"];
  const cmds: (string | number)[][] = [];
  for (const r of rails) {
    cmds.push(["MGET", ...days.map((d) => countKey(r, d))]);
    cmds.push(["LINDEX", listKey(r), 0]);
  }
  try {
    const out = await pipeline(c, cmds, ALERT_STATUS_TIMEOUT_MS);
    if (!out) return { status: "unavailable", xrpl: null, solana: null };
    const sum = (i: number): RailAlertSummary => {
      const counts = (Array.isArray(out[i * 2]) ? (out[i * 2] as unknown[]) : []).map((v) => Number(v ?? 0) || 0);
      let last: Partial<PersistedAlert> = {};
      try {
        if (typeof out[i * 2 + 1] === "string") last = JSON.parse(out[i * 2 + 1] as string);
      } catch {
        /* ignore */
      }
      return {
        today: counts[0] ?? 0,
        last7d: counts.reduce((a, b) => a + b, 0),
        lastAt: typeof last.ts === "string" ? last.ts : null,
        lastCode: typeof last.code === "string" ? last.code : null,
      };
    };
    return { status: "ok", xrpl: sum(0), solana: sum(1) };
  } catch {
    return { status: "unavailable", xrpl: null, solana: null };
  }
}
