/**
 * Demand signal (Odin/Michael 10/12): log market searches about OCR / document parsing
 * that found no good match, as a trigger for building or listing a doc/OCR route.
 * Log only (Vercel logs); q is redacted (emails, runs of 6+ digits incl. space/dash-separated) then truncated. Never affects billing or results.
 */
export const DOC_TOPIC_RE = /\b(ocr|pdf|docx?|document|documents|parse|parsing|parser|invoice|receipt|scan(?:ned)?|extract(?:ion)?)\b/i;
/** Below this, the best result is not a good match (rank.ts relevance is 0..1). */
export const GOOD_MATCH_RELEVANCE = 0.5;

const EMAIL_RE = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/g;
/** 6+ digits, also when split by single spaces, dots or dashes (card/phone/account numbers). */
const LONG_DIGITS_RE = /\d(?:[\s.-]?\d){5,}/g;
/** Odin Class A condition (10/12): redact emails and long digit runs from q before it is logged. */
export function redactQuery(q: string): string {
  return q.replace(EMAIL_RE, "[email]").replace(LONG_DIGITS_RE, "[digits]");
}

export type GapEvent = { evt: "market_search_gap"; topic: "ocr_doc"; q: string; reason: "no_results" | "weak_match"; topRelevance: number | null; returned: number };

export function docGapEvent(q: string | undefined, outcome: { ok: false; code: string } | { ok: true; results: { rank: { parts: Record<string, number> } }[] }): GapEvent | null {
  if (!q || !DOC_TOPIC_RE.test(q)) return null;
  const qq = redactQuery(q).slice(0, 120);
  if (!outcome.ok) return outcome.code === "no_results" ? { evt: "market_search_gap", topic: "ocr_doc", q: qq, reason: "no_results", topRelevance: null, returned: 0 } : null;
  const top = Math.max(0, ...outcome.results.map((r) => r.rank.parts.relevance ?? 0));
  return top < GOOD_MATCH_RELEVANCE ? { evt: "market_search_gap", topic: "ocr_doc", q: qq, reason: "weak_match", topRelevance: top, returned: outcome.results.length } : null;
}
