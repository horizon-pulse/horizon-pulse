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
};

export const SOURCE_INDEX: IndexType[] = [
  { id: "usdc_supply", label: "USDC supply (on-chain totalSupply)", match: [/\busdc\b/i, /\b(supply|circulation|circulating|outstanding|minted)\b/i], official: { authority: "Circle", domains: ["circle.com"] }, indexQuery: "USDC circulation supply Circle transparency", onchain: "usdc_supply" },
  { id: "usdc_base_cost", label: "Cost to send USDC on Base (on-chain gas read)", match: [/\busdc\b/i, /\bbase\b/i, /\b(cost|fee|fees|gas|cheap|price to send)\b/i], official: { authority: "Coinbase / Base", domains: ["docs.base.org", "base.org", "coinbase.com"] }, indexQuery: "Base network fees USDC transfer cost gas", onchain: "base_gas" },
  { id: "eth_gas", label: "Ethereum gas / base fee (on-chain)", match: [/\b(ethereum|eth|mainnet)\b/i, /\b(gas|base fee|basefee|gwei)\b/i], official: null, indexQuery: null, onchain: "eth_gas" },
  { id: "fed_rate", label: "Federal funds rate (Federal Reserve)", match: [/\b(federal funds|fed funds|fomc target|policy rate|interest on reserve)/i], official: { authority: "Federal Reserve", domains: ["federalreserve.gov"] }, indexQuery: "FOMC federal funds rate target range statement implementation note", onchain: null },
  { id: "sec_spot_btc_etf", label: "SEC spot bitcoin ETF approval (SEC)", match: [/\bsec\b|securities and exchange commission/i, /\bspot\b.*\bbitcoin\b.*\b(etf|etp|exchange-traded)/i], official: { authority: "U.S. SEC", domains: ["sec.gov"] }, indexQuery: "SEC approval spot bitcoin exchange-traded products January 2024 order", onchain: null },
  { id: "genius_act", label: "GENIUS Act (U.S. statute)", match: [/\bgenius act\b|guiding and establishing national innovation for u\.?s\.? stablecoins/i], official: { authority: "U.S. Government", domains: ["congress.gov", "treasury.gov", "whitehouse.gov"] }, indexQuery: "GENIUS Act payment stablecoin issuer requirements reserves S.1582", onchain: null },
  { id: "mica_stablecoins", label: "MiCA stablecoin rules (EU)", match: [/\bmica\b|markets in crypto-assets/i, /\b(stablecoin|e-money token|emt|art|asset-referenced|titles? iii|titles? iv|effect|apply|applies|application)\b/i], official: { authority: "European Union", domains: ["esma.europa.eu", "eur-lex.europa.eu", "eba.europa.eu", "finance.ec.europa.eu"] }, indexQuery: "MiCA Regulation (EU) 2023/1114 Titles III and IV apply 30 June 2024 stablecoins", onchain: null },
  { id: "eip", label: "Ethereum Improvement Proposals (EIPs)", match: [/\beip[- ]?\d{1,5}\b/i], official: { authority: "Ethereum EIPs", domains: ["eips.ethereum.org", "ethereum.org"] }, indexQuery: null, onchain: null },
  { id: "base_network", label: "Base network (Coinbase) facts", match: [/\bbase\b/i, /\b(coinbase|base network|base mainnet|base chain|layer[- ]?2|l2)\b/i], official: { authority: "Coinbase / Base", domains: ["base.org", "coinbase.com"] }, indexQuery: "Base network Coinbase mainnet launch announcement", onchain: null },
  { id: "x402", label: "x402 payment protocol", match: [/\bx402\b/i, /^\s*(what|how)\b/i], official: { authority: "x402 / Coinbase", domains: ["x402.org", "coinbase.com", "docs.cdp.coinbase.com"] }, indexQuery: "x402 HTTP 402 payment protocol Coinbase", onchain: null },
  { id: "circle_company", label: "Circle (company) facts", match: [/\bcircle\b/i, /\b(found|founded|founder|ceo|headquarter|ipo|listed)\w*/i], official: { authority: "Circle", domains: ["circle.com", "sec.gov"] }, indexQuery: "Circle Internet Group founded 2013 Jeremy Allaire Sean Neville", onchain: null },
  { id: "solana_finality", label: "Solana / Base finality", match: [/\bsolana\b/i, /\b(finality|confirmation|block time)\b/i], official: { authority: "Solana / Base docs", domains: ["solana.com", "docs.base.org"] }, indexQuery: "Solana transaction finality confirmation Base finality seconds", onchain: null },
];

/** Not briefs: recommendations, predictions, private persons. Refused unpaid even if a type matches. */
const OUT_OF_SCOPE = [
  { re: /\b(should i|should we|is it (a )?good (time )?to|buy|sell|invest in|worth buying|recommend)\b/i, reason: "recommendation" },
  { re: /\b(will|going to|next meeting|forecast|predict|expect(ed)? to)\b.*\?*$/i, reason: "prediction" },
  { re: /\b(where does .* live|home address|phone number|email of)\b/i, reason: "private_person" },
  { re: /\b(yesterday|this week|today'?s? (news|announcement)|right now|live order book)\b/i, reason: "breaking_or_live_market" },
];

export type Classified = { ok: true; type: IndexType } | { ok: false; reason: string; message: string };

let classifierOverride: ((q: string) => Classified) | null = null;
/** Test seam: legacy settle/redeem flow tests use arbitrary questions. */
export function setClassifierForTests(fn: ((q: string) => Classified) | null) {
  classifierOverride = fn;
}
export const TEST_GENERIC_TYPE: IndexType = { id: "test_generic", label: "test", match: [], official: null, indexQuery: null, onchain: null };
export function classifyQuestion(q: string): Classified {
  if (classifierOverride) return classifierOverride(q);
  const oos = OUT_OF_SCOPE.find((o) => o.re.test(q));
  if (oos) return { ok: false, reason: `out_of_scope:${oos.reason}`, message: "Verified briefs describe documented facts; they do not cover recommendations, predictions, private persons or breaking news. Nothing was charged." };
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
  return cachedIndex(key, now, async () => {
    const found = await parallelSearch(query, [query], 8, deadline, { includeDomains: t.official!.domains });
    const urls = [...new Set(found.map((r) => r.url))].filter((u) => !/\.pdf(\?|$)/i.test(u)).slice(0, INDEX_PAGES);
    if (!urls.length) return [];
    const ex = await parallelExtract(query, urls, deadline, true);
    return ex.map((r) => ({ ...r, publish_date: r.publish_date ?? found.find((f) => f.url === r.url)?.publish_date ?? null }));
  });
}
