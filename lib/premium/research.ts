/**
 * R1 sync tiers (brief $1, standard $5, extended $10): extractive output only (spec §1).
 * Quoted snippets (<= ~50 words, <= 5 per source), source URLs, dates, a claim -> source table. We add no prose of
 * our own; Parallel output is itself AI/ML-generated, so public copy never says "no AI".
 * Heuristics are labelled as such in the output; nothing here is a verdict.
 */
import { parallelExtract, parallelSearch, type ParallelResult } from "./parallel";
import type { Tier } from "./tiers";

export const SNIPPET_MAX_WORDS = 50;
export const SNIPPETS_PER_SOURCE = 5;

export function capWords(s: string, n = SNIPPET_MAX_WORDS): string {
  const w = s.replace(/\s+/g, " ").trim().split(" ");
  return w.length <= n ? w.join(" ") : `${w.slice(0, n).join(" ")} …`;
}

export function domainOf(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function sentences(text: string): string[] {
  return text
    .replace(/Section Title:[^\n]*\n?|Content:\n?|\.\.\. \(content truncated\)/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 6);
}

const STOP = new Set("the a an and or of to in on for with by is are was were be as at that this it from has have had not".split(" "));
function terms(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9$%. ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
}
const numbers = (s: string) => (s.match(/\$?\d[\d,.]*%?/g) ?? []).map((n) => n.replace(/[,.]$/, ""));

export function subQuestionList(q: string): string[] {
  const parts = q.split(/[?;\n]+/).map((s) => s.trim()).filter((s) => s.length >= 3);
  return parts.length ? parts.slice(0, 8) : [q];
}

const DATE_RE = /\b(?:19|20)\d{2}-\d{2}-\d{2}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? (?:19|20)\d{2}\b/g;

export type Snippet = { id: string; source: number; text: string };
export type Source = { n: number; url: string; domain: string; title: string | null; date: string | null; pdf: boolean; label?: "primary_heuristic" | "secondary_heuristic" };

export function compile(x: Tier, q: string, results: ParallelResult[]) {
  const byUrl = new Map<string, ParallelResult>();
  for (const r of results) {
    const key = r.url.replace(/#.*$/, "").replace(/\/$/, "");
    const prev = byUrl.get(key);
    if (prev) prev.excerpts.push(...r.excerpts);
    else byUrl.set(key, { ...r, excerpts: [...r.excerpts] });
  }
  const sources: Source[] = [];
  const snippets: Snippet[] = [];
  for (const r of byUrl.values()) {
    const domain = domainOf(r.url);
    if (!domain) continue;
    const n = sources.length + 1;
    const pdf = /\.pdf(\?|$)/i.test(r.url);
    if (pdf && x.id !== "extended") continue; // PDF sources are an extended-tier feature
    sources.push({ n, url: r.url, domain, title: r.title, date: r.publish_date, pdf });
    const seen = new Set<string>();
    for (const s of r.excerpts.flatMap(sentences)) {
      if (seen.size >= SNIPPETS_PER_SOURCE) break;
      const t = capWords(s);
      if (seen.has(t)) continue;
      seen.add(t);
      snippets.push({ id: `s${snippets.length + 1}`, source: n, text: t });
    }
  }
  const cap = x.id === "brief" ? 5 : x.id === "standard" ? 15 : 30;
  const used = snippets.slice(0, cap);

  // claim -> source table: each snippet is a candidate claim; group near-duplicates (term Jaccard >= 0.5).
  type Claim = { claim: string; snippets: string[]; sources: number[]; domains: string[]; conflict?: boolean };
  const claims: Claim[] = [];
  const tset = new Map(used.map((s) => [s.id, terms(s.text)]));
  for (const s of used) {
    const dom = sources[s.source - 1].domain;
    const hit = claims.find((c) => jaccard(tset.get(c.snippets[0])!, tset.get(s.id)!) >= 0.5);
    if (hit) {
      hit.snippets.push(s.id);
      if (!hit.sources.includes(s.source)) hit.sources.push(s.source);
      if (!hit.domains.includes(dom)) hit.domains.push(dom);
      const a = numbers(used.find((u) => u.id === hit.snippets[0])!.text);
      const b = numbers(s.text);
      if (a.length && b.length && !a.some((v) => b.includes(v))) hit.conflict = true;
    } else claims.push({ claim: s.text, snippets: [s.id], sources: [s.source], domains: [dom] });
  }

  const base = {
    tier: x.id,
    question: q,
    sources,
    snippets: used,
    claims: claims.map((c) => ({ claim: c.claim, snippets: c.snippets, sources: c.sources })),
  };
  if (x.id === "brief") return base;
  const multi = claims.filter((c) => c.domains.length >= 2);
  const out: Record<string, unknown> = {
    ...base,
    found_on_two_or_more_domains: multi.map((c) => ({ claim: c.claim, domains: c.domains, snippets: c.snippets })),
    conflicts_flagged_heuristic: claims.filter((c) => c.conflict).map((c) => ({ claim: c.claim, snippets: c.snippets })),
    could_not_confirm: claims.filter((c) => c.domains.length < 2).map((c) => c.claim).slice(0, 20),
    sub_questions: subQuestionList(q),
  };
  if (x.id === "extended") {
    const timeline: { date: string; snippet: string }[] = [];
    for (const s of used) for (const d of s.text.match(DATE_RE) ?? []) timeline.push({ date: d, snippet: s.id });
    for (const src of sources) if (src.date) timeline.push({ date: src.date, snippet: `source:${src.n}` });
    out.timeline = timeline.sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
    out.sources = sources.map((s) => ({ ...s, label: /\.(gov|mil|edu)$/.test(s.domain) || s.pdf ? "primary_heuristic" : "secondary_heuristic" }));
  }
  return out;
}

/** Run the upstream calls for one sync tier within the deadline. Units come from the tier table only. */
export async function runResearch(x: Tier, q: string, deadline: number) {
  const subs = x.id === "brief" ? [q] : subQuestionList(q);
  const queries = [q, ...subs.filter((s) => s !== q)].slice(0, Math.max(1, x.searches));
  const perSearch = Math.max(3, Math.ceil(x.reads / Math.max(1, queries.length)));
  const found: ParallelResult[] = [];
  // One Parallel search call carries up to 5 queries; a tier's search units cap the number of queries sent.
  for (let i = 0; i < queries.length; i += 5) {
    found.push(...(await parallelSearch(q, queries.slice(i, i + 5), Math.min(20, perSearch * Math.min(5, queries.length - i)), deadline)));
  }
  const urls = [...new Set(found.map((r) => r.url))].slice(0, x.reads);
  const read = x.id === "brief" ? [] : await parallelExtract(q, urls, deadline);
  return compile(x, q, [...found, ...read]);
}
