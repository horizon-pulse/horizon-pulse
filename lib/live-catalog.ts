/**
 * Single source of truth for the live paid catalog.
 *
 * Six crypto routes remain FROZEN (prices/behavior unchanged after first
 * settlement). Non-crypto LIVE: /api/fetch ($0.02 clean-text) and
 * /api/http ($0.01 universal proxy, volume-priced).
 *
 * Public host: https://horizonpulse.dev (canonical).
 * Catalog paths, prices, and payTo are unchanged by host updates.
 */

import {
  PULSE_PRICE_USD,
  PULSE_PRICE_ATOMIC,
  SIGNALS_PRICE_USD,
  SIGNALS_PRICE_ATOMIC,
  YIELD_PRICE_USD,
  YIELD_PRICE_ATOMIC,
  PORTFOLIO_PRICE_USD,
  PORTFOLIO_PRICE_ATOMIC,
  GAS_PRICE_USD,
  GAS_PRICE_ATOMIC,
  FUNDING_PRICE_USD,
  FUNDING_PRICE_ATOMIC,
  FETCH_PRICE_USD,
  FETCH_PRICE_ATOMIC,
  SCREENSHOT_PRICE_USD,
  SCREENSHOT_PRICE_ATOMIC,
  X402_CHECK_PRICE_USD,
  X402_CHECK_PRICE_ATOMIC,
  BAZAAR_CHECK_PRICE_USD,
  BAZAAR_CHECK_PRICE_ATOMIC,
  MARKET_SEARCH_PRICE_USD,
  MARKET_SEARCH_PRICE_ATOMIC,
  MARKET_QUOTE_PRICE_USD,
  MARKET_QUOTE_PRICE_ATOMIC,
  SEARCH_PRICE_USD,
  SEARCH_PRICE_ATOMIC,
  PDF_PRICE_USD,
  PDF_PRICE_ATOMIC,
  DISCOURSE_SPLIT_PRICE_USD,
  DISCOURSE_SPLIT_PRICE_ATOMIC,
  TX_STATUS_PRICE_USD,
  TX_STATUS_PRICE_ATOMIC,
  TOKENIZED_STOCK_PRICE_USD,
  TOKENIZED_STOCK_PRICE_ATOMIC,
  WATCH_PRICE_USD,
  WATCH_PRICE_ATOMIC,
  HTTP_PRICE_USD,
  HTTP_PRICE_ATOMIC,
  EXTRACT_PRICE_USD,
  EXTRACT_PRICE_ATOMIC,
} from "./config";

export type LiveRoute = {
  path: string;
  /** Display method(s); http is GET|POST at the same price */
  method: "GET" | "GET|POST";
  priceUsd: string;
  priceAtomic: string;
  /** Short agent-facing summary */
  summary: string;
  /**
   * Blurb for docs surfaces (OpenAPI summary, skill.md, /agents, /status) when the
   * landing blurb is held for the site refresh (site/refresh-2026-10-07). Falls back to blurb.
   */
  docBlurb?: string;
  /** Landing-page grouping */
  category: "crypto" | "web" | "agent";
  /** One-line landing-page description */
  blurb: string;
  /** Set on routes whose price has not been tested against demand yet (plan D10). */
  priceStatus?: "untested";
};

/** Live paid routes. Crypto six frozen; fetch + http + extract are non-crypto LIVE. */
export const LIVE_PAID_ROUTES: readonly LiveRoute[] = [
  {
    path: "/api/pulse",
    method: "GET",
    priceUsd: PULSE_PRICE_USD,
    priceAtomic: PULSE_PRICE_ATOMIC,
    summary: "BTC/ETH/SOL spot + momentum (Coinbase Exchange, CoinGecko fallback)",
    category: "crypto",
    // Landing blurb held for the site refresh; docs surfaces use docBlurb.
    blurb: "BTC, ETH and SOL spot prices with 24h momentum (CoinGecko)",
    docBlurb: "BTC, ETH and SOL spot prices with 24h momentum (Coinbase Exchange, CoinGecko fallback)",
  },
  {
    path: "/api/signals",
    method: "GET",
    priceUsd: SIGNALS_PRICE_USD,
    priceAtomic: SIGNALS_PRICE_ATOMIC,
    summary: "RSI/MACD/Bollinger + OKX funding",
    category: "crypto",
    blurb: "RSI, MACD and Bollinger bands plus perpetual funding (CoinGecko, OKX)",
  },
  {
    path: "/api/yield",
    method: "GET",
    priceUsd: YIELD_PRICE_USD,
    priceAtomic: YIELD_PRICE_ATOMIC,
    summary: "DefiLlama yields (TVL ≥ $10M, prefer stablecoin/single-asset)",
    category: "crypto",
    blurb: "Ranked DeFi yields, pools with TVL of $10M or more (DefiLlama)",
  },
  {
    path: "/api/portfolio?address=0x…",
    method: "GET",
    priceUsd: PORTFOLIO_PRICE_USD,
    priceAtomic: PORTFOLIO_PRICE_ATOMIC,
    summary: "Base + Ethereum balances, concentration score, rule findings vs fixed thresholds",
    category: "crypto",
    blurb: "Base and Ethereum balances, concentration score and rule findings vs fixed thresholds (not financial advice)",
  },
  {
    path: "/api/gas",
    method: "GET",
    priceUsd: GAS_PRICE_USD,
    priceAtomic: GAS_PRICE_ATOMIC,
    summary: "Base + Ethereum baseFee / priority / suggested maxFee + timingHint",
    category: "crypto",
    blurb: "Base and Ethereum fees with a suggested max fee (public RPC)",
  },
  {
    path: "/api/funding",
    method: "GET",
    priceUsd: FUNDING_PRICE_USD,
    priceAtomic: FUNDING_PRICE_ATOMIC,
    summary: "OKX BTC/ETH/SOL perpetual funding + crowding hint",
    category: "crypto",
    blurb: "BTC, ETH and SOL perpetual funding with a crowding hint (OKX)",
  },
  {
    path: "/api/fetch?url=https://…",
    method: "GET",
    priceUsd: FETCH_PRICE_USD,
    priceAtomic: FETCH_PRICE_ATOMIC,
    summary:
      "Fetch public http(s) URL → clean text/markdown (SSRF-safe, ~200KB / 8s caps)",
    category: "web",
    blurb: "Any public URL as clean text or markdown",
  },
  {
    path: "/api/http",
    method: "GET|POST",
    priceUsd: HTTP_PRICE_USD,
    priceAtomic: HTTP_PRICE_ATOMIC,
    summary:
      "Universal agent HTTP proxy (url/method/headers/body) → status + filtered headers + body (SSRF-safe; $0.01 volume price)",
    category: "web",
    blurb: "Universal HTTP proxy: your method, headers and body",
  },
  {
    path: "/api/extract",
    method: "GET|POST",
    priceUsd: EXTRACT_PRICE_USD,
    priceAtomic: EXTRACT_PRICE_ATOMIC,
    summary:
      "URL or HTML → structured fields (title, description, links, images, headings, json-ld, text sample); SSRF-safe; $0.015",
    category: "web",
    blurb: "Page to structured fields, or your own CSS selectors",
  },
  {
    path: "/api/x402-check?url=https://…",
    method: "GET",
    priceUsd: X402_CHECK_PRICE_USD,
    priceAtomic: X402_CHECK_PRICE_ATOMIC,
    summary:
      "Audit any x402 endpoint: 402 validity, v1/v2, decoded price, payTo EOA vs contract, discovery hints (never pays)",
    category: "agent",
    blurb: "Audit any x402 endpoint without paying it",
  },
  {
    path: "/api/bazaar-check?url=…",
    method: "GET",
    priceUsd: BAZAAR_CHECK_PRICE_USD,
    priceAtomic: BAZAAR_CHECK_PRICE_ATOMIC,
    summary:
      "Is an x402 seller indexed in CDP Bazaar, and if not, why: per-route index status + networks (Base, Solana) and lint findings with fixes (never pays)",
    category: "agent",
    blurb: "Check whether an x402 seller is listed in CDP Bazaar, and why not",
  },
  {
    path: "/api/market/search?q=…",
    method: "GET",
    priceUsd: MARKET_SEARCH_PRICE_USD,
    priceAtomic: MARKET_SEARCH_PRICE_ATOMIC,
    summary:
      "Agent marketplace search: x402 offers from CDP Bazaar ranked (no paid placement), top 3 re-checked live, payTo cross-checked with the index, direct-pay buy plans (never pays)",
    category: "agent",
    blurb: "Find a paid x402 API for a task, re-checked live",
    priceStatus: "untested",
  },
  {
    path: "/api/market/quote?url=https://…",
    method: "GET",
    priceUsd: MARKET_QUOTE_PRICE_USD,
    priceAtomic: MARKET_QUOTE_PRICE_ATOMIC,
    summary:
      "Pre-pay quote for one x402 resource: live terms per network (Base, Solana), CDP Bazaar entry, payTo cross-check and a pay/caution/avoid verdict (never pays)",
    category: "agent",
    blurb: "Check an x402 seller's live price and payTo before paying",
    priceStatus: "untested",
  },
  {
    path: "/api/tx-status?tx=…&network=…",
    method: "GET",
    priceUsd: TX_STATUS_PRICE_USD,
    priceAtomic: TX_STATUS_PRICE_ATOMIC,
    summary:
      "Did a transaction land, and is it final: status (not_found/pending/confirmed/failed), final flag, confirmations, fee and decoded token transfers on Base, Polygon, Solana or XRPL; public RPCs, read-only",
    category: "agent",
    blurb: "Did my transaction land, and is it final (4 chains)",
  },
  {
    path: "/api/tokenized-stock?symbol=…",
    method: "GET",
    priceUsd: TOKENIZED_STOCK_PRICE_USD,
    priceAtomic: TOKENIZED_STOCK_PRICE_ATOMIC,
    summary:
      "Status check of Coinbase tokenized stocks on Base (AAPLc, NVDAc, TSLAc…): paused flags, supply, supply cap, multiplier, issuer and token address; on-chain token state only, no price; not investment advice",
    category: "crypto",
    blurb: "Tokenized stock status check on Base (on-chain, no price)",
  },
  {
    path: "/api/watch?url=…[&since=…]",
    method: "GET",
    priceUsd: WATCH_PRICE_USD,
    priceAtomic: WATCH_PRICE_ATOMIC,
    summary:
      "Has a public page or endpoint changed since your last check: pass back the state token as since; returns changed true/false and, when changed, only the added lines plus added/removed counts. Stateless, SSRF-guarded like /api/fetch",
    category: "agent",
    blurb: "Did this page or endpoint change since my last check",
  },
  {
    path: "/api/discourse/split?q=…",
    method: "GET",
    priceUsd: DISCOURSE_SPLIT_PRICE_USD,
    priceAtomic: DISCOURSE_SPLIT_PRICE_ATOMIC,
    summary:
      "Online discourse sample, NOT a poll: how public Hacker News and Bluesky posts split on a question, per-side share with 95% interval, counts and links only (no text or usernames; Bluesky links include the account's public ID, DID); <30 decided posts not charged",
    category: "agent",
    blurb: "How Hacker News and Bluesky posts split on a question (not a poll)",
    priceStatus: "untested",
  },
  {
    path: "/api/screenshot?url=https://…",
    method: "GET",
    priceUsd: SCREENSHOT_PRICE_USD,
    priceAtomic: SCREENSHOT_PRICE_ATOMIC,
    summary:
      "Headless Chromium render → PNG/JPEG (base64 JSON), viewport/fullPage options; SSRF-safe on every sub-request",
    category: "web",
    blurb: "Headless Chromium render to PNG or JPEG",
  },
  {
    path: "/api/search?q=…&n=3",
    method: "GET",
    priceUsd: SEARCH_PRICE_USD,
    priceAtomic: SEARCH_PRICE_ATOMIC,
    summary:
      "Web search → top 1-5 pages as clean markdown with sources (web results via Serper; SSRF-safe fetch; partial results on page errors)",
    category: "web",
    blurb: "Web search with the top pages as clean text and sources",
  },
  {
    path: "/api/pdf?url=…",
    method: "GET",
    priceUsd: PDF_PRICE_USD,
    priceAtomic: PDF_PRICE_ATOMIC,
    summary:
      "PDF URL → clean text per page + title/author metadata (text layer, no OCR; 10MB / 50 pages; unbilled on non-PDF, encrypted or image-only)",
    category: "web",
    blurb: "PDF URL to text per page plus metadata",
  },
] as const;

/** First on-chain settle (pulse $0.005). Crypto catalog frozen thereafter. */
export const FIRST_SETTLE = {
  /** Truncated Base tx hash — do not invent a full hash */
  txTruncated: "0xedbd1a51…",
  amountUsd: "$0.005",
  route: "/api/pulse",
} as const;

export const CATALOG_NOTE =
  "Six crypto routes frozen after first settlement (prices unchanged). Non-crypto LIVE: /api/fetch ($0.02 clean-text), /api/http ($0.01 universal proxy), /api/extract ($0.015 structured HTML), /api/x402-check ($0.01 x402 endpoint audit), /api/bazaar-check ($0.01 CDP Bazaar index check), /api/market/search ($0.005 marketplace search, untested price), /api/market/quote ($0.005 pre-pay quote, untested price), /api/screenshot ($0.02 headless render), /api/search ($0.03 search then fetch), /api/pdf ($0.02 PDF to text), /api/discourse/split ($0.03 online discourse sample, NOT a poll, untested price), /api/tx-status ($0.002 transaction status and finality on Base, Polygon, Solana and XRPL), /api/tokenized-stock ($0.002 tokenized-stock status check on Base, on-chain token state, no price, not investment advice), /api/watch ($0.002 changed-since-last-check for a public page or endpoint, short diff)." as const;

export const CATEGORY_LABELS: Record<LiveRoute["category"], string> = {
  crypto: "Crypto market data",
  web: "Web and documents",
  agent: "Agent utilities",
};

/** Route name used by /api/demo/<name>, derived from the display path. */
export const routeName = (r: LiveRoute) => r.path.replace(/^\/api\//, "").replace(/\?.*$/, "").replace(/\//g, "-");

const usd = (p: string) => Number(p.replace(/[^0-9.]/g, ""));
/** Catalog-derived stats (never hardcoded). */
export function catalogStats() {
  const prices = LIVE_PAID_ROUTES.map((r) => usd(r.priceUsd));
  const fmt = (n: number) => `$${n}`;
  return {
    routes: LIVE_PAID_ROUTES.length,
    endpoints: LIVE_PAID_ROUTES.reduce((n, r) => n + (r.method === "GET|POST" ? 2 : 1), 0),
    minPrice: fmt(Math.min(...prices)),
    maxPrice: fmt(Math.max(...prices)),
    byCategory: (Object.keys(CATEGORY_LABELS) as LiveRoute["category"][]).map((c) => ({
      category: c,
      label: CATEGORY_LABELS[c],
      routes: LIVE_PAID_ROUTES.filter((r) => r.category === c),
    })),
  };
}
