/**
 * Dark routes (Michael via Odin 10:28 PM ET 10/17): web readiness checks,
 * package signals check, prompt-injection heuristics scan (Counsel wording 10/18). Built and deployable DARK:
 *   - each route is 404 on every verb unless its own flag is exactly "true";
 *   - not in the live catalog, /.well-known/x402, llms.txt, OpenAPI or
 *     related-routes; no Bazaar discovery extension (lib/route-metadata.ts
 *     holds a lookup entry only, like /api/batch, for the no-CDP 402);
 *   - going live and listing need Michael's own yes on the exact routes.
 * Money is integer atomic USDC (6 decimals) as decimal strings; USD labels are
 * derived from the atomic amount, never typed separately.
 * Copy is informational only: no "secure", "guaranteed" or "certified" claims;
 * every response carries Counsel's disclaimer (lib/dark-checks-shared.ts).
 */
import { randomUUID } from "node:crypto";
import type { RoutesConfig } from "@x402/core/server";
import { getNetworkCaip2, getPayTo } from "./config";
import { callerIp } from "./caller-ip";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------
export const DARK_FLAGS = {
  audit: "HP_AUDIT_SECURITY_ENABLED",
  pkg: "HP_PACKAGE_CHECK_ENABLED",
  injection: "HP_INJECTION_SCAN_ENABLED",
} as const;
export type DarkRoute = keyof typeof DARK_FLAGS;

export function darkEnabled(route: DarkRoute, env: Record<string, string | undefined> = process.env): boolean {
  return env[DARK_FLAGS[route]] === "true";
}

/**
 * Audit tiers full ($50), history ($75) and deep ($100) are HARD-DISABLED
 * (Odin 11:07 PM ET 10/17): 404 before any payment even when
 * HP_AUDIT_SECURITY_ENABLED=true, unless this SEPARATE flag is exactly "true".
 * Defaults off. Not advertised in the bad_tier list or OPTIONS while off.
 */
export const AUDIT_HIGH_TIERS_FLAG = "HP_AUDIT_HIGH_TIERS_ENABLED";
export const AUDIT_HIGH_TIER_IDS: readonly string[] = ["full", "history", "deep"];
export function auditTierEnabled(t: Pick<Tier, "id">, env: Record<string, string | undefined> = process.env): boolean {
  return !AUDIT_HIGH_TIER_IDS.includes(t.id) || auditHighTiersEnabled(env);
}

// ---------------------------------------------------------------------------
// Money (integer atomic units)
// ---------------------------------------------------------------------------
const ATOMIC_PER_USD = 1_000_000;

/** Integer atomic -> "$1", "$0.02", "$0.005" (no float drift: string math). */
export function usdFromAtomic(atomic: number): `$${string}` {
  if (!Number.isSafeInteger(atomic) || atomic <= 0) throw new Error(`bad atomic amount ${atomic}`);
  const whole = Math.floor(atomic / ATOMIC_PER_USD);
  const frac = String(atomic % ATOMIC_PER_USD).padStart(6, "0").replace(/0+$/, "");
  return `$${whole}${frac ? `.${frac}` : ""}`;
}

export type Tier = { id: string; atomic: number; usd: `$${string}`; atomicStr: string; label: string };
const tier = (id: string, atomic: number, label: string): Tier => ({ id, atomic, usd: usdFromAtomic(atomic), atomicStr: String(atomic), label });

/** Audit ladder = Michael's FINAL ladder $1/$5/$10/$20/$50/$75/$100 (Odin 10:58 AM ET 10/17). */
export const AUDIT_TIERS: readonly Tier[] = [
  tier("quick", 1_000_000, "Quick scan: HTTPS, TLS certificate and expiry, core HTTP response headers"),
  tier("standard", 5_000_000, "Adds negotiated TLS version, Permissions-Policy, cookie flags, security.txt, server version disclosure"),
  tier("extended", 10_000_000, "Adds DNS records, SPF, DMARC, DKIM selector hints, CAA, www/apex consistency"),
  tier("report", 20_000_000, "Extended checks plus a fix line per finding and a markdown report"),
  tier("full", 50_000_000, "Report plus home-page hints (mixed content, storage bucket hosts, third-party scripts without SRI)"),
  tier("history", 75_000_000, "Full plus certificate-transparency history for the host (365 days, via crt.sh)"),
  tier("deep", 100_000_000, "History plus suggested fixes for the findings above and config snippets"),
] as const;

/** Package signals check: base $0.02 and deep $0.10 (confirmed by Odin 10:47 PM ET 10/17). */
export const PACKAGE_TIERS: readonly Tier[] = [
  tier("base", 20_000, "Exists, age, downloads, maintainers count, license, typosquat distance, known-vulnerability count"),
  tier("deep", 100_000, "Base plus vulnerability details (ids, severity, fixed versions), install scripts, deprecation, release cadence, repository link"),
] as const;

/** Prompt-injection heuristics scan: base $0.01 (confirmed by Odin 10:47 PM ET 10/17). */
export const INJECTION_TIERS: readonly Tier[] = [tier("base", 10_000, "Rule-based prompt-injection pattern scan of supplied text or a public URL")] as const;

export function findTier(tiers: readonly Tier[], id: string | null | undefined, fallback: string): Tier | null {
  const want = (id ?? "").trim().toLowerCase() || fallback;
  return tiers.find((t) => t.id === want) ?? null;
}

// ---------------------------------------------------------------------------
// Descriptions (402 resource.description; <= 500 chars; facts only)
// ---------------------------------------------------------------------------
/**
 * Audit route copy follows HP_AUDIT_HIGH_TIERS_ENABLED (Odin 11:15 PM ET 10/17).
 * Flag ON: the full copy below (unchanged). Flag OFF: no full/history/deep tiers and
 * no certificate history. Counsel's sentence ("Automated checks, not a professional
 * audit or penetration test; informational only, no warranty.") is identical in both.
 */
export const AUDIT_DESCRIPTION_HIGH_TIERS =
  "Web readiness checks for one public host: HTTPS redirect, TLS certificate and expiry, HTTP response headers (HSTS, CSP, frame-embedding, nosniff, referrer), security.txt, DNS, SPF, DMARC and DKIM hints. tier=quick|standard|extended|report|full|history|deep; deeper tiers add checks, CT history and suggested fixes. Automated checks, not a professional audit or penetration test; informational only, no warranty. Callers need the right to check the target. Bad input or unreachable: not charged.";
export const AUDIT_DESCRIPTION_BASE =
  "Web readiness checks for one public host: HTTPS redirect, TLS certificate and expiry, HTTP response headers (HSTS, CSP, frame-embedding, nosniff, referrer), security.txt, DNS, SPF, DMARC and DKIM hints. tier=quick|standard|extended|report; deeper tiers add checks, a fix line per finding and a markdown report. Automated checks, not a professional audit or penetration test; informational only, no warranty. Callers need the right to check the target. Bad input or unreachable: not charged.";
export function auditHighTiersEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[AUDIT_HIGH_TIERS_FLAG] === "true";
}

/** DARK_DESCRIPTIONS["/api/audit/security"] is the flag-ON copy; use darkDescription() for what is served. */
export const DARK_DESCRIPTIONS = {
  "/api/audit/security":
    AUDIT_DESCRIPTION_HIGH_TIERS,
  "/api/package/check":
    "npm or PyPI package signals before install: exists, first publish age, weekly downloads, maintainer count, license, typosquat distance to popular names, known vulnerabilities from OSV.dev (attributed per record), deps.dev provenance, CISA KEV cross-check. GET ecosystem (npm|pypi), name, optional version, tier=base|deep (deep adds vulnerability details, install scripts, deprecation, release cadence). Informational only, no warranty. Bad input or registry down: not charged.",
  "/api/injection/scan":
    "Prompt-injection heuristics scan of supplied text (POST JSON {text} or GET text, max 50 KB) or a public URL (url; same SSRF guards as /api/fetch, raw HTML scanned incl. comments and hidden text). Returns a 0-100 risk score, level, and findings with rule, category, severity and a short excerpt. Heuristic patterns only; a low score is not a clearance. Informational only, no warranty. Bad input or fetch errors: not charged.",
} as const;

// ---------------------------------------------------------------------------
// x402 route configs (one per tier; payTo + network from the single source)
// ---------------------------------------------------------------------------
/**
 * Bare-path key: every verb is paid with this one accepts entry. No `extensions`
 * (no Bazaar discovery) and no serviceMetadata while dark.
 */
/** The description actually served for a dark route (audit copy follows HP_AUDIT_HIGH_TIERS_ENABLED). */
export function darkDescription(path: keyof typeof DARK_DESCRIPTIONS, env: Record<string, string | undefined> = process.env): string {
  if (path === "/api/audit/security") return auditHighTiersEnabled(env) ? AUDIT_DESCRIPTION_HIGH_TIERS : AUDIT_DESCRIPTION_BASE;
  return DARK_DESCRIPTIONS[path];
}

export function darkRouteConfig(path: keyof typeof DARK_DESCRIPTIONS, t: Tier): RoutesConfig {
  return {
    [path]: {
      accepts: [{ scheme: "exact", price: t.usd, network: getNetworkCaip2(), payTo: getPayTo() }],
      description: darkDescription(path),
      mimeType: "application/json",
    },
  };
}

export function darkPaymentOpts(path: keyof typeof DARK_DESCRIPTIONS, t: Tier) {
  return { maxAmountRequired: t.atomicStr, resource: path, description: darkDescription(path) } as const;
}

// ---------------------------------------------------------------------------
// Receipt / correlation id
// ---------------------------------------------------------------------------
export const RECEIPT_HEADER = "X-HP-Receipt-Id";
export function newReceiptId(): string {
  return `hpr_${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Rate limits. Per-IP: per instance, best effort, BEFORE payment (429 never charges).
// Per-target (web readiness checks): SHARED in Upstash, inside the paid handler
// before any outbound request (Counsel C2); see app/api/audit/security/handler.ts.
// ---------------------------------------------------------------------------
export const DARK_RATE_LIMITS: Record<DarkRoute, { perMinute: number }> = {
  audit: { perMinute: 6 },
  pkg: { perMinute: 60 },
  injection: { perMinute: 60 },
};
/** Per target host: at most this many checks per minute across ALL instances (shared Upstash counter). */
export const AUDIT_TARGET_PER_MINUTE = 3;

type Bucket = { windowStart: number; count: number };
const buckets = new Map<string, Bucket>();
const MAX_KEYS = 10_000;

/** Fixed 60 s window. Returns seconds to wait, or 0 when allowed (and counts the hit). */
export function rateLimitHit(key: string, perMinute: number, now: number = Date.now()): number {
  const b = buckets.get(key);
  if (!b || now - b.windowStart >= 60_000) {
    if (buckets.size >= MAX_KEYS) buckets.clear();
    buckets.set(key, { windowStart: now, count: 1 });
    return 0;
  }
  if (b.count >= perMinute) return Math.max(1, Math.ceil((b.windowStart + 60_000 - now) / 1000));
  b.count += 1;
  return 0;
}
export function resetRateLimitsForTests(): void {
  buckets.clear();
}

/** Per-IP rate-limit key from the shared caller-IP helper (lib/caller-ip.ts, Vercel ipAddress() source; Odin B-3). No usable IP -> one shared "unknown" bucket. */
export function clientKey(headers: Headers): string {
  return callerIp(headers) ?? "unknown";
}
