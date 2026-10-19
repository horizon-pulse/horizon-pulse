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

/** Odin C3: every snippet is labelled as the search provider's excerpt; $20+ adds a check against our own fetch (archive.ts). */
export const EXCERPT_SOURCE = "search_provider_excerpt" as const;
export type Snippet = { id: string; source: number; text: string; excerpt_source: typeof EXCERPT_SOURCE };
/** publish_date = the date the search provider reports for the page; retrieved_at = when we received the excerpt. */
export type Source = { n: number; url: string; domain: string; title: string | null; publish_date: string | null; retrieved_at: string; pdf: boolean; label?: "primary_heuristic" | "secondary_heuristic" };

/* ---------- brief quality (Odin 10/19) ---------- */
/** Opinion / superlative / marketing language: dropped as claims (we only quote checkable statements). */
const OPINION_RE =
  /\b(best|worst|greatest|leading|premier|ideal|perfect|amazing|incredible|revolutionary|game[- ]chang\w*|seamless(ly)?|effortless(ly)?|simple|easy|easiest|you should|we recommend|recommended|must[- ]have|the go-to|default choice|best default|most popular|world[- ]class|cutting[- ]edge|unmatched|unparalleled|pitch)\b/i;
export function isOpinion(s: string): boolean {
  return OPINION_RE.test(s);
}
/** A sentence that starts with a pronoun depends on context we do not quote; it is dropped (extractive only: no rewriting). */
const LEADING_PRONOUN_RE = /^(?:["'“(]\s*)?(?:it|its|this|that|these|those|they|their|them|he|she|his|her|we|our|such)\b/i;
export function isSelfContained(s: string): boolean {
  return !LEADING_PRONOUN_RE.test(s.trim());
}
/** Title with a trailing " | Site" / " - Site" brand stripped, for syndication matching. */
function coreTitle(t: string | null): string {
  return (t ?? "").split(/\s+[|–—]\s+/)[0].trim();
}
/** Long numeric release ids in the URL path (wire services reuse them: businesswire 20260604387279 on morningstar). */
const releaseIds = (u: string) => new Set((u.match(/\d{10,}/g) ?? []));
/** Same release on two domains: shared wire id, near-identical core title, or near-identical excerpts. */
export function isSyndicated(a: ParallelResult, b: ParallelResult): boolean {
  const ia = releaseIds(a.url);
  for (const id of releaseIds(b.url)) if (ia.has(id)) return true;
  const ta = terms(coreTitle(a.title));
  const tb = terms(coreTitle(b.title));
  if (ta.size >= 4 && tb.size >= 4 && jaccard(ta, tb) >= 0.8) return true;
  const ea = terms(a.excerpts.join(" "));
  const eb = terms(b.excerpts.join(" "));
  return ea.size >= 12 && eb.size >= 12 && jaccard(ea, eb) >= 0.7;
}
/** Registrable-ish domain for independence counting (help.coinbase.com and coinbase.com are one publisher). */
function registrable(domain: string): string {
  const p = domain.split(".");
  const twoLevelTld = /^(co|com|org|net|gov|ac|edu)$/.test(p[p.length - 2] ?? "") && (p[p.length - 1] ?? "").length === 2;
  return p.slice(twoLevelTld ? -3 : -2).join(".");
}
/** Odin 10/19: domains with one owner count as ONE publisher unless independence is verified. Keep small and explicit. */
export const SAME_OWNER: Record<string, string> = { "usdc.org": "circle.com", "usdc.com": "circle.com", "circle.com": "circle.com" };
export function publisherOf(domain: string): string {
  const r = registrable(domain);
  return SAME_OWNER[r] ?? r;
}
/** Key facts: numbers (with $/%), ISO / month-name dates, months+years, and capitalised entities not at sentence start. */
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
export function keyFacts(s: string, exclude: Set<string> = new Set()): Set<string> {
  const out = new Set<string>();
  for (const d of s.match(DATE_RE) ?? []) out.add(`d:${d.toLowerCase()}`);
  for (const m of s.toLowerCase().match(new RegExp(`\\b(?:${MONTHS})\\s+(?:19|20)\\d{2}\\b`, "g")) ?? []) out.add(`d:${m}`);
  for (const n of numbers(s)) if (/\d/.test(n)) out.add(`n:${n.replace(/,/g, "")}`);
  const words = s.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[^A-Za-z0-9&.-]/g, "").replace(/\.$/, "");
    if (/^[A-Z][A-Za-z0-9&.-]{1,}$/.test(w) && !new RegExp(`^(?:${MONTHS})$`, "i").test(w) && !exclude.has(w.toLowerCase()) && !STOP.has(w.toLowerCase()))
      out.add(`e:${w.toLowerCase()}`);
  }
  return out;
}
/** Same key fact AND the same subject: >=2 shared subject keywords beyond the fact tokens and the question's own words. */
export function sameFact(a: string, b: string, qTerms: Set<string> = new Set()): boolean {
  const fa = keyFacts(a, qTerms);
  const fb = keyFacts(b, qTerms);
  const shared = [...fa].filter((f) => fb.has(f));
  if (!shared.length) return false;
  const factWords = new Set(shared.map((f) => f.slice(2)).flatMap((f) => f.split(/\s+/)));
  const stem = (w: string) => w.replace(/(?:ies|es|s)$/, (m) => (m === "ies" ? "y" : "")).replace(/\.$/, "");
  const subj = (t: string) => new Set([...terms(t)].filter((w) => !qTerms.has(w) && !factWords.has(w) && !/^\$?\d/.test(w)).map(stem));
  const sa = subj(a);
  let overlap = 0;
  for (const w of subj(b)) if (sa.has(w)) overlap++;
  return overlap >= 2;
}
export const MIN_INDEPENDENT_DOMAINS = 3;
const PER_DOMAIN_CAP: Record<string, number> = { brief: 2, standard: 5, extended: 8 };
export const UNCONFIRMED_EMPTY_NOTE = "Every claim above was found on at least two independent domains.";

export function compile(x: Tier, q: string, results: ParallelResult[], retrievedAt: string = new Date().toISOString()) {
  const rich = x.id === "extended" || x.id === "report" || x.id === "monitor";
  const byUrl = new Map<string, ParallelResult>();
  for (const r of results) {
    const key = r.url.replace(/#.*$/, "").replace(/\/$/, "");
    const prev = byUrl.get(key);
    if (prev) prev.excerpts.push(...r.excerpts);
    else byUrl.set(key, { ...r, excerpts: [...r.excerpts] });
  }
  const sources: (Source & { syndicated_copy_of?: number })[] = [];
  const kept: ParallelResult[] = [];
  const perSource = new Map<number, Snippet[]>();
  let sid = 0;
  const dropped = { opinion: 0, pronoun: 0 }; // debug counts only; no text is kept or logged
  for (const r of byUrl.values()) {
    const domain = domainOf(r.url);
    if (!domain) continue;
    const pdf = /\.pdf(\?|$)/i.test(r.url);
    if (pdf && !rich) continue; // PDF sources are an extended-tier feature
    const n = sources.length + 1;
    const origIdx = kept.findIndex((k) => domainOf(k.url) !== domain && isSyndicated(k, r));
    kept.push(r);
    const src: Source & { syndicated_copy_of?: number } = { n, url: r.url, domain, title: r.title, publish_date: r.publish_date, retrieved_at: retrievedAt, pdf };
    if (origIdx >= 0) {
      // syndicated copy: listed, counted as the same source, never quoted
      src.syndicated_copy_of = sources[origIdx].syndicated_copy_of ?? sources[origIdx].n;
      sources.push(src);
      continue;
    }
    sources.push(src);
    const seen = new Set<string>();
    const list: Snippet[] = [];
    for (const s of r.excerpts.flatMap(sentences)) {
      if (list.length >= SNIPPETS_PER_SOURCE) break;
      if (isOpinion(s)) {
        dropped.opinion++;
        continue;
      }
      if (!isSelfContained(s)) {
        dropped.pronoun++;
        continue;
      }
      const t = capWords(s);
      if (seen.has(t)) continue;
      seen.add(t);
      list.push({ id: "", source: n, text: t, excerpt_source: EXCERPT_SOURCE });
    }
    perSource.set(n, list);
  }
  // Round-robin across publishers so claims spread over distinct domains; per-publisher cap per tier.
  const domCap = PER_DOMAIN_CAP[x.id] ?? 12;
  const allCandidates = [...perSource.values()].flat();
  const byPub = new Map<string, Snippet[]>();
  for (const [n, list] of perSource) {
    const pub = publisherOf(sources[n - 1].domain);
    byPub.set(pub, [...(byPub.get(pub) ?? []), ...list]);
  }
  const snippets: Snippet[] = [];
  const taken = new Map<string, number>();
  for (let progressed = true; progressed; ) {
    progressed = false;
    for (const [pub, list] of byPub) {
      if (!list.length || (taken.get(pub) ?? 0) >= domCap) continue;
      const sn = list.shift()!;
      snippets.push({ ...sn, id: `s${++sid}` });
      taken.set(pub, (taken.get(pub) ?? 0) + 1);
      progressed = true;
    }
  }
  const cap = x.id === "brief" ? 5 : x.id === "standard" ? 15 : x.id === "extended" ? 30 : 60;
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

  const pubOfSrc = (n: number) => publisherOf(sources[n - 1].domain);
  // Odin 10/19 (2): confirmed = two independent publishers share a key fact (number / date / named entity) about the same subject.
  const qTerms = terms(q);
  for (const c of claims) {
    if (new Set(c.domains.map(publisherOf)).size >= 2) continue;
    const head = used.find((u) => u.id === c.snippets[0])!;
    const by = new Set<string>();
    for (const o of allCandidates) if (pubOfSrc(o.source) !== pubOfSrc(head.source) && sameFact(head.text, o.text, qTerms)) by.add(pubOfSrc(o.source));
    if (by.size) (c as { confirmed_by?: string[] }).confirmed_by = [...by];
  }
  const pubsOf = (c: (typeof claims)[number]) => new Set([...c.domains.map(publisherOf), ...((c as { confirmed_by?: string[] }).confirmed_by ?? [])]);
  const quotedPubs = [...new Set(used.map((s) => pubOfSrc(s.source)))];
  const foundPubs = new Set([...perSource.keys()].map(pubOfSrc));
  const independent = foundPubs.size;
  const merged = [...foundPubs]
    .map((pub) => ({ pub, doms: [...new Set([...perSource.keys()].map((n) => registrable(sources[n - 1].domain)).filter((d) => SAME_OWNER[d] === pub))] }))
    .filter((m) => m.doms.length >= 2);
  const mergedNote = merged.length ? ` Same-owner domains counted as one publisher: ${merged.map((m) => `${m.doms.join(" + ")} (${m.pub})`).join("; ")}.` : "";
  const unconfirmed = claims.filter((c) => pubsOf(c).size < 2).map((c) => c.claim).slice(0, 20);
  const base = {
    tier: x.id,
    question: q,
    sources,
    snippets: used,
    claims: claims.map((c) => {
      const cb = (c as { confirmed_by?: string[] }).confirmed_by;
      return { claim: c.claim, snippets: c.snippets, sources: c.sources, ...(cb ? { confirmed_by: cb } : {}) };
    }),
    independent_domains: { found: independent, quoted: quotedPubs.length, minimum: MIN_INDEPENDENT_DOMAINS, domains: quotedPubs, counted_as: "publishers" },
    ...(independent < MIN_INDEPENDENT_DOMAINS || mergedNote
      ? {
          coverage_note: `${independent < MIN_INDEPENDENT_DOMAINS ? `Only ${independent} independent publisher${independent === 1 ? "" : "s"} found for this question (minimum ${MIN_INDEPENDENT_DOMAINS}). Treat these claims as thinly sourced.` : `${independent} independent publishers found.`}${mergedNote}`,
        }
      : {}),
    could_not_confirm: unconfirmed,
    could_not_confirm_note: unconfirmed.length
      ? "These claims appear on only one independent publisher; we could not confirm them elsewhere."
      : UNCONFIRMED_EMPTY_NOTE,
    dropped,
  };
  if (x.id === "brief") return base;
  const multi = claims.filter((c) => c.domains.length >= 2);
  const out: Record<string, unknown> = {
    ...base,
    found_on_two_or_more_domains: multi.map((c) => ({ claim: c.claim, domains: c.domains, snippets: c.snippets })),
    conflicts_flagged_heuristic: claims.filter((c) => c.conflict).map((c) => ({ claim: c.claim, snippets: c.snippets })),
    sub_questions: subQuestionList(q),
  };
  if (rich) {
    const timeline: { date: string; snippet: string }[] = [];
    for (const s of used) for (const d of s.text.match(DATE_RE) ?? []) timeline.push({ date: d, snippet: s.id });
    for (const src of sources) if (src.publish_date) timeline.push({ date: src.publish_date, snippet: `source:${src.n}` });
    out.timeline = timeline.sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
    out.sources = sources.map((s) => ({ ...s, label: /\.(gov|mil|edu)$/.test(s.domain) || s.pdf ? "primary_heuristic" : "secondary_heuristic" }));
  }
  return out;
}

/** Searches for one tier (checkpointable step 1 of the async report job). */
export async function researchSearches(x: Tier, q: string, deadline: number): Promise<ParallelResult[]> {
  const subs = subQuestionList(q);
  const queries = [q, ...subs.filter((s) => s !== q)].slice(0, Math.max(1, x.searches));
  const perSearch = Math.max(3, Math.ceil(x.reads / Math.max(1, queries.length)));
  const found: ParallelResult[] = [];
  for (let i = 0; i < queries.length; i += 5) {
    found.push(...(await parallelSearch(q, queries.slice(i, i + 5), Math.min(20, perSearch * Math.min(5, queries.length - i)), deadline)));
  }
  return found;
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
