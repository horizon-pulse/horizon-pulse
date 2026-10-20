/**
 * Odin ruling (c), 10/19 11:27 PM: deterministic verified brief. Claims are ONLY code-confirmed facts:
 *  - onchain-confirmed reads (two independent nodes, same block; templated text),
 *  - official pairs (two different documents of the same issuing authority, same value + shared topic word),
 *  - publisher-confirmed pairs (two independent publishers, same value + shared topic word, near-duplicates rejected).
 * Claim text = the primary page sentence, verbatim. The model writes only the answer line (checked), else a template.
 */
import { briefModelAnswerEnabled } from "./contract";
import type { ParallelResult } from "./parallel";
import { extractAllowed } from "./parallel";
import type { OnchainFact } from "./onchain";
import type { IndexType } from "./source-index";
import { CONTRACT_MAX_CLAIMS, CONTRACT_MIN_CLAIMS, CONTRACT_MIN_CONFIRMED, CONTRACT_URL, BRIEF_SCHEMA_VERSION, QUOTE_CAP, effectiveDate, evidence, onchainText, quoteItem, type ContractBrief, type ContractClaim } from "./contract";
import { candidatePairs, isLiveValueQuestion, nearDuplicate, namesSubject, norm, pageSentences, subjectTerms, writeAnswer } from "./synthesis";
import { factValues } from "./research";

export type VerifiedBrief = ContractBrief & { type: string; answer_by: "model" | "template" | "none"; usage?: { inputTokens?: number; outputTokens?: number } };

export async function buildVerified(q: string, t: IndexType, web: ParallelResult[], index: ParallelResult[], chain: OnchainFact | null, fetchedAt: string, deadline: number, minConfirmed = CONTRACT_MIN_CONFIRMED): Promise<VerifiedBrief> {
  const seenUrl = new Set<string>();
  const pages = [...index, ...web].filter((r) => extractAllowed(r.url) && !seenUrl.has(r.url) && (seenUrl.add(r.url), true));
  const { pageText } = pageSentences(pages, q, Number.MAX_SAFE_INTEGER);
  const claims: ContractClaim[] = [];
  const add = (c: ContractClaim) => {
    if (claims.length >= CONTRACT_MAX_CLAIMS) return;
    // Near-duplicate test is for page quotes (syndicated copy); templated on-chain reads of different fields are distinct facts.
    if (claims.some((x) => norm(x.text) === norm(c.text) || (!x.onchain && !c.onchain && nearDuplicate(x.text, c.text)))) return;
    claims.push(c);
  };
  for (const r of chain?.reads ?? []) {
    if (!r.confirmed) continue;
    add({
      text: onchainText(r), status: "confirmed", tier: "onchain-confirmed", primary: null, secondary: null,
      match: { value: r.value, unit: r.unit, date: r.timestamp.slice(0, 10), topic: r.method },
      onchain: { value: r.value, unit: r.unit, block: r.block, chain: r.chain, nodes: r.nodes, observed_at: r.timestamp },
      evidence: r.nodes.map((node) => ({ kind: "onchain" as const, chain: r.chain, block: r.block, block_timestamp: r.timestamp, method: r.method, ...(r.contract ? { contract: r.contract } : {}), value: r.value, unit: r.unit, node, retrieved_at: chain!.retrieved_at })),
    });
  }
  const subjQ = subjectTerms(q);
  const fetchedBy = new Map([...web, ...index].filter((r) => r.fetched_at).map((r) => [r.url, r.fetched_at!] as const));
  const pageFetched = (u: string) => fetchedBy.get(u) ?? fetchedAt;
  const pair = (a: { url: string; quote: string }, b: { url: string; quote: string }, tier: "official" | "publisher-confirmed") => {
    if (a.quote.length > QUOTE_CAP || b.quote.length > QUOTE_CAP) return;
    // A page claim must name EVERY subject term of the question (e.g. "x402" AND "facilitator"), so the answer can only
    // be written from facts about what was asked, never from adjacent facts.
    if (!namesSubject(a.quote, subjQ) || !coversQuestion(q, a.quote)) return;
    // Counsel E2: each quote carries ITS page's real fetch time (cached index pages keep their original fetch time).
    const p = evidence(a.url, a.quote, pageText, pageFetched(a.url));
    const s = evidence(b.url, b.quote, pageText, pageFetched(b.url));
    if (!p || !s) return; // verbatim at offset or not at all
    const vals = [...factValues(a.quote)].filter((v) => factValues(b.quote).has(v));
    const date = effectiveDate(a.quote) ?? (index.find((r) => r.url === a.url)?.publish_date ?? undefined) ?? undefined;
    if (tier === "official" && !date && !t.undated) return; // spec: official needs the effective date (specs: undated, published)
    add({
      text: p.quote, status: "confirmed", tier, primary: p, secondary: s,
      match: { value: vals[0]?.slice(2), date: tier === "official" ? date : vals.find((v) => v.startsWith("d:"))?.slice(2) },
      onchain: null,
      evidence: [...quoteItem(p, tier === "official" ? a.url : undefined), ...quoteItem(s, tier === "official" ? b.url : undefined)],
    });
  };
  // Official pairs: two DIFFERENT documents (locale copies and query-string variants of one page are one document).
  // For "current" questions, at least one of the two must be the authority's newest dated document in the index.
  const docKey = (u: string) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + x.pathname.replace(/^\/(?:[a-z]{2}(?:-[a-z]{2})?)(?=\/)/i, "").replace(/\/$/, ""); } catch { return u; } };
  const docDate = (u: string) => u.match(/(20\d{2})(\d{2})(\d{2})/)?.slice(1, 4).join("-") ?? index.find((r) => r.url === u)?.publish_date ?? "";
  const newest = index.map((r) => docDate(r.url)).filter(Boolean).sort().pop() ?? "";
  const live = isLiveValueQuestion(q);
  // Official pairs only among the authority's own domains; other curated ecosystem docs feed publisher pairs.
  const ownDomain = (u: string) => { try { const x = new URL(u); const h = x.hostname.toLowerCase(); if (h === "github.com" && !/^\/coinbase\/x402(\/|$)/i.test(x.pathname)) return false; /* Counsel E1 hygiene */ return !!t.official?.domains.some((d) => h === d || h.endsWith(`.${d}`)); } catch { return false; } };
  if (t.official) for (const [a, b] of candidatePairs(q, index.filter((r) => ownDomain(r.url)), 12, true)) {
    if (docKey(a.url) === docKey(b.url)) continue;
    if (live && newest && docDate(a.url) !== newest && docDate(b.url) !== newest) continue;
    pair(a, b, "official");
  }
  for (const [a, b] of candidatePairs(q, pages, 12)) pair(a, b, "publisher-confirmed");

  const subj = subjectTerms(q);
  let answer = "";
  let answer_by: VerifiedBrief["answer_by"] = "none";
  let usage: VerifiedBrief["usage"];
  if (t.onchain && chain) {
    // On-chain types: deterministic templated answer that states the values (no model, no vague wording).
    answer = onchainAnswer(chain);
    answer_by = "template";
  } else if (claims.length >= minConfirmed && briefModelAnswerEnabled()) {
    // Odin 10/20 7:22 AM: model answer only behind HP_BRIEF_MODEL_ANSWER (default OFF); otherwise templated below.
    const w = await writeAnswer(q, claims.map((c) => c.text), deadline);
    if (w) (answer = w.text, answer_by = "model", usage = { inputTokens: w.inputTokens, outputTokens: w.outputTokens });
  }
  if (!answer && !t.onchain) {
    const c = claims.find((x) => namesSubject(x.text, subj)) ?? (t.onchain ? claims.find((x) => x.tier === "onchain-confirmed") : undefined);
    if (c) (answer = c.text, answer_by = "template");
  }
  const counts = { confirmed: claims.length, consistent: 0, unconfirmed: 0 };
  const tiers = { "publisher-confirmed": 0, "onchain-confirmed": 0, official: 0 };
  for (const c of claims) if (c.tier) tiers[c.tier]++;
  const reasons: string[] = [];
  if (!answer) reasons.push("no_answer");
  if (claims.length < Math.max(CONTRACT_MIN_CLAIMS, minConfirmed)) reasons.push(`confirmed_${claims.length}_of_${minConfirmed}`);
  if (claims.some((c) => !c.evidence.length || (c.tier !== "onchain-confirmed" && c.evidence.length < 2))) reasons.push("claim_missing_evidence");
  return { question: q, answer, status: reasons.length ? "fail" : "pass", fail_reasons: reasons, claims, counts, tiers, method: CONTRACT_URL, meta: { version: "1", schema: BRIEF_SCHEMA_VERSION }, type: t.id, answer_by, ...(usage ? { usage } : {}) };
}

export function onchainAnswer(f: OnchainFact): string {
  const by = (m: string) => f.reads.filter((r) => r.confirmed && r.method === m);
  if (f.topic === "usdc_supply") {
    const parts = by("totalSupply()").map((r) => `${r.value} USDC on ${r.chain === "ethereum" ? "Ethereum" : "Base"} (block ${r.block}, ${r.timestamp})`);
    return parts.length ? `USDC totalSupply() read on-chain: ${parts.join(" and ")}. Other chains are not included.` : "";
  }
  const bf = by("baseFeePerGas")[0], gl = by("gasLimit")[0];
  if (!bf) return "";
  const name = bf.chain === "base" ? "Base" : "Ethereum mainnet";
  return `As of ${name} block ${bf.block} (${bf.timestamp}), the base fee was ${bf.value} gwei per gas${gl ? ` and the block gas limit was ${gl.value} gas` : ""}. A transaction pays its gas used × (base fee + priority tip)${bf.chain === "base" ? ", plus an L1 data fee on Base" : ""}.`;
}

const GENERIC = new Set(["what", "which", "how", "does", "do", "is", "are", "an", "a", "the", "of", "to", "in", "on", "for", "and", "use", "uses", "used", "work", "works", "mean", "means", "define", "defined", "current", "currently"]);
/**
 * A page claim must name the subject AND at least one other content word of the question (beyond the subject terms):
 * "What is an x402 facilitator" needs "facilitator"; "What HTTP status code does x402 use" needs http/status/code.
 */
export function coversQuestion(q: string, text: string): boolean {
  const subj = new Set(subjectTerms(q).map((w) => w.toLowerCase()));
  const extra = requiredTerms(q).filter((w) => !subj.has(w));
  return !extra.length || extra.some((w) => new RegExp(`\\b${w.replace(/s$/, "")}`, "i").test(text));
}
export function requiredTerms(q: string): string[] {
  return [...new Set(q.toLowerCase().replace(/[?.!,]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !GENERIC.has(w)).map((w) => w.replace(/[^a-z0-9-]/g, "")).filter(Boolean))];
}
