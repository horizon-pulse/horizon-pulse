/**
 * Hardened $1 verified brief: outcome contract + response shape (spec 2026-10-19-claude-hardened-brief-spec.md §1-§2).
 * Pure code over the assembled brief: builds one evidence object per claim, sets each claim's status/tier, counts,
 * and the brief's pass/fail. `status: "pass"` is the ONLY thing that lets the handler settle (settle-after-produce).
 */
import { createHash } from "node:crypto";
import type { ParallelResult } from "./parallel";
import { norm, pageSentences } from "./synthesis";
import { domainOf, publisherOf } from "./research";
import { OUT_OF_SCOPE_CATEGORIES } from "./source-index";

export const CONTRACT_URL = "https://horizonpulse.dev/contracts/brief-verified";
export const CONTRACT_MIN_CONFIRMED = 2; // Odin ruling (c); raised to the highest N that holds the bar (see result file)
export const CONTRACT_MIN_CLAIMS = 2;
export const CONTRACT_MAX_CLAIMS = 8;
export const QUOTE_CAP = 300;
/** Fixed, versioned response schema (bump on any breaking change; documented at CONTRACT_URL). */
export const BRIEF_SCHEMA_VERSION = "brief-verified/1";

/**
 * Clause 6: option (a) APPROVED (Michael, 10/20 7:59 AM ET) and the default. HP_BRIEF_REFUND_CHOICE can select the
 * unapproved drafts (pending, b) for review only; "e3" is
 * Counsel's 10/20 E3 text, kept for reference. Launch is blocked while pending (briefLaunchBlockers).
 */
export type RefundChoice = "pending" | "a" | "b" | "e3";
export function briefRefundChoice(env: Record<string, string | undefined> = process.env): RefundChoice {
  const v = env.HP_BRIEF_REFUND_CHOICE;
  // Michael picked (a), 10/20 7:59 AM ET (relayed by Odin): (a) is the default; the env can only select a draft for review.
  return v === "pending" || v === "b" || v === "e3" ? v : "a";
}
export const CLAUSE_6: Record<RefundChoice, string> = {
  pending: "6. Refunds and corrections for delivered briefs: terms pending; none are offered until they are published here. This does not affect the refund terms at /premium-terms for a charge without delivery.",
  // (a) no refund promise: charged only on pass. APPROVED (Michael, 10/20 7:59 AM ET); Counsel wording verbatim.
  a: "6. No refund promise: a brief is charged only when it passes clause 5; a brief that does not pass is not charged. Delivered briefs are final, except as the refund terms at /premium-terms provide for a charge without delivery. If you believe a claim we marked confirmed did not meet clause 3, tell us at horizonpulse.co@proton.me with the transaction hash; any correction is at our discretion.",
  // (b) refunds on request, no time promise. DRAFT for Michael + Counsel (E3 without "usually within 7 days").
  b: "6. Corrections: if a claim we marked confirmed did not meet clause 3 when the brief was delivered, tell us at horizonpulse.co@proton.me within 30 days with the transaction hash. If we confirm the error, we refund the full price in USDC on Base to the address that paid, under the refund terms at /premium-terms. A page that changes or disappears after delivery is not an error; the fetch time and body hash record what it said when we fetched it.",
  e3: "6. Corrections: if a claim we marked confirmed did not meet clause 3 when the brief was delivered, tell us at horizonpulse.co@proton.me within 30 days with the transaction hash. If we confirm the error, we refund the full price in USDC on Base to the address that paid, usually within 7 days, under the refund terms at /premium-terms. A page that changes or disappears after delivery is not an error; the fetch time and body hash record what it said when we fetched it.",
};
/**
 * Odin 10/20 7:22 AM: ZDR on the xAI key is unconfirmed, so every answer line is templated from code-confirmed facts.
 * The model answer path stays behind HP_BRIEF_MODEL_ANSWER=true (default OFF) AND the existing ZDR/LLM gates.
 */
export function briefModelAnswerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HP_BRIEF_MODEL_ANSWER === "true";
}
/** Counsel E5(a), verbatim; published only while the model answer path is on. */
export const CLAUSE_10_MODEL = "10. For x402 questions the answer line is written by an AI model from the confirmed claims only; code checks that it names the question's subject and contains no number or date that is not in those claims. Its wording can differ slightly between requests for the same question. On-chain answers are templated. Claim text is never written by the model.";
/** Counsel 10/20 (clause10-clause6 ruling): PASS; shown only while HP_BRIEF_MODEL_ANSWER is off. */
export const CLAUSE_10_TEMPLATE = "10. The answer line is produced by code from the confirmed claims: for on-chain questions it states the values read, and for x402 questions it is the text of a confirmed claim. No AI model writes any part of the brief.";
/** Things that must be resolved before the brief can launch (flag flip). */
export function briefLaunchBlockers(env: Record<string, string | undefined> = process.env): string[] {
  const c = briefRefundChoice(env);
  // Counsel 10/20: option (b) (and e3) refer to the /premium-terms refund line, which must itself be approved (still OPEN).
  if (c === "pending") return ["refund_choice_pending"];
  return c === "b" || c === "e3" ? (env.HP_REFUND_LINE_APPROVED === "true" ? [] : ["premium_terms_refund_line_pending"]) : [];
}

/** §1, published verbatim at /contracts/brief-verified. Clause 6 and 10 follow the switches above. */
export function outcomeContract(env: Record<string, string | undefined> = process.env): string {
  return [
  "1. A brief contains an answer (names the question's subject) and 2–8 claims. Only supported question types are accepted; others are refused before payment.",
  "2. Every claim carries a verbatim quote from a public page, with the URL, the fetch time, the page's body hash, and the quote's offset in the body. Quotes are capped at 300 characters and attributed.",
  "3. A claim is confirmed only when one of these holds:",
  "   - publisher-confirmed — a second, independent publisher states the same value or date plus a shared topic word (code-checked; near-duplicate copy is rejected);",
  "   - onchain-confirmed — two independent RPC nodes return the same value for the same block (Ethereum and Base base fee and gas limit; USDC totalSupply() on Ethereum and Base);",
  "   - official — two different documents from the x402 specification publishers (x402.org, docs.x402.org, Coinbase developer documentation, github.com/coinbase/x402) state the same fact; mirrored copies of one page count as one document. Specification pages are undated, so no effective date is required.",
  "4. consistent (two dated sources within tolerance) is shown but never counted as confirmed.",
  "5. At least 2 independently confirmed claims, or no charge: a brief passes only when at least 2 claims are confirmed and every claim's quote is found verbatim in the text of its page as fetched for this brief (fetch time and body hash shown). A brief that does not pass is not charged (settle after produce).",
  CLAUSE_6[briefRefundChoice(env)],
  "7. Every claim carries its evidence object. Briefs are not signed. For a charged brief, the x402 PAYMENT-RESPONSE settlement header (with the transaction hash) is the payment record.",
  "8. No financial, legal or medical recommendations. Briefs describe; they do not advise.",
  `9. Scope: on-chain live values (Ethereum and Base gas, base fee and gas limit; USDC supply on Ethereum and Base) and x402 specification facts only. Out of scope, refused before payment with nothing charged: ${OUT_OF_SCOPE_CATEGORIES.join("; ")}.`,
  briefModelAnswerEnabled(env) ? CLAUSE_10_MODEL : CLAUSE_10_TEMPLATE,
].join("\n");
}
export const OUTCOME_CONTRACT = outcomeContract();

export type Evidence = { url: string; quote: string; fetched_at: string; body_sha256: string; offset: number; publisher: string };
export type ContractClaim = {
  text: string;
  status: "confirmed" | "consistent" | "unconfirmed";
  tier: "publisher-confirmed" | "onchain-confirmed" | "official" | null;
  primary: Evidence | null;
  secondary: Evidence | null;
  match: { value?: string; unit?: string; date?: string; topic?: string } | null;
  onchain: { value: string; unit: string; block: number; chain: string; nodes: string[]; observed_at: string } | null;
  /** Odin checklist 1: machine-readable evidence array (one entry per source behind the claim). */
  evidence: EvidenceItem[];
};
export type EvidenceItem =
  | { kind: "quote"; quote: string; url: string; retrieved_at: string; publisher: string; body_sha256: string; offset: number; official_url?: string }
  | { kind: "onchain"; chain: string; block: number; block_timestamp: string; method: string; contract?: string; value: string; unit: string; node: string; retrieved_at: string };
export type ContractBrief = {
  question: string;
  answer: string;
  status: "pass" | "fail";
  fail_reasons: string[];
  claims: ContractClaim[];
  counts: { confirmed: number; consistent: number; unconfirmed: number };
  tiers: Record<"publisher-confirmed" | "onchain-confirmed" | "official", number>;
  method: string;
  meta: { version: "1"; schema: typeof BRIEF_SCHEMA_VERSION };
};

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const pub = (u: string) => publisherOf(domainOf(u) ?? u);
const ISO_DATE = /\b(19|20)\d\d-\d\d-\d\d\b/;
const MONTH_DATE = /\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2},? (19|20)\d\d\b/;
export const effectiveDate = (t: string) => {
  const m = t.match(ISO_DATE) ?? t.match(MONTH_DATE);
  if (!m) return undefined;
  const d = new Date(`${m[0]} UTC`);
  return Number.isNaN(d.getTime()) ? m[0] : d.toISOString().slice(0, 10);
};

/**
 * Body = the page's extracted text, markdown-stripped and normalised (the exact text the verifier matches against);
 * body_sha256 hashes that text, offset is the quote's index in it. A quote that is not found returns null (fails verify).
 */
export function evidence(url: string, quote: string, pageText: Map<string, string>, fetchedAt: string): Evidence | null {
  const body = pageText.get(url);
  const q = quote.replace(/ …$/, "");
  if (!body) return null;
  const offset = body.indexOf(norm(q));
  if (offset < 0) return null;
  return { url, quote: q, fetched_at: fetchedAt, body_sha256: sha(body), offset, publisher: pub(url) };
}

/** Templated (deterministic) claim text for an on-chain read. */
export function onchainText(r: any): string {
  const chain = r.chain === "ethereum" ? "Ethereum mainnet" : "Base";
  if (r.method === "baseFeePerGas") return `${chain} base fee was ${r.value} gwei at block ${r.block} (${r.timestamp}).`;
  if (r.method === "gasLimit") return `${chain} block gas limit was ${r.value} gas at block ${r.block} (${r.timestamp}).`;
  return `USDC totalSupply() on ${r.chain === "ethereum" ? "Ethereum" : "Base"} was ${r.value} USDC at block ${r.block} (${r.timestamp}).`;
}
export const quoteItem = (e: Evidence | null, official?: string): EvidenceItem[] =>
  e ? [{ kind: "quote", quote: e.quote, url: e.url, retrieved_at: e.fetched_at, publisher: e.publisher, body_sha256: e.body_sha256, offset: e.offset, ...(official ? { official_url: official } : {}) }] : [];

export function toContract(q: string, b: any, extracted: ParallelResult[], fetchedAt: string): ContractBrief {
  const { pageText } = pageSentences(extracted, q, Number.MAX_SAFE_INTEGER);
  const sources: any[] = Array.isArray(b?.sources) ? b.sources : [];
  const snippets: any[] = Array.isArray(b?.snippets) ? b.snippets : [];
  const snipById = (id: string) => snippets.find((s) => s.id === id);
  const urlOf = (s: any) => sources[s.source - 1]?.url as string | undefined;
  const reasons: string[] = [];
  let verbatimOk = true;
  const ev = (s: any): Evidence | null => {
    const u = s && urlOf(s);
    const e = u ? evidence(u, s.text, pageText, fetchedAt) : null;
    if (!e) verbatimOk = false;
    return e;
  };
  const auth = b?.authority?.source_tier === "issuing_authority" && b.authority.documents >= 2 ? b.authority : null;
  const claims: ContractClaim[] = [];
  const seen = new Set<string>();
  const add = (c: ContractClaim) => {
    const k = norm(c.text);
    if (seen.has(k)) return;
    seen.add(k);
    claims.push(c);
  };
  // On-chain reads first: they are the source of record for live values.
  for (const r of b?.onchain?.reads ?? []) {
    const chain = r.chain === "ethereum" ? "Ethereum" : "Base";
    add({
      text: onchainText(r),
      status: r.confirmed ? "confirmed" : "unconfirmed",
      tier: r.confirmed ? "onchain-confirmed" : null,
      primary: null,
      secondary: null,
      match: { value: r.value, unit: r.unit, date: String(r.timestamp).slice(0, 10), topic: r.method === "baseFeePerGas" ? "base fee" : r.method === "gasLimit" ? "gas limit" : "USDC supply" },
      onchain: { value: r.value, unit: r.unit, block: r.block, chain: r.chain, nodes: r.nodes ?? [], observed_at: r.timestamp },
      evidence: (r.nodes ?? []).map((node: string) => ({ kind: "onchain" as const, chain: r.chain, block: r.block, block_timestamp: r.timestamp, method: r.method, ...(r.contract ? { contract: r.contract } : {}), value: r.value, unit: r.unit, node, retrieved_at: b.onchain.retrieved_at ?? fetchedAt })),
    });
  }
  const tooLong = (sn: any) => !!sn && String(sn.text).replace(/ …$/, "").length > QUOTE_CAP;
  const fromVerified = (text: string, ids: string[], by: string[] | undefined, contradicted: boolean, values?: string[]) => {
    // Quote cap (§1.2): a claim whose main quote is over 300 characters is left out of the contract view (not quoted).
    const ss = ids.map(snipById).filter(Boolean).filter((sn, i) => i === 0 || !tooLong(sn));
    if (!ss.length || tooLong(ss[0])) return;
    const primary = ev(ss[0]);
    const p0 = primary?.publisher;
    const sec = ss.slice(1).find((s) => { const u = urlOf(s); return u && pub(u) !== p0; });
    const secondary = sec ? ev(sec) : null;
    const pubConfirmed = !contradicted && !!by?.length && !!secondary;
    const official = !pubConfirmed && !contradicted && !!auth && !!primary && primary.url === auth.url && !!effectiveDate(text);
    add({
      text,
      status: pubConfirmed || official ? "confirmed" : "unconfirmed",
      tier: pubConfirmed ? "publisher-confirmed" : official ? "official" : null,
      primary,
      secondary: pubConfirmed ? secondary : null,
      match: pubConfirmed ? { value: values?.[0], topic: undefined } : official ? { date: effectiveDate(text), topic: auth.authority } : null,
      onchain: null,
      evidence: [...quoteItem(primary, official ? auth.url : undefined), ...(pubConfirmed ? quoteItem(secondary) : [])],
    });
  };
  for (const c of b?.claims ?? []) fromVerified(c.claim, c.snippets ?? [], c.confirmed_by, !!c.contradicted, c.confirmed_values);
  for (const l of b?.answer?.lines ?? []) if (l?.snippets?.length) fromVerified(l.text, l.snippets, l.confirmed_by, false);
  for (const c of b?.consistent ?? []) {
    const [s1, s2] = c.snippets ?? [];
    const p1 = ev(s1), p2 = ev(s2);
    add({ text: s1?.text ?? c.range, status: "consistent", tier: null, primary: p1, secondary: p2, match: { value: c.range }, onchain: null, evidence: [...quoteItem(p1), ...quoteItem(p2)] });
  }
  const kept = claims.slice(0, CONTRACT_MAX_CLAIMS);
  const counts = { confirmed: 0, consistent: 0, unconfirmed: 0 };
  const tiers = { "publisher-confirmed": 0, "onchain-confirmed": 0, official: 0 };
  for (const c of kept) {
    counts[c.status]++;
    if (c.tier) tiers[c.tier]++;
  }
  const answer = String(b?.answer?.lines?.[0]?.text ?? b?.onchain?.line ?? "").trim();
  if (!answer) reasons.push("no_answer");
  if (answer.split(/\s+/).length > 60) reasons.push("answer_over_60_words");
  if (kept.length < CONTRACT_MIN_CLAIMS) reasons.push("fewer_than_2_claims");
  if (counts.confirmed < CONTRACT_MIN_CONFIRMED) reasons.push(`confirmed_${counts.confirmed}_of_${CONTRACT_MIN_CONFIRMED}`);
  if (!verbatimOk) reasons.push("quote_not_verbatim_at_url");
  // Odin checklist 2: every claim must carry evidence; a confirmed claim needs two items (2 publishers / 2 nodes / authority + date).
  if (kept.some((c) => !c.evidence.length)) reasons.push("claim_missing_evidence");
  if (kept.some((c) => c.status === "confirmed" && c.tier !== "official" && c.evidence.length < 2)) reasons.push("confirmed_claim_missing_second_evidence");
  if (typeof b?.synthesis === "string" && !b.synthesis.startsWith("llm_selected_verified") && !b?.onchain) reasons.push(`synthesis_${b.synthesis}`);
  return { question: q, answer, status: reasons.length ? "fail" : "pass", fail_reasons: reasons, claims: kept, counts, tiers, method: CONTRACT_URL, meta: { version: "1", schema: BRIEF_SCHEMA_VERSION } };
}
