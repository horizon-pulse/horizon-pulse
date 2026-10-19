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

import { DEMO_ROUTES } from "./demo-catalog";
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
  X402_CHECK_DEEP_PRICE_USD,
  X402_CHECK_DEEP_PRICE_ATOMIC,
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
  BALANCE_PRICE_USD,
  BALANCE_PRICE_ATOMIC,
  TX_GUARD_PRICE_USD,
  TX_GUARD_PRICE_ATOMIC,
  GROCERY_NORMALIZE_PRICE_USD,
  GROCERY_NORMALIZE_PRICE_ATOMIC,
  GROCERY_INGREDIENT_PRICE_USD,
  GROCERY_INGREDIENT_PRICE_ATOMIC,
  CHAIN_HEAD_PRICE_USD,
  CHAIN_HEAD_PRICE_ATOMIC,
  TOKEN_META_PRICE_USD,
  TOKEN_META_PRICE_ATOMIC,
  NAME_RESOLVE_PRICE_USD,
  NAME_RESOLVE_PRICE_ATOMIC,
  HTTP_PRICE_USD,
  HTTP_PRICE_ATOMIC,
  EXTRACT_PRICE_USD,
  EXTRACT_PRICE_ATOMIC,
  BATCH_PRICE_USD,
  BATCH_PRICE_ATOMIC,
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
    path: "/api/x402-check/deep?url=https://…",
    method: "GET",
    priceUsd: X402_CHECK_DEEP_PRICE_USD,
    priceAtomic: X402_CHECK_DEEP_PRICE_ATOMIC,
    summary:
      "Deep x402 endpoint check: the x402-check report plus TLS, security headers, CORS, payTo vs the payee's published addresses, lookalike payTo and drift vs well-known, openapi and CDP Bazaar listings (never pays)",
    category: "agent",
    blurb: "Live deep check of an x402 endpoint and its payTo",
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
    path: "/api/balance?evm=…[&solana=…][&xrpl=…]",
    method: "GET",
    priceUsd: BALANCE_PRICE_USD,
    priceAtomic: BALANCE_PRICE_ATOMIC,
    summary:
      "Can I pay right now: per rail (Base, Polygon, Solana, XRP Ledger) the stablecoin balance, gas/fee state incl. the XRPL reserve and RLUSD trust line, a yes/no and calls left at our live prices; no risk score, no USD valuation; public RPCs, read-only",
    category: "agent",
    blurb: "Can my wallet pay x402 calls right now (4 rails)",
  },
  {
    path: "/api/tx-guard?chain=…&to=…[&expected=…][&token=…]",
    method: "GET",
    priceUsd: TX_GUARD_PRICE_USD,
    priceAtomic: TX_GUARD_PRICE_ATOMIC,
    summary:
      "Mechanical pre-transfer recipient checks on Base, Polygon, Solana or the XRP Ledger: lookalike vs an expected address, OFAC SDN snapshot (source URL and pull date shown), account age, cited scam-token list; allow, warn or block per check",
    category: "agent",
    blurb: "Check a recipient address before sending (allow/warn/block)",
  },  {
    path: "/api/grocery/normalize",
    method: "GET|POST",
    priceUsd: GROCERY_NORMALIZE_PRICE_USD,
    priceAtomic: GROCERY_NORMALIZE_PRICE_ATOMIC,
    summary:
      "Recipe ingredient lines to a normalized shopping list: name, canonical id, quantity, unit, metric value, category, optional/to-taste flags, typical pack hint, scaled to target servings and merged; deterministic, no outbound calls, no prices",
    category: "agent",
    blurb: "Turn recipe ingredient lines into a normalized shopping list",
  },
  {
    path: "/api/grocery/ingredient",
    method: "GET|POST",
    priceUsd: GROCERY_INGREDIENT_PRICE_USD,
    priceAtomic: GROCERY_INGREDIENT_PRICE_ATOMIC,
    summary:
      "Ingredient name or canonical id and/or barcode to nutrition per 100 g: USDA FoodData Central matches (bundled snapshot, CC0) plus Open Food Facts barcode reads (ODbL), with per-match attribution, allergens null when unknown, Open Food Facts store names only; no prices, not dietary advice",
    category: "agent",
    blurb: "Look up nutrition per 100 g for an ingredient or barcode",
  },
  {
    path: "/api/chain/head?network=…",
    method: "GET",
    priceUsd: CHAIN_HEAD_PRICE_USD,
    priceAtomic: CHAIN_HEAD_PRICE_ATOMIC,
    summary:
      "Current chain tip for Base, Polygon, Ethereum, Solana and the XRP Ledger in one call: chain id, block/slot/ledger height, head time and age, finalized height and the gap; public RPCs, read-only",
    category: "agent",
    blurb: "Current block, slot or ledger height on 5 chains",
  },
  {
    path: "/api/token/meta?network=…&token=…",
    method: "GET",
    priceUsd: TOKEN_META_PRICE_USD,
    priceAtomic: TOKEN_META_PRICE_ATOMIC,
    summary:
      "Token metadata from chain state: ERC-20 name, symbol, decimals and supply (Base, Polygon, Ethereum); Solana mint decimals, supply and authorities; XRPL issued-currency supply, issuer flags and transfer fee; no price, no token-list check",
    category: "agent",
    blurb: "Token name, symbol, decimals and supply from chain state",
  },
  {
    path: "/api/name/resolve?name=…|address=…",
    method: "GET",
    priceUsd: NAME_RESOLVE_PRICE_USD,
    priceAtomic: NAME_RESOLVE_PRICE_ATOMIC,
    summary:
      "ENS and Basenames, on-chain: name to address, or address to ENS and Basename primary names checked forward; off-chain/wildcard (CCIP-Read) names are not followed",
    category: "agent",
    blurb: "Resolve an ENS name or Basename, or find an address's primary name",
  },
  {
    // Listed 2026-10-19 after the HP_BATCH_ENABLED flip (Odin GO 9:24 AM AST, Michael yes 9:17 AM AST).
    // $0.001 per item is allowed only inside a batch; the single-call floor stays $0.002.
    path: "/api/batch",
    method: "GET|POST",
    priceUsd: BATCH_PRICE_USD,
    priceAtomic: BATCH_PRICE_ATOMIC,
    summary:
      "Up to 10 chain checks for one payment ($0.01 per call): balance, gas, tx-status, token/meta, chain/head, name/resolve; same inputs as the single routes; charged once if at least one item succeeds",
    category: "agent",
    blurb: "Up to 10 chain checks (balance, gas, tx status, token, chain head, names) for one payment",
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
  "Six crypto routes frozen after first settlement (prices unchanged). Non-crypto LIVE: /api/fetch ($0.02 clean-text), /api/http ($0.01 universal proxy), /api/extract ($0.015 structured HTML), /api/x402-check ($0.01 x402 endpoint audit), /api/x402-check/deep ($0.03 deep x402 check: TLS, CORS, payTo vs published addresses, lookalike, discovery drift), /api/bazaar-check ($0.01 CDP Bazaar index check), /api/market/search ($0.005 marketplace search, untested price), /api/market/quote ($0.005 pre-pay quote, untested price), /api/screenshot ($0.02 headless render), /api/search ($0.03 search then fetch), /api/pdf ($0.02 PDF to text), /api/discourse/split ($0.03 online discourse sample, NOT a poll, untested price), /api/tx-status ($0.002 transaction status and finality on Base, Polygon, Solana and XRPL), /api/tokenized-stock ($0.002 tokenized-stock status check on Base, on-chain token state, no price, not investment advice), /api/watch ($0.002 changed-since-last-check for a public page or endpoint, short diff), /api/balance ($0.002 can-I-pay-now check per rail), /api/tx-guard ($0.002 mechanical pre-transfer recipient checks), /api/grocery/normalize ($0.002 recipe ingredient lines to a normalized shopping list, deterministic, no prices), /api/grocery/ingredient ($0.005 nutrition per 100 g from USDA FoodData Central and Open Food Facts, untested price), /api/chain/head ($0.002 chain tip on Base, Polygon, Ethereum, Solana and XRPL), /api/token/meta ($0.002 token metadata from chain state, no price), /api/name/resolve ($0.002 ENS and Basenames, on-chain only), /api/batch ($0.01 for up to 10 of balance, gas, tx-status, token/meta, chain/head and name/resolve in one call)." as const;

export const CATEGORY_LABELS: Record<LiveRoute["category"], string> = {
  crypto: "Crypto market data",
  web: "Web and documents",
  agent: "Agent utilities",
};

/**
 * Landing-page grouping (review round 6, 10/19): four honest groups for the homepage stats tile
 * and table. Separate from `category`, which drives OpenAPI tags and stays unchanged.
 * Every live route must sit in exactly one group (tests/site-round6.test.ts).
 */
export const SITE_GROUPS = [
  { key: "market", label: "Crypto market data", short: "market data", paths: ["/api/pulse", "/api/signals", "/api/yield", "/api/portfolio", "/api/gas", "/api/funding"] },
  { key: "onchain", label: "Onchain checks", short: "onchain", paths: ["/api/tx-status", "/api/balance", "/api/tx-guard", "/api/chain/head", "/api/token/meta", "/api/name/resolve", "/api/tokenized-stock", "/api/batch"] },
  { key: "x402", label: "x402 tools", short: "x402 tools", paths: ["/api/x402-check", "/api/x402-check/deep", "/api/bazaar-check", "/api/market/search", "/api/market/quote"] },
  { key: "web", label: "Web, documents and everyday data", short: "web and everyday", paths: ["/api/fetch", "/api/http", "/api/extract", "/api/screenshot", "/api/search", "/api/pdf", "/api/watch", "/api/grocery/normalize", "/api/grocery/ingredient", "/api/discourse/split"] },
] as const;

/** Route name used by /api/demo/<name>, derived from the display path. */
/** Real request path (no query), same string /.well-known/x402 lists. Always display this, never `/api/${routeName(r)}`. */
export const routePath = (r: LiveRoute) => r.path.replace(/\?.*$/, "");
/** Demo slug / anchor id: nested paths join with "-" (/api/market/search -> market-search). Not a route path. */
export const routeName = (r: LiveRoute) => r.path.replace(/^\/api\//, "").replace(/\?.*$/, "").replace(/\//g, "-");

const DEMO_SLUGS = new Set(DEMO_ROUTES.map((d) => d.route));
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
    postRoutes: LIVE_PAID_ROUTES.filter((r) => r.method === "GET|POST").length,
    demoTwins: LIVE_PAID_ROUTES.filter((r) => DEMO_SLUGS.has(routeName(r))).length,
    noDemo: LIVE_PAID_ROUTES.filter((r) => !DEMO_SLUGS.has(routeName(r))).map(routePath),
    bySiteGroup: SITE_GROUPS.map((g) => ({
      category: g.key,
      label: g.label,
      short: g.short,
      routes: LIVE_PAID_ROUTES.filter((r) => (g.paths as readonly string[]).includes(routePath(r))),
    })),
    byCategory: (Object.keys(CATEGORY_LABELS) as LiveRoute["category"][]).map((c) => ({
      category: c,
      label: CATEGORY_LABELS[c],
      routes: LIVE_PAID_ROUTES.filter((r) => r.category === c),
    })),
  };
}
