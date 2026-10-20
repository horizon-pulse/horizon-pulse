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
  { id: "base_gas", label: "Base network gas / fees (on-chain read)", match: [/\b(on|the) base\b|\bbase (network|chain|l2|mainnet)\b/i, /\b(gas|fee|fees|gwei|cost|gas limit)\b/i], official: null, indexQuery: null, onchain: "base_gas", web: false },
  { id: "eth_gas", label: "Ethereum mainnet gas / base fee / gas limit (on-chain read)", match: [/\b(ethereum|eth|mainnet)\b/i, /\b(gas|base fee|basefee|gwei|gas limit)\b/i], official: null, indexQuery: null, onchain: "eth_gas", web: false },
  { id: "usdc_supply", label: "USDC supply on Ethereum and Base (on-chain totalSupply)", match: [/\busdc\b/i, /\b(supply|circulation|circulating|outstanding|minted|exists?|issued)\b/i], official: null, indexQuery: null, onchain: "usdc_supply", web: false },
  { id: "x402", label: "x402 payment protocol (specification facts)", match: [/\bx402\b/i, /^\s*(what|how|which)\b/i], official: { authority: "x402 specification publishers (x402.org, Coinbase developer docs)", domains: ["x402.org", "docs.x402.org", "coinbase.com", "docs.cdp.coinbase.com", "github.com"] }, indexQuery: null, onchain: null, web: true, undated: true,
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
];

/** Not briefs: recommendations, predictions, private persons. Refused unpaid even if a type matches. */
const OUT_OF_SCOPE = [
  { re: /\b(should i|should we|is it (a )?good (time )?to|buy|sell|invest in|worth buying|recommend)\b/i, reason: "recommendation" },
  { re: /\b(act|statute|law|legal|regulation|regulatory|mica|sec|compliance|lawful|illegal)\b/i, reason: "legal_or_statute" },
  { re: /\b(price of|price today|order book|market cap|tvl)\b/i, reason: "market_data" },
  { re: /\b(will|going to|next meeting|forecast|predict|expect(ed)? to)\b.*\?*$/i, reason: "prediction" },
  { re: /\b(where does .* live|home address|phone number|email of)\b/i, reason: "private_person" },
  { re: /\b(yesterday|this week|today'?s? (news|announcement)|breaking)\b/i, reason: "breaking_news" },
];

export type Classified = { ok: true; type: IndexType } | { ok: false; reason: string; message: string };

let classifierOverride: ((q: string) => Classified) | null = null;
/** Test seam: legacy settle/redeem flow tests use arbitrary questions. */
export function setClassifierForTests(fn: ((q: string) => Classified) | null) {
  classifierOverride = fn;
}
export const TEST_GENERIC_TYPE: IndexType = { id: "test_generic", label: "test", match: [], official: null, indexQuery: null, onchain: null, web: true };
export function classifyQuestion(q: string): Classified {
  if (classifierOverride) return classifierOverride(q);
  const oos = OUT_OF_SCOPE.find((o) => o.re.test(q));
  if (oos) return { ok: false, reason: `out_of_scope:${oos.reason}`, message: `Out of scope (${oos.reason}). Verified briefs cover only on-chain live values and x402 specification facts. Nothing was charged.` };
  const t = SOURCE_INDEX.find((x) => x.match.every((r) => r.test(q)));
  if (!t) return { ok: false, reason: "unsupported_question_type", message: `Verified briefs currently cover only: ${SOURCE_INDEX.map((x) => x.label).join("; ")}. Nothing was charged.` };
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
  if (t.urls?.length) return cachedIndex(t.id, now, async () => parallelExtract(t.label, t.urls!, deadline, true));
  return cachedIndex(key, now, async () => {
    const found = await parallelSearch(query, [query], 8, deadline, { includeDomains: t.official!.domains });
    const urls = [...new Set(found.map((r) => r.url))].filter((u) => !/\.pdf(\?|$)/i.test(u)).slice(0, INDEX_PAGES);
    if (!urls.length) return [];
    const ex = await parallelExtract(query, urls, deadline, true);
    return ex.map((r) => ({ ...r, publish_date: r.publish_date ?? found.find((f) => f.url === r.url)?.publish_date ?? null }));
  });
}
