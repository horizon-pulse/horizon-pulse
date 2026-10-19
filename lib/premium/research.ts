/**
 * R1 sync tiers (brief $1, standard $5, extended $10): extractive output only (spec §1).
 * Quoted snippets (<= ~50 words, <= 5 per source), source URLs, dates, a claim -> source table. We add no prose of
 * our own; Parallel output is itself AI/ML-generated, so public copy never says "no AI".
 * Heuristics are labelled as such in the output; nothing here is a verdict.
 */
import { parallelExtract, parallelSearch, type ParallelResult } from "./parallel";
import type { Tier } from "./tiers";
import { synthesizeBrief } from "./synthesis";

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

/** Odin 10/19 (A): markdown out before sentence splitting (links -> text, images/bare URLs out, emphasis/bullets/headings/code/tables out). */
export function stripMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[*+-]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, " ")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\*\*|__/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}
/** Odin 10/19 (A): Published / Updated / Posted + a date anywhere in the line is a dateline, not a claim. */
export function isDateline(s: string): boolean {
  return new RegExp(`\\b(published|updated|posted|last updated|modified)\\b[^.\\n]{0,25}?(?:\\b(?:19|20)\\d{2}-\\d{2}-\\d{2}\\b|\\b${MON}\\s+\\d{1,2}|\\b\\d{1,2}\\s+${MON}|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b|\\b(?:today|yesterday|\\d+\\s+(?:hours?|days?|minutes?)\\s+ago)\\b)`, "i").test(s);
}
export function sentences(text: string): string[] {
  return stripMarkdown(text)
    .replace(/Section Title:[^\n]*\n?|Content:\n?|\.\.\. \(content truncated\)/g, " ")
    .split(/(?<=[.!?])(?<!\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mr|Ms|Mrs|Dr|Inc|Corp|Co|Ltd|St|vs|No|U\.S|a\.m|p\.m)\.)\s+|\n+/)
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
const MONTH_IDX: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const pad = (d: string) => d.padStart(2, "0");
/** Normalised fact values: dates as YYYY-MM-DD (or YYYY-MM for "August 2023"), numbers with a unit or >= 2 digits (bare years excluded). */
export function factValues(s: string): Set<string> {
  const out = new Set<string>();
  let rest = s.toLowerCase();
  const take = (re: RegExp, f: (m: RegExpExecArray) => string) => {
    for (const m of [...rest.matchAll(re)]) {
      out.add(f(m as RegExpExecArray));
      rest = rest.replace(m[0], " ");
    }
  };
  take(/\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g, (m) => `d:${m[1]}-${m[2]}-${m[3]}`);
  take(new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:19|20)\\d{2})\\b`, "g"), (m) => `d:${m[3]}-${MONTH_IDX[m[1]]}-${pad(m[2])}`);
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}\\s+((?:19|20)\\d{2})\\b`, "g"), (m) => `d:${m[3]}-${MONTH_IDX[m[2]]}-${pad(m[1])}`);
  take(new RegExp(`\\b${MON}\\s+((?:19|20)\\d{2})\\b`, "g"), (m) => `d:${m[2]}-${MONTH_IDX[m[1]]}`);
  for (const m of rest.matchAll(/(?<![a-z0-9.,-])(\$)?(\d[\d,]*(?:\.\d+)?)(?![a-z0-9])\s*(%|percent|million|billion|m\b|bn\b|b\b)?/g)) {
    const num = m[2].replace(/,/g, "").replace(/\.$/, "");
    if (!m[1] && !m[3] && (num.length < 2 || /^(19|20)\d{2}$/.test(num))) continue;
    out.add(`n:${m[1] ?? ""}${num}${m[3] ? m[3].replace("percent", "%").replace(/^m$/, "million").replace(/^(bn|b)$/, "billion") : ""}`);
  }
  return out;
}
/** Dates in a sentence (normalised), for answer lines. */
export const dateValues = (s: string) => [...factValues(s)].filter((f) => f.startsWith("d:"));
const stem = (w: string) => w.replace(/(?:ing|ed|es|s)$/, "").replace(/\.$/, "");
/** Subject keywords: content terms minus the question's own words and digits, crude-stemmed. */
const SUBJ_STOP = new Set("per under over about than more less also which its into onto via after before since until while when where what who how all any each most some such only just very can will would could should may might said says new".split(" "));
const subjectTerms = (t: string, qTerms: Set<string>) => new Set([...terms(t)].filter((w) => !qTerms.has(w) && !SUBJ_STOP.has(w) && !/\d/.test(w)).map(stem).filter((w) => w.length > 2));
/** Odin 10/19 (3): confirmed only by the same normalised date / number on another publisher's page, about the same subject (>=1 shared subject keyword beyond the question's words). */
export function sameFactValue(a: string, b: string, qTerms: Set<string> = new Set()): string | null {
  const fb = factValues(b);
  const shared = [...factValues(a)].find((f) => fb.has(f));
  if (!shared) return null;
  const sa = subjectTerms(a, qTerms);
  for (const w of subjectTerms(b, qTerms)) if (sa.has(w)) return shared;
  return null;
}
/** Odin 10/19 (2): headline / title / byline-shaped lines are not claims. */
const VERB_RE = /\b(is|are|was|were|be|been|has|have|had|will|would|can|could|did|does|do|said|says|announced|launched|became|went|began|started|released|introduced|opened|added|raised|reached|reported|plans|allows|lets|uses|runs|offers|includes|provides|supports|charges|costs)\b|\b\w+(ed|es)\b/i;
export function isHeadlineLike(s: string, title: string | null = null): boolean {
  const t = s.trim();
  if (/^by\s+[A-Z]/i.test(t)) return true;
  if (/^(updated|published|posted)\b/i.test(t) || isDateline(t)) return true;
  if (t.replace(DATE_RE, "").replace(/[^A-Za-z]/g, "").length < 4) return true; // date-only
  if (!/[.!?]["')\]]?$/.test(t)) return true; // real sentences end in punctuation; headlines / nav lines do not
  const words = t.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && w.length > 3 && !new RegExp(`^${MON}$`, "i").test(w.replace(/[^A-Za-z.]/g, "")));
  if (words.length >= 5 && words.filter((w) => /^[A-Z]/.test(w)).length / words.length >= 0.7) return true; // Title Case
  if (title) {
    const tt = terms(coreTitle(title));
    if (tt.size >= 3 && jaccard(tt, terms(t)) >= 0.6) return true;
  }
  return t.split(/\s+/).length <= 8 && !VERB_RE.test(t); // short and verb-less: a label, not a statement
}
/** Question kind for the direct answer line (deterministic). */
export function questionKind(q: string): "when" | "number" | null {
  if (/^\s*(when|what (year|date|day|month)|which (year|date))\b/i.test(q)) return "when";
  if (/^\s*(how (much|many|long|big|fast)|what (is|was|are) the (price|cost|fee|number|size|amount|supply))\b/i.test(q)) return "number";
  return null;
}
export const MIN_INDEPENDENT_DOMAINS = 3;
const PER_DOMAIN_CAP: Record<string, number> = { brief: 2, standard: 5, extended: 8 };
export const UNCONFIRMED_EMPTY_NOTE = "Every claim above was found on at least two independent domains.";

export function compile(x: Tier, q: string, results: ParallelResult[], retrievedAt: string = new Date().toISOString(), extracted: ParallelResult[] = []) {
  const urlKey = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
  const pageText = new Map<string, string[]>();
  for (const e of extracted) pageText.set(urlKey(e.url), [...(pageText.get(urlKey(e.url)) ?? []), ...e.excerpts]);
  const qTerms = terms(q);
  const kind = questionKind(q);
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
  const dropped = { opinion: 0, pronoun: 0, headline: 0 }; // debug counts only; no text is kept or logged
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
    // Odin 10/19 (1): claims come from page content (extract) when we have it; search excerpts are the fallback.
    const page = pageText.get(urlKey(r.url));
    const cands = (page && page.length ? page : r.excerpts).flatMap(sentences);
    // brief: rank sentences that carry what the question asks for (dates for when-questions) and its terms first
    const score = (t: string) => (kind === "when" && dateValues(t).length ? 2 : 0) + (kind === "number" && [...factValues(t)].some((f) => f.startsWith("n:")) ? 2 : 0) + Math.min(2, [...terms(t)].filter((w) => qTerms.has(w)).length * 0.5);
    const ranked = x.id === "brief" ? cands.map((t, i) => ({ t, i, sc: score(t) })).sort((p, q2) => q2.sc - p.sc || p.i - q2.i).map((o) => o.t) : cands;
    for (const s of ranked) {
      if (list.length >= SNIPPETS_PER_SOURCE) break;
      if (isOpinion(s)) {
        dropped.opinion++;
        continue;
      }
      if (!isSelfContained(s)) {
        dropped.pronoun++;
        continue;
      }
      if (isHeadlineLike(s, r.title)) {
        dropped.headline++;
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
  // Odin 10/19 (3): confirmed only by the same normalised date / number on another publisher's page about the same subject.
  for (const c of claims) {
    const head = used.find((u) => u.id === c.snippets[0])!;
    const by = new Set<string>();
    const facts = new Set<string>();
    for (const o of allCandidates) {
      if (pubOfSrc(o.source) === pubOfSrc(head.source)) continue;
      const f = sameFactValue(head.text, o.text, qTerms);
      if (f) {
        by.add(pubOfSrc(o.source));
        facts.add(f.slice(2));
      }
    }
    if (by.size) Object.assign(c, { confirmed_by: [...by], confirmed_values: [...facts] });
  }
  const pubsOf = (c: (typeof claims)[number]) => new Set([pubOfSrc(c.sources[0]), ...((c as { confirmed_by?: string[] }).confirmed_by ?? [])]);
  const quotedPubs = [...new Set(used.map((s) => pubOfSrc(s.source)))];
  const foundPubs = new Set([...perSource.keys()].map(pubOfSrc));
  const independent = foundPubs.size;
  const merged = [...foundPubs]
    .map((pub) => ({ pub, doms: [...new Set([...perSource.keys()].map((n) => registrable(sources[n - 1].domain)).filter((d) => SAME_OWNER[d] === pub))] }))
    .filter((m) => m.doms.length >= 2);
  const mergedNote = merged.length ? ` Same-owner domains counted as one publisher: ${merged.map((m) => `${m.doms.join(" + ")} (${m.pub})`).join("; ")}.` : "";
  const unconfirmed = claims.filter((c) => pubsOf(c).size < 2).map((c) => c.claim).slice(0, 20);
  // Odin 10/19 (4): direct answer line, deterministic: when -> date-bearing claims (confirmed first, earliest date first); number -> number-bearing.
  const answerPick = (() => {
    if (!kind) return null;
    const has = (t: string) => (kind === "when" ? dateValues(t).length > 0 : [...factValues(t)].some((f) => f.startsWith("n:")));
    const ok = claims.filter((c) => has(c.claim));
    if (!ok.length) return null;
    const conf = (c: (typeof claims)[number]) => ((c as { confirmed_by?: string[] }).confirmed_by?.length ?? 0);
    const firstDate = (c: (typeof claims)[number]) => dateValues(c.claim).sort()[0] ?? "9999";
    ok.sort((p, r) => conf(r) - conf(p) || (kind === "when" ? firstDate(p).localeCompare(firstDate(r)) : 0));
    const best = ok.filter((c) => conf(c) > 0);
    const pool = best.length ? best : ok;
    const usedDates = new Set<string>();
    const pick = kind === "when" ? pool.filter((c) => !usedDates.has(firstDate(c)) && !!usedDates.add(firstDate(c))).slice(0, 2) : pool.slice(0, 1);
    return pick.map((c) => ({ text: c.claim, snippets: c.snippets, sources: c.sources, confirmed: conf(c) > 0 }));
  })();
  const base = {
    tier: x.id,
    question: q,
    answer: answerPick
      ? { lines: answerPick, note: answerPick.some((a) => a.confirmed) ? "Quoted from the sources below; confirmed where marked." : "Quoted from one source; not confirmed on a second publisher." }
      : { lines: [], note: kind ? "No quoted sentence answers the question directly." : "Not a date or number question; see the claims below." },
    sources,
    snippets: used,
    claims: claims.map((c) => {
      const cc = c as { confirmed_by?: string[]; confirmed_values?: string[] };
      return { claim: c.claim, snippets: c.snippets, sources: c.sources, ...(cc.confirmed_by ? { confirmed_by: cc.confirmed_by, confirmed_values: cc.confirmed_values } : {}) };
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
    advice_disclaimer: "Not financial, investment, tax, legal or health advice. Quotes about tokens, securities or other financial products are not a recommendation to buy, sell or hold anything.",
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

export const BRIEF_EXTRACT_N = 4;
/** Top distinct publishers in search order, skipping syndicated copies and PDFs. */
export function briefExtractUrls(found: ParallelResult[], n = BRIEF_EXTRACT_N): string[] {
  const pubs = new Set<string>();
  const out: string[] = [];
  const seen: ParallelResult[] = [];
  for (const r of found) {
    const d = domainOf(r.url);
    if (!d || /\.pdf(\?|$)/i.test(r.url)) continue;
    if (seen.some((k) => domainOf(k.url) !== d && isSyndicated(k, r))) continue;
    seen.push(r);
    const p = publisherOf(d);
    if (pubs.has(p)) continue;
    pubs.add(p);
    out.push(r.url);
    if (out.length >= n) break;
  }
  return out;
}

/** Run the upstream calls for one sync tier within the deadline. Units come from the tier table only. */
/** C1: optional sink for the cleaned search + extract results (Preview debug capture only; see capture.ts). */
export type CaptureSink = { data?: { search: ParallelResult[]; extract: ParallelResult[] } };
export async function runResearch(x: Tier, q: string, deadline: number, capture?: CaptureSink) {
  const subs = x.id === "brief" ? [q] : subQuestionList(q);
  const queries = [q, ...subs.filter((s) => s !== q)].slice(0, Math.max(1, x.searches));
  const perSearch = Math.max(3, Math.ceil(x.reads / Math.max(1, queries.length)));
  const found: ParallelResult[] = [];
  // One Parallel search call carries up to 5 queries; a tier's search units cap the number of queries sent.
  for (let i = 0; i < queries.length; i += 5) {
    found.push(...(await parallelSearch(q, queries.slice(i, i + 5), Math.min(20, perSearch * Math.min(5, queries.length - i)), deadline)));
  }
  if (x.id === "brief") {
    // Odin 10/19 (1): extract page content for the top BRIEF_EXTRACT_N distinct publishers (search order), within the budget.
    const urls = briefExtractUrls(found);
    const read = urls.length ? await parallelExtract(q, urls, deadline).catch(() => [] as ParallelResult[]) : [];
    if (capture) capture.data = { search: found, extract: read };
    const code = compile(x, q, found, undefined, read);
    return await synthesizeBrief(q, code, read, deadline);
  }
  const urls = [...new Set(found.map((r) => r.url))].slice(0, x.reads);
  const read = await parallelExtract(q, urls, deadline);
  return compile(x, q, [...found, ...read]);
}
