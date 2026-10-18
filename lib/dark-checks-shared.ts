/**
 * Shared pieces for the three dark routes, per Counsel's PASS-with-conditions
 * (to-odin/2026-10-18-counsel-dark-audit-routes-review.md):
 *   C3  contact User-Agent + public checks page + honored opt-out list
 *   C5  disclaimer text (verbatim) for every response
 *   C2  shared per-target rate limit in the EXISTING Upstash database (same
 *       credentials the XRPL replay store and route log resolve; no new token)
 *   C6  shared 24 h cache (pypistats, crt.sh) and a streamed size cap
 */
import { CONTACT_EMAIL } from "./config";
import { resolveSharedReplayStoreEnv } from "./xrpl-replay-store";

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// C3: identification + opt-out
// ---------------------------------------------------------------------------
export const CHECKS_PAGE_PATH = "/web-checks";
export const CHECKS_PAGE_URL = `https://horizonpulse.dev${CHECKS_PAGE_PATH}`;
/** Sent on every request to a caller-named target (web readiness checks, injection-scan URL mode). */
export const CHECK_USER_AGENT = `HorizonPulseCheck/1.0 (+${CHECKS_PAGE_URL}; ${CONTACT_EMAIL})`;
/** Sent to fixed data sources (npm, PyPI, pypistats, OSV.dev, crt.sh). */
export const DATA_USER_AGENT = `HorizonPulse/1.0 (+${CHECKS_PAGE_URL}; ${CONTACT_EMAIL})`;

/**
 * Domains whose owners asked not to be checked (request by email to CONTACT_EMAIL,
 * as the checks page says). A listed domain also covers every subdomain. Extra
 * entries can be added without a code change in HP_WEB_CHECKS_OPTOUT (comma list).
 */
export const OPT_OUT_DOMAINS: readonly string[] = [];

export function optOutList(env: Env = process.env, base: readonly string[] = OPT_OUT_DOMAINS): string[] {
  const extra = (env.HP_WEB_CHECKS_OPTOUT ?? "").split(",");
  return [...new Set([...base, ...extra].map((d) => d.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "")).filter(Boolean))];
}

export function isOptedOut(host: string, list: readonly string[] = optOutList()): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

// ---------------------------------------------------------------------------
// C5: disclaimers (Counsel section 2, verbatim)
// ---------------------------------------------------------------------------
export const DISCLAIMER =
  "Automated, point-in-time checks of publicly observable information as of `asOf`. Informational only: not a security audit, penetration test, certification or compliance assessment, and not security, legal or professional advice. Checks are limited to what is listed in `method` and cannot see server-side or authenticated issues; a check marked pass or not detected does not mean the system is secure or free of vulnerabilities. Provided as is, without warranty of any kind. To the extent permitted by law, Horizon Pulse's total liability for any call is limited to the amount paid for that call. You must have the right to check the target you submit.";
export const PACKAGE_DISCLAIMER_ADDENDUM =
  "Signals come from npm/PyPI registry metadata and OSV.dev advisories, which may be incomplete or delayed; no known vulnerabilities does not mean none exist.";
export const INJECTION_DISCLAIMER_ADDENDUM =
  "Heuristic patterns only; attackers can evade them. Do not rely on this score to decide whether to execute instructions or move funds.";
/** Counsel C6 attribution lines. */
export const OSV_ATTRIBUTION =
  "Vulnerability data from OSV.dev, aggregated from sources including GitHub Advisory Database and PyPI Advisory Database (CC-BY 4.0); see each record for its source and licence.";
export const CRTSH_ATTRIBUTION = "Certificate-transparency data via crt.sh (Sectigo)";

// ---------------------------------------------------------------------------
// C2: shared fixed-window limiter (one Upstash EVAL per call)
// ---------------------------------------------------------------------------
export type LimitResult = { ok: true; retryAfter: number } | { ok: false; error: string };
/** retryAfter 0 = allowed (and counted). ok:false = store unavailable (callers fail CLOSED, not charged). */
export type SharedLimiter = (key: string, perMinute: number) => Promise<LimitResult>;

export const LIMIT_LUA = "local c=redis.call('INCR',KEYS[1]) if c==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end return c";
const STORE_TIMEOUT_MS = 1500;

async function upstash(env: Env, fetchFn: typeof fetch, cmd: (string | number)[]): Promise<unknown> {
  const c = resolveSharedReplayStoreEnv(env);
  if (!c) throw new Error("shared store not configured");
  const res = await fetchFn(c.url.replace(/\/+$/, ""), {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd.map(String)),
    signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`shared store answered ${res.status}`);
  const j = (await res.json()) as { result?: unknown; error?: string };
  if (j.error) throw new Error(`shared store error: ${String(j.error).slice(0, 80)}`);
  return j.result;
}

export function upstashLimiter(env: Env = process.env, fetchFn: typeof fetch = (...a) => fetch(...a), now: () => number = () => Date.now()): SharedLimiter {
  return async (key, perMinute) => {
    const t = now();
    const win = Math.floor(t / 60_000);
    try {
      const n = Number(await upstash(env, fetchFn, ["EVAL", LIMIT_LUA, 1, `hp:dk:rl:${key}:${win}`, 120]));
      if (!Number.isFinite(n)) return { ok: false, error: "shared store returned no count" };
      return { ok: true, retryAfter: n > perMinute ? Math.max(1, Math.ceil(((win + 1) * 60_000 - t) / 1000)) : 0 };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "shared store unreachable" };
    }
  };
}

// ---------------------------------------------------------------------------
// C6: shared cache (Upstash GET / SET EX, plus a per-instance layer). Never throws.
// ---------------------------------------------------------------------------
export type SharedCache = { get(key: string): Promise<string | null>; set(key: string, value: string, ttlSeconds: number): Promise<void> };
export const CACHE_VALUE_CAP = 256_000;

export function upstashCache(env: Env = process.env, fetchFn: typeof fetch = (...a) => fetch(...a), now: () => number = () => Date.now()): SharedCache {
  const mem = new Map<string, { v: string; exp: number }>();
  return {
    async get(key) {
      const m = mem.get(key);
      if (m && m.exp > now()) return m.v;
      try {
        const r = await upstash(env, fetchFn, ["GET", `hp:dk:c:${key}`]);
        return typeof r === "string" ? r : null;
      } catch {
        return null;
      }
    },
    async set(key, value, ttlSeconds) {
      if (value.length > CACHE_VALUE_CAP) return;
      if (mem.size > 1000) mem.clear();
      mem.set(key, { v: value, exp: now() + ttlSeconds * 1000 });
      try {
        await upstash(env, fetchFn, ["SET", `hp:dk:c:${key}`, value, "EX", ttlSeconds]);
      } catch {
        /* cache is best effort */
      }
    },
  };
}

export function memoryCache(now: () => number = () => Date.now()): SharedCache {
  const mem = new Map<string, { v: string; exp: number }>();
  return {
    async get(key) {
      const m = mem.get(key);
      return m && m.exp > now() ? m.v : null;
    },
    async set(key, value, ttlSeconds) {
      mem.set(key, { v: value, exp: now() + ttlSeconds * 1000 });
    },
  };
}

// ---------------------------------------------------------------------------
// Streamed size cap (Sentinel LOW: never buffer past the cap)
// ---------------------------------------------------------------------------
export class BodyTooLargeError extends Error {
  constructor(public readonly cap: number) {
    super(`response larger than ${cap} bytes`);
  }
}

/** Reads the body as text, aborting the stream as soon as `cap` bytes are exceeded. */
export async function readTextCapped(res: Response, cap: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > cap) {
    await res.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(cap);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(cap);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
