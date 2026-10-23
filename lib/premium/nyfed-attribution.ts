/**
 * NY Fed Terms of Use attribution for the $1 brief (Counsel 2026-10-23, to-pulse/2026-10-23-counsel-nyfed-tou-routes.md;
 * Odin 10/23 6:05 PM ET). When any cited page in a brief body is on newyorkfed.org (or a subdomain), the body carries
 * the ToU credit line, the not-affiliated line and the free-at-source line. Source URLs are never removed.
 * The brief has no derived NY Fed fields today (quotes are verbatim); NYFED_DERIVED_LABEL is for any future derived field.
 */
import { NOT_AFFILIATED } from "@/lib/money-market-rates";

export const NYFED_TERMS_URL = "https://www.newyorkfed.org/privacy/termsofuse";
export const nyfedCredit = (year: number) =>
  `© ${year} Federal Reserve Bank of New York. Content from the New York Fed subject to the Terms of Use at newyorkfed.org.`;
export const NYFED_FREE_LINE = "free at the linked page; the fee is for our analysis";
export const NYFED_DERIVED_LABEL = "Derived by Horizon Pulse from NY Fed data; not the NY Fed's; modified";

export function isNyfedUrl(u: unknown): boolean {
  if (typeof u !== "string") return false;
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/\.$/, "");
    return h === "newyorkfed.org" || h.endsWith(".newyorkfed.org");
  } catch {
    return false;
  }
}

/** All distinct newyorkfed.org URLs found anywhere in a body (string fields named url/source_url, or bare URL strings). */
export function nyfedUrls(body: unknown): string[] {
  const out = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || v === null || v === undefined) return;
    if (typeof v === "string") { if (isNyfedUrl(v)) out.add(v); return; }
    if (typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(body, 0);
  return [...out];
}

export type NyfedTerms = { credit: string; terms_url: string; not_affiliated: string; free_at_source: string; source_urls: string[] };

export function nyfedTerms(body: unknown, now: Date = new Date()): NyfedTerms | null {
  const urls = nyfedUrls(body);
  if (!urls.length) return null;
  return { credit: nyfedCredit(now.getUTCFullYear()), terms_url: NYFED_TERMS_URL, not_affiliated: NOT_AFFILIATED, free_at_source: NYFED_FREE_LINE, source_urls: urls };
}

/** Adds `nyfed_terms` to a brief body when it cites newyorkfed.org; otherwise returns the body unchanged. */
export function withNyfedTerms<T extends object>(body: T, now: Date = new Date()): T & { nyfed_terms?: NyfedTerms } {
  const t = nyfedTerms(body, now);
  return t ? { ...body, nyfed_terms: t } : body;
}
