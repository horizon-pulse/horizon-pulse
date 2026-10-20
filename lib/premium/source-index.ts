/**
 * Odin ruling (c), 10/19 11:27 PM: narrow scope. A brief is accepted only for question types this curated index can
 * confirm (official publishers and/or on-chain reads). Everything else is refused unpaid, before any payment step.
 * Rule-based (no model), deterministic.
 */
import type { OnchainTopic } from "./onchain";

export type IndexType = {
  id: string;
  /** All must match (case-insensitive). */
  match: RegExp[];
  label: string;
  /** Issuing authority / official publisher domains (Parallel source_policy.include_domains), same owner = one authority. */
  official: { authority: string; domains: string[] } | null;
  /** Objective + queries for the official-only search (cached 1 h per type, not per question). */
  indexQuery: string | null;
  onchain: OnchainTopic | null;
  /** Open-web search + extract (publisher pairs). Off for on-chain types: the chain is the source of record. */
  web: boolean;
  /** Curated fixed document list (fetched instead of an official-domain search). */
  urls?: string[];
  /** Undated specification documents: official pairs need no effective date (published in the contract). */
  undated?: boolean;
};

// Odin ruling 11:40 PM: launch narrow - on-chain live values + x402 spec facts ONLY.
export const SOURCE_INDEX: IndexType[] = [
  { id: "base_gas", label: "Base network gas / fees (on-chain read)", match: [/\bbase\b/i, /\b(gas|fee|fees|gwei|gas limit)\b/i], official: null, indexQuery: null, onchain: "base_gas", web: false },
  { id: "eth_gas", label: "Ethereum mainnet gas / base fee / gas limit (on-chain read)", match: [/\b(ethereum|eth)\b|(?<!\bbase )\bmainnet\b/i, /\b(gas|fee|fees|base fee|basefee|gwei|gas limit)\b/i], official: null, indexQuery: null, onchain: "eth_gas", web: false },
  { id: "usdc_supply", label: "USDC supply on Ethereum and Base (on-chain totalSupply)", match: [/\busdc\b/i, /\b(supply|circulation|circulating|outstanding|minted|exists?|issued)\b/i], official: null, indexQuery: null, onchain: "usdc_supply", web: false },
  { id: "x402", label: "x402 payment protocol (specification facts)", match: [/\bx402\b/i, /^\s*(what|how|which)\b|\b(headers?|status( code)?|402|schemes?|payment-required|payment-signature|payment-response)\b/i], official: { authority: "x402 specification publishers (x402.org, Coinbase developer docs)", domains: ["x402.org", "docs.x402.org", "coinbase.com", "docs.cdp.coinbase.com", "github.com"] }, indexQuery: null, onchain: null, web: true, undated: true,
    urls: [
      "https://docs.x402.org/introduction",
      "https://docs.x402.org/core-concepts/http-402",
      "https://docs.x402.org/core-concepts/facilitator",
      "https://docs.x402.org/core-concepts/client-server",
      "https://docs.cdp.coinbase.com/x402/welcome",
      "https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works",
      "https://docs.cdp.coinbase.com/x402/core-concepts/facilitator",
      "https://github.com/coinbase/x402",
      "https://www.x402.org/",
      // Independent ecosystem publishers' own x402 docs (not mirrors or forks of the spec repo); re-read 10/20 12:30 AM.
      "https://developers.cloudflare.com/agents/agentic-payments/x402/",
      "https://agentic-docs.polygon.technology/general/x402/guides/how-it-works",
      "https://solana.com/docs/tools/x402-facilitator",
      "https://docs.celo.org/build/agents/x402",
      "https://developers.fireblocks.com/docs/x402-facilitator-overview",
      "https://developers.stellar.org/docs/build/agentic-payments/x402",
      "https://www.quicknode.com/docs/build-with-ai/x402-payments",
    ] },
];
/** Published in the contract: what verified briefs do NOT cover (refused unpaid, before payment). */
export const OUT_OF_SCOPE_CATEGORIES = [
  "anything other than on-chain live values (Ethereum and Base gas, base fee, gas limit; USDC supply on Ethereum and Base) and x402 specification facts",
  "statutes, regulations and other legal questions",
  "prices, market data and order books",
  "recommendations (buy, sell, hold, invest)",
  "predictions and forecasts",
  "private individuals and personal data",
  "breaking news",
  "definitions of an x402 facilitator (what a facilitator is)",
];

/** Not briefs: recommendations, predictions, private persons. Refused unpaid even if a type matches. */
const OUT_OF_SCOPE = [
  { re: /\b(should i|should we|is it (a )?good (time )?to|buy|sell|invest in|worth buying|recommend)\b/i, reason: "recommendation" },
  { re: /\b(act|statute|law|legal|regulation|regulatory|mica|sec|compliance|lawful|illegal)\b/i, reason: "legal_or_statute" },
  { re: /\b(price of|price today|order book|market cap|tvl)\b/i, reason: "market_data" },
  { re: /\b(will|going to|next meeting|forecast|predict|expect(ed)? to)\b.*\?*$/i, reason: "prediction" },
  { re: /\b(where does .* live|home address|phone number|email of)\b/i, reason: "private_person" },
  // Odin ruling A (10/19): no two independent, non-mirrored sources state the same facilitator definition, so it is refused, not answered.
  { re: /\b(what(?:'s| is| are| does)\s+(?:an?\s+|the\s+)?(?:x402\s+)?facilitators?(?:\s+(?:mean|do))?\b|defin\w*\s+(?:of\s+)?(?:an?\s+|the\s+)?(?:x402\s+)?facilitator|facilitators?\s+(?:mean|definition))/i, reason: "facilitator_definition" },
  // Sentinel LOW-6: "how does/do (an) x402 facilitator(s) work / operate / function", "how is a facilitator used", "explain facilitators".
  { re: /\b(how\s+(?:does|do|is|are)\s+(?:an?\s+|the\s+)?(?:x402\s+)?facilitators?\b|(?:explain|describe)\s+(?:an?\s+|the\s+)?(?:x402\s+)?facilitators?\b|role\s+of\s+(?:an?\s+|the\s+)?(?:x402\s+)?facilitators?\b)/i, reason: "facilitator_definition" },
  { re: /\b(yesterday|this week|today'?s? (news|announcement)|breaking)\b/i, reason: "breaking_news" },
];

export type Classified = { ok: true; type: IndexType } | { ok: false; reason: string; message: string };

let classifierOverride: ((q: string) => Classified) | null = null;
/** Test seam: legacy settle/redeem flow tests use arbitrary questions. */
export function setClassifierForTests(fn: ((q: string) => Classified) | null) {
  classifierOverride = fn;
}
export const TEST_GENERIC_TYPE: IndexType = { id: "test_generic", label: "test", match: [], official: null, indexQuery: null, onchain: null, web: true };
/** Round 7: optional ?type= bypasses the phrase rules (never the out-of-scope refusals). */
export const BRIEF_TYPE_PARAM: Record<string, string> = { base_gas: "base_gas", eth_gas: "eth_gas", usdc_supply: "usdc_supply", x402_spec: "x402" };
export const BRIEF_TYPE_VALUES = Object.keys(BRIEF_TYPE_PARAM);
const TYPE_PREFIX = /^\[type:([a-z0-9_]+)\]\s*/;
/** The handler binds an explicit type into the paid input as "[type:x] q", so the type is part of what is signed for. */
export function withTypePrefix(q: string, type: string | null): string { return type ? `[type:${type}] ${q}` : q; }
export function stripTypePrefix(input: string): { q: string; type: string | null } {
  const m = input.match(TYPE_PREFIX);
  return m ? { q: input.slice(m[0].length), type: m[1] } : { q: input, type: null };
}
/** Three example questions per type, published in the 422 and on the contract page. */
export const BRIEF_EXAMPLES: Record<string, string[]> = {
  base_gas: ["Base gas price", "What is the base fee on Base right now?", "Current gas fees on Base network"],
  eth_gas: ["Ethereum gas price now", "Ethereum mainnet base fee", "What is the gas limit on Ethereum?"],
  usdc_supply: ["How much USDC is in circulation", "What is the total supply of USDC on Base?", "USDC supply on Ethereum"],
  x402_spec: ["What is x402?", "Which HTTP status code does x402 use?", "x402 PAYMENT-REQUIRED header"],
};
export const EXAMPLES_LINE = Object.entries(BRIEF_EXAMPLES).map(([k, v]) => `${k}: ${v.map((e) => `"${e}"`).join(", ")}`).join("; ");

export function classifyQuestion(input: string): Classified {
  if (classifierOverride) return classifierOverride(input);
  const { q, type } = stripTypePrefix(input);
  const oos = OUT_OF_SCOPE.find((o) => o.re.test(q));
  if (oos) return { ok: false, reason: `out_of_scope:${oos.reason}`, message: `Out of scope (${oos.reason}). Verified briefs cover only on-chain live values and x402 specification facts. Nothing was charged.` };
  if (type) {
    const t = SOURCE_INDEX.find((x) => x.id === BRIEF_TYPE_PARAM[type]);
    if (t) return { ok: true, type: t };
  }
  // "base fee" names a field, not the Base chain: Ethereum wins whenever it is named; Base must be named outside "base fee".
  const baseNamed = /\bbase\b/i.test(q.replace(/\bbase ?fee\b/gi, ""));
  const t = SOURCE_INDEX.find((x) => x.match.every((r) => r.test(q)) && (x.id !== "base_gas" || (baseNamed && !SOURCE_INDEX[1].match[0].test(q))));
  if (!t) return { ok: false, reason: "unsupported_question_type", message: `Verified briefs currently cover only: ${SOURCE_INDEX.map((x) => x.label).join("; ")}. Examples: ${EXAMPLES_LINE}. Or pass type=${BRIEF_TYPE_VALUES.join("|")}. Nothing was charged.` };
  return { ok: true, type: t };
}

/** 1 h in-process cache of official-source pages per index type (not per question). */
const TTL_MS = 3600_000;
const cache = new Map<string, { at: number; v: unknown }>();
export async function cachedIndex<T>(id: string, now: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(id);
  if (hit && now - hit.at < TTL_MS) return hit.v as T;
  const v = await load();
  cache.set(id, { at: now, v });
  return v;
}
export function resetIndexCacheForTests() {
  cache.clear();
}

import { parallelExtract, parallelSearch, type ParallelResult } from "./parallel";
export const INDEX_PAGES = 3;
/** Official-source pages for a type: Parallel search limited to the authority's domains, top distinct URLs extracted. */
export async function fetchIndexPages(t: IndexType, q: string, deadline: number, now: number = Date.now()): Promise<ParallelResult[]> {
  if (!t.official) return [];
  const eip = q.match(/\beip[- ]?(\d{1,5})\b/i)?.[1];
  const query = t.indexQuery ?? (eip ? `EIP-${eip}` : q);
  const key = eip ? `${t.id}:${eip}` : t.id;
  const stamp = (rs: ParallelResult[]) => { const at = new Date().toISOString(); return rs.map((r) => ({ ...r, fetched_at: r.fetched_at ?? at })); };
  if (t.urls?.length) return cachedIndex(t.id, now, async () => stamp(await parallelExtract(t.label, t.urls!, deadline, true)));
  return cachedIndex(key, now, async () => {
    const found = await parallelSearch(query, [query], 8, deadline, { includeDomains: t.official!.domains });
    const urls = [...new Set(found.map((r) => r.url))].filter((u) => !/\.pdf(\?|$)/i.test(u)).slice(0, INDEX_PAGES);
    if (!urls.length) return [];
    const ex = await parallelExtract(query, urls, deadline, true);
    return stamp(ex).map((r) => ({ ...r, publish_date: r.publish_date ?? found.find((f) => f.url === r.url)?.publish_date ?? null }));
  });
}
