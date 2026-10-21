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
import { vendorFetch } from "@/lib/no-brotli"; // TEMP no-br; remove once node_patched is yes

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// C3: identification + opt-out
// ---------------------------------------------------------------------------
export const CHECKS_PAGE_PATH = "/web-checks";
export const CHECKS_PAGE_URL = `https://horizonpulse.dev${CHECKS_PAGE_PATH}`;
/** Sent on every request to a caller-named target (web readiness checks, injection-scan URL mode). */
export const CHECK_USER_AGENT = `HorizonPulseCheck/1.0 (+${CHECKS_PAGE_URL}; ${CONTACT_EMAIL})`;
/** Sent to fixed data sources (npm, PyPI, pypistats, OSV.dev, deps.dev, the CISA KEV feed, crt.sh). */
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

/**
 * What is requested from the submitted host, Counsel's wording VERBATIM (10/18 rulings;
 * filed as 03-exchange/to-counsel/2026-10-18-pulse-redirect-copy.md). Used by the
 * audit method text (both tiers) and the /web-checks page. Matches the code:
 * audit-security.ts maxRedirects 5 (home) and 2 (security.txt), every hop re-checked
 * against the opt-out list and the network guard (guardedGet) before it is requested.
 */
export const REDIRECT_COPY =
  "The GET of https://host/ follows the site's own redirects (up to 5), and the security.txt GET follows up to 2; each redirect target is checked against the opt-out list and our network guard before it is requested, and opted-out hosts are never requested. Apart from those redirects, nothing else is requested: no other paths, hosts or subdomains, no port scans, no login attempts, no exploit payloads.";

/**
 * Opt-out lookup for ONE exact domain (Counsel FAIL on the published list; Odin 10/18):
 * the /web-checks page shows only a count, and GET /web-checks/opt-out?domain= answers
 * yes/no for the one domain asked about. No list, no wildcard or prefix search, no
 * partial matches, no logging of the query. "yes" means checks of exactly that domain
 * are refused (it is listed, or a listed parent domain covers it).
 * Rate limited twice: per caller IP in memory on this instance (the IP is never stored
 * or sent anywhere), and a global per-minute budget in the shared Upstash limiter
 * (key carries no caller data; 20/min per Counsel re-read batch 2, so the list cannot be
 * bulk-tested). The shared limiter failing or over budget = refuse
 * (fail closed): 503/429, never an answer.
 */
export const OPT_OUT_CHECK_PER_IP_PER_MIN = 10;
export const OPT_OUT_CHECK_GLOBAL_PER_MIN = 20;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export function normalizeOptOutQuery(raw: string | null): string | null {
  const d = (raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  return HOSTNAME.test(d) ? d : null;
}
export function optOutCount(env: Env = process.env): number {
  return optOutList(env).length;
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

export function upstashLimiter(env: Env = process.env, fetchFn: typeof fetch = (...a) => vendorFetch(a[0] as string, a[1]), now: () => number = () => Date.now()): SharedLimiter {
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

export function upstashCache(env: Env = process.env, fetchFn: typeof fetch = (...a) => vendorFetch(a[0] as string, a[1]), now: () => number = () => Date.now()): SharedCache {
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
