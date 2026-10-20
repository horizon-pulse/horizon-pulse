/**
 * Odin ruling (c), 10/19 11:27 PM: deterministic verified brief. Claims are ONLY code-confirmed facts:
 *  - onchain-confirmed reads (two independent nodes, same block; templated text),
 *  - official pairs (two different documents of the same issuing authority, same value + shared topic word),
 *  - publisher-confirmed pairs (two independent publishers, same value + shared topic word, near-duplicates rejected).
 * Claim text = the primary page sentence, verbatim. The model writes only the answer line (checked), else a template.
 */
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
    if (claims.some((x) => norm(x.text) === norm(c.text) || nearDuplicate(x.text, c.text))) return;
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
  const pair = (a: { url: string; quote: string }, b: { url: string; quote: string }, tier: "official" | "publisher-confirmed") => {
    if (a.quote.length > QUOTE_CAP || b.quote.length > QUOTE_CAP) return;
    const p = evidence(a.url, a.quote, pageText, fetchedAt);
    const s = evidence(b.url, b.quote, pageText, fetchedAt);
    if (!p || !s) return; // verbatim at offset or not at all
    const vals = [...factValues(a.quote)].filter((v) => factValues(b.quote).has(v));
    const date = effectiveDate(a.quote) ?? (index.find((r) => r.url === a.url)?.publish_date ?? undefined) ?? undefined;
    if (tier === "official" && !date) return; // spec: official needs the effective date
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
  if (t.official) for (const [a, b] of candidatePairs(q, index, 12, true)) {
    if (docKey(a.url) === docKey(b.url)) continue;
    if (live && newest && docDate(a.url) !== newest && docDate(b.url) !== newest) continue;
    pair(a, b, "official");
  }
  for (const [a, b] of candidatePairs(q, pages, 12)) pair(a, b, "publisher-confirmed");

  const subj = subjectTerms(q);
  let answer = "";
  let answer_by: VerifiedBrief["answer_by"] = "none";
  let usage: VerifiedBrief["usage"];
  if (claims.length >= minConfirmed) {
    const w = await writeAnswer(q, claims.map((c) => c.text), deadline);
    if (w) (answer = w.text, answer_by = "model", usage = { inputTokens: w.inputTokens, outputTokens: w.outputTokens });
  }
  if (!answer) {
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
