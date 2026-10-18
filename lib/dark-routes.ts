/**
 * Dark routes (Michael via Odin 10:28 PM ET 10/17): security & readiness audit,
 * package safety check, prompt-injection scan. Built and deployable DARK:
 *   - each route is 404 on every verb unless its own flag is exactly "true";
 *   - not in the live catalog, /.well-known/x402, llms.txt, OpenAPI or
 *     related-routes; no Bazaar discovery extension (lib/route-metadata.ts
 *     holds a lookup entry only, like /api/batch, for the no-CDP 402);
 *   - going live and listing need Michael's own yes on the exact routes.
 * Money is integer atomic USDC (6 decimals) as decimal strings; USD labels are
 * derived from the atomic amount, never typed separately.
 * Copy is informational only: no "secure", "guaranteed" or "certified" claims.
 */
import { randomUUID } from "node:crypto";
import type { RoutesConfig } from "@x402/core/server";
import { getNetworkCaip2, getPayTo } from "./config";

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
  tier("quick", 1_000_000, "Quick scan: HTTPS, TLS certificate and expiry, core security headers"),
  tier("standard", 5_000_000, "Adds CORS, cookie flags, exposed /.env and /.git, security.txt, server disclosure"),
  tier("extended", 10_000_000, "Adds DNS records, SPF, DMARC, DKIM selector hints, CAA, www/apex consistency"),
  tier("report", 20_000_000, "Extended checks plus a fix line per finding and a markdown report"),
  tier("full", 50_000_000, "Report plus certificate SAN hosts (up to 10) checked and page hints (mixed content, storage bucket hosts, third-party scripts)"),
  tier("history", 75_000_000, "Full plus certificate-transparency history (365 days) and up to 20 hosts checked"),
  tier("deep", 100_000_000, "History plus up to 30 hosts and a prioritized fix list with config snippets"),
] as const;

/** Package check: PROPOSED base $0.02 and deep $0.10 (Michael's yes needed on both). */
export const PACKAGE_TIERS: readonly Tier[] = [
  tier("base", 20_000, "Exists, age, downloads, maintainers count, license, typosquat distance, known-vulnerability count"),
  tier("deep", 100_000, "Base plus vulnerability details (ids, severity, fixed versions), install scripts, deprecation, release cadence, repository link"),
] as const;

/** Prompt-injection scan: PROPOSED base $0.01. */
export const INJECTION_TIERS: readonly Tier[] = [tier("base", 10_000, "Rule-based prompt-injection pattern scan of supplied text or a public URL")] as const;

export function findTier(tiers: readonly Tier[], id: string | null | undefined, fallback: string): Tier | null {
  const want = (id ?? "").trim().toLowerCase() || fallback;
  return tiers.find((t) => t.id === want) ?? null;
}

// ---------------------------------------------------------------------------
// Descriptions (402 resource.description; <= 500 chars; facts only)
// ---------------------------------------------------------------------------
export const DARK_DESCRIPTIONS = {
  "/api/audit/security":
    "Passive outside-in web readiness checks for one public host: HTTPS and TLS certificate expiry, security headers (HSTS, CSP, frame, nosniff, referrer), CORS, exposed /.env or /.git (single GET each), DNS, SPF, DMARC and DKIM hints. tier=quick|standard|extended|report|full|history|deep; deeper tiers add checks, history and fix lines. No exploits, no login attempts. Results are informational, not a certification. Bad input or target unreachable: not charged.",
  "/api/package/check":
    "npm or PyPI package check before install: exists, first publish age, weekly downloads, maintainer count, license, typosquat distance to popular names, known vulnerabilities from OSV.dev. GET ecosystem (npm|pypi), name, optional version, tier=base|deep (deep adds vulnerability details, install scripts, deprecation, release cadence). Results are informational. Bad input or registry down: not charged.",
  "/api/injection/scan":
    "Prompt-injection pattern scan of supplied text (POST JSON {text} or GET text, max 50 KB) or a public URL (url; same SSRF guards as /api/fetch, raw HTML scanned incl. comments and hidden text). Returns a 0-100 risk score, level, and findings with rule, category, severity and a short excerpt. Rule-based heuristics; a low score is not a clearance. Bad input or fetch errors: not charged.",
} as const;

// ---------------------------------------------------------------------------
// x402 route configs (one per tier; payTo + network from the single source)
// ---------------------------------------------------------------------------
/**
 * Bare-path key: every verb is paid with this one accepts entry. No `extensions`
 * (no Bazaar discovery) and no serviceMetadata while dark.
 */
export function darkRouteConfig(path: keyof typeof DARK_DESCRIPTIONS, t: Tier): RoutesConfig {
  return {
    [path]: {
      accepts: [{ scheme: "exact", price: t.usd, network: getNetworkCaip2(), payTo: getPayTo() }],
      description: DARK_DESCRIPTIONS[path],
      mimeType: "application/json",
    },
  };
}

export function darkPaymentOpts(path: keyof typeof DARK_DESCRIPTIONS, t: Tier) {
  return { maxAmountRequired: t.atomicStr, resource: path, description: DARK_DESCRIPTIONS[path] } as const;
}

// ---------------------------------------------------------------------------
// Receipt / correlation id
// ---------------------------------------------------------------------------
export const RECEIPT_HEADER = "X-HP-Receipt-Id";
export function newReceiptId(): string {
  return `hpr_${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Rate limits (per instance, best effort; applied BEFORE payment: 429 never charges)
// ---------------------------------------------------------------------------
export const DARK_RATE_LIMITS: Record<DarkRoute, { perMinute: number }> = {
  audit: { perMinute: 6 },
  pkg: { perMinute: 60 },
  injection: { perMinute: 60 },
};
/** Per target host: at most this many audits per minute from this instance (we must not hammer a site). */
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

export function clientKey(headers: Headers): string {
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || headers.get("x-real-ip")?.trim() || "unknown";
}
