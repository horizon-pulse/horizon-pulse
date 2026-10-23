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

export function nyfedTerms(body: unknown, now: Date = new Date(), links: string[] = []): NyfedTerms | null {
  const urls = [...new Set([...nyfedUrls(body), ...links.filter(isNyfedUrl)])];
  if (!urls.length) return null;
  return { credit: nyfedCredit(now.getUTCFullYear()), terms_url: NYFED_TERMS_URL, not_affiliated: NOT_AFFILIATED, free_at_source: NYFED_FREE_LINE, source_urls: urls };
}

/** Adds `nyfed_terms` to a brief body when it cites newyorkfed.org; otherwise returns the body unchanged. */
export function withNyfedTerms<T extends object>(body: T, now: Date = new Date(), links: string[] = []): T & { nyfed_terms?: NyfedTerms } {
  const t = nyfedTerms(body, now, links);
  return t ? { ...body, nyfed_terms: t } : body;
}

/**
 * Odin 10/23 6:13 PM ET + Counsel markets-routes: no raw NY Fed values in any paid body. NY Fed pages are LINKED, not
 * quoted for rates. Backstop: every newyorkfed.org excerpt sentence that carries a rate (percent, bp, or a rate number)
 * is removed from the evidence BEFORE claims/quotes/answer are built, so it cannot be quoted (quotes must be verbatim in
 * the page text) and cannot reach the AI answer line (its numbers must come from the claims).
 */
export const NYFED_RATE_RE =
  /\d\s*(%|percent\b|per cent\b|bps?\b|basis points?\b)|\b\d+(\.\d+)?\s*(-|to)\s*\d+(\.\d+)?\s*(%|percent\b)|\b\d+\.\d+\b|\b\d+\s*-?\s*\d?\/\d\b/i;
export const hasRate = (t: string) => NYFED_RATE_RE.test(t);
export const NYFED_WITHHELD = "NY Fed value not quoted; free at the linked page.";

/** Split excerpt text into sentence/line pieces (keeps the separators out; pieces are rejoined with newlines). */
const pieces = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

/** Remove rate-bearing sentences from newyorkfed.org pages; other pages untouched. */
export function scrubNyfedPages<T extends { url: string; excerpts: string[] }>(pages: T[]): T[] {
  return pages.map((p) => isNyfedUrl(p.url) ? { ...p, excerpts: p.excerpts.map((e) => pieces(e).filter((s) => !hasRate(s)).join("\n")).filter((e) => e.trim()) } : p);
}

/** Final backstop on a paid body: any string that contains a rate-bearing sentence from an original NY Fed page is withheld. */
export function withholdNyfedRates<T>(body: T, original: { url: string; excerpts: string[] }[]): T {
  const bad = original.filter((p) => isNyfedUrl(p.url)).flatMap((p) => p.excerpts.flatMap(pieces)).filter(hasRate)
    .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase()).filter((s) => s.length >= 12);
  if (!bad.length) return body;
  const hit = (s: string) => { const n = s.replace(/\s+/g, " ").trim().toLowerCase(); return hasRate(n) && bad.some((b) => n.includes(b) || (n.length >= 12 && b.includes(n))); };
  const walk = (v: any, d: number): any => {
    if (d > 14 || v === null || v === undefined) return v;
    if (typeof v === "string") return hit(v) ? NYFED_WITHHELD : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, d + 1));
    if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, d + 1)]));
    return v;
  };
  return walk(body, 0);
}

/** Policy-rate ordering: NY Fed pages go last among extract candidates (Board pages first). Stable otherwise. */
export function nyfedLast<T extends { url: string }>(xs: T[]): T[] {
  return [...xs.filter((x) => !isNyfedUrl(x.url)), ...xs.filter((x) => isNyfedUrl(x.url))];
}

export const BOARD_CITATION = "Board of Governors of the Federal Reserve System, federalreserve.gov (public domain U.S. government work).";
