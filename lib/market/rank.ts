/**
 * Marketplace ranking. Deterministic and documented; NOT pay-to-rank.
 *
 * The score is computed ONLY from the inputs in RankInput: text relevance to
 * the query, the index's own result order, the live re-check outcome, how
 * recently the index saw a paid call, and how many distinct payers it saw in
 * 30 days (log-scaled, small weight). There is no input for payment to us,
 * featured/sponsored status, or seller identity, so no seller can buy rank,
 * and Horizon Pulse's own routes get no boost (tests/market-rank.test.ts).
 */

export const RANK_WEIGHTS = { relevance: 0.45, live: 0.25, recency: 0.15, adoption: 0.15 } as const;
export const RECENCY_WINDOW_DAYS = 30;

export type LiveStatus = "verified_402" | "failed" | "unverified";

export type RankInput = {
  query: string;
  title: string | null;
  description: string | null;
  tags: string[];
  url: string;
  /** 0-based position in the index's own result list (null for entries not from the index). */
  indexPosition: number | null;
  indexCount: number;
  live: LiveStatus;
  lastCalledAt: string | null;
  uniquePayers30d: number | null;
  now: number;
};

const STOP = new Set(["the", "and", "for", "with", "api", "a", "an", "of", "to", "in", "on", "by", "or", "x402", "get"]);

export function tokens(s: string): string[] {
  return [...new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t)))].slice(0, 12);
}

/** 0..1: share of query tokens found, title/tags/path hits weighted above description hits, plus the index's own order. */
export function relevance(i: Pick<RankInput, "query" | "title" | "description" | "tags" | "url" | "indexPosition" | "indexCount">): number {
  const q = tokens(i.query);
  let path = "";
  try {
    const u = new URL(i.url);
    path = `${u.hostname} ${u.pathname}`;
  } catch {
    path = i.url;
  }
  const strong = ` ${tokens(`${i.title ?? ""} ${i.tags.join(" ")} ${path}`).join(" ")} `;
  const weak = ` ${tokens(i.description ?? "").join(" ")} `;
  let text = 0;
  if (q.length) {
    for (const t of q) text += strong.includes(` ${t} `) || strong.includes(t) ? 1 : weak.includes(` ${t} `) || weak.includes(t) ? 0.6 : 0;
    text /= q.length;
  }
  const order = i.indexPosition === null || i.indexCount <= 0 ? 0 : 1 - i.indexPosition / Math.max(i.indexCount, 1);
  return round(0.75 * text + 0.25 * order);
}

export function recency(lastCalledAt: string | null, now: number): number {
  if (!lastCalledAt) return 0;
  const t = Date.parse(lastCalledAt);
  if (!Number.isFinite(t)) return 0;
  const days = Math.max(0, (now - t) / 86_400_000);
  return round(Math.max(0, 1 - days / RECENCY_WINDOW_DAYS));
}

export function adoption(uniquePayers30d: number | null): number {
  if (!uniquePayers30d || uniquePayers30d < 0 || !Number.isFinite(uniquePayers30d)) return 0;
  return round(Math.min(1, Math.log10(1 + uniquePayers30d) / 2)); // 99 distinct payers → 1.0
}

export function liveValue(s: LiveStatus): number {
  return s === "verified_402" ? 1 : s === "unverified" ? 0.5 : 0;
}

/** Health score 0..1 shown to buyers (live re-check + index recency). */
export function healthScore(live: LiveStatus, lastCalledAt: string | null, now: number): number {
  return round(0.6 * liveValue(live) + 0.4 * recency(lastCalledAt, now));
}

export function rankScore(i: RankInput): { score: number; parts: { relevance: number; live: number; recency: number; adoption: number } } {
  // Only the named fields are read; anything else on the object is ignored by construction.
  const parts = {
    relevance: relevance(i),
    live: liveValue(i.live),
    recency: recency(i.lastCalledAt, i.now),
    adoption: adoption(i.uniquePayers30d),
  };
  const score =
    RANK_WEIGHTS.relevance * parts.relevance + RANK_WEIGHTS.live * parts.live + RANK_WEIGHTS.recency * parts.recency + RANK_WEIGHTS.adoption * parts.adoption;
  return { score: round(score), parts };
}

/** Stable sort: score desc, then index position asc, then URL (deterministic ties). */
export function compareRanked(a: { score: number; indexPosition: number | null; url: string }, b: { score: number; indexPosition: number | null; url: string }): number {
  if (b.score !== a.score) return b.score - a.score;
  const pa = a.indexPosition ?? Number.MAX_SAFE_INTEGER;
  const pb = b.indexPosition ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
