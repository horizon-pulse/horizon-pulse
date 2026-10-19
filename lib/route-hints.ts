/**
 * Free "related routes / try next" hints (repeat-caller growth plan, Michael
 * 10/17 9:02 AM ET "lets implement that now"; Class A to Odin before ship).
 *
 * On a SETTLED 2xx JSON object response (settle header present), the paid
 * body gains one extra top-level key, `relatedRoutes`, listing 2-3 related
 * paid routes with their CURRENT prices (read from lib/config.ts, never
 * typed). The hint is informational and free: it does not change the price,
 * payTo, rail, settle flow or any existing field. The original body bytes
 * are kept verbatim; the key is spliced in before the final "}" so no number
 * is re-serialized.
 *
 * NOT added to: unpaid 402 bodies / PAYMENT-REQUIRED (would change the x402
 * challenge bytes and the 402 parity goldens), HEAD, errors, non-JSON bodies
 * (pdf, screenshot), JSON arrays, or a body that already has the key.
 * The same map is published free at /.well-known/related-routes.
 */
import {
  BALANCE_PRICE_USD,
  BATCH_PRICE_USD,
  BAZAAR_CHECK_PRICE_USD,
  CHAIN_HEAD_PRICE_USD,
  DISCOURSE_SPLIT_PRICE_USD,
  EXTRACT_PRICE_USD,
  FETCH_PRICE_USD,
  FUNDING_PRICE_USD,
  GAS_PRICE_USD,
  GROCERY_INGREDIENT_PRICE_USD,
  GROCERY_NORMALIZE_PRICE_USD,
  HTTP_PRICE_USD,
  MARKET_QUOTE_PRICE_USD,
  MARKET_SEARCH_PRICE_USD,
  NAME_RESOLVE_PRICE_USD,
  PDF_PRICE_USD,
  PORTFOLIO_PRICE_USD,
  PULSE_PRICE_USD,
  SCREENSHOT_PRICE_USD,
  SEARCH_PRICE_USD,
  SIGNALS_PRICE_USD,
  TOKEN_META_PRICE_USD,
  TOKENIZED_STOCK_PRICE_USD,
  TX_GUARD_PRICE_USD,
  TX_STATUS_PRICE_USD,
  WATCH_PRICE_USD,
  X402_CHECK_PRICE_USD,
  X402_CHECK_DEEP_PRICE_USD,
  YIELD_PRICE_USD,
} from "./config";

type RouteInfo = { price: string; what: string };

/** Every live paid route: current price (config) + a short label. */
export const ROUTE_INFO: Readonly<Record<string, RouteInfo>> = {
  "/api/pulse": { price: PULSE_PRICE_USD, what: "BTC/ETH/SOL spot prices and momentum" },
  "/api/signals": { price: SIGNALS_PRICE_USD, what: "RSI, MACD, Bollinger for BTC/ETH/SOL" },
  "/api/yield": { price: YIELD_PRICE_USD, what: "DeFi and stablecoin pool APYs" },
  "/api/portfolio": { price: PORTFOLIO_PRICE_USD, what: "EVM wallet holdings with USD value" },
  "/api/gas": { price: GAS_PRICE_USD, what: "gas fees on Base and Ethereum" },
  "/api/funding": { price: FUNDING_PRICE_USD, what: "BTC/ETH/SOL perp funding rates" },
  "/api/fetch": { price: FETCH_PRICE_USD, what: "web page as clean text" },
  "/api/http": { price: HTTP_PRICE_USD, what: "HTTP proxy request" },
  "/api/extract": { price: EXTRACT_PRICE_USD, what: "structured fields from a page" },
  "/api/x402-check": { price: X402_CHECK_PRICE_USD, what: "decode an x402 endpoint's payment terms" },
  "/api/x402-check/deep": { price: X402_CHECK_DEEP_PRICE_USD, what: "deep x402 check: TLS, CORS, payTo vs published, drift" },
  "/api/bazaar-check": { price: BAZAAR_CHECK_PRICE_USD, what: "is an x402 seller listed in CDP Bazaar" },
  "/api/screenshot": { price: SCREENSHOT_PRICE_USD, what: "page screenshot" },
  "/api/search": { price: SEARCH_PRICE_USD, what: "web search results" },
  "/api/pdf": { price: PDF_PRICE_USD, what: "text of a public PDF" },
  "/api/market/search": { price: MARKET_SEARCH_PRICE_USD, what: "find paid APIs for a task" },
  "/api/market/quote": { price: MARKET_QUOTE_PRICE_USD, what: "price and payTo check for an x402 URL" },
  "/api/discourse/split": { price: DISCOURSE_SPLIT_PRICE_USD, what: "opinion split of public posts" },
  "/api/tx-status": { price: TX_STATUS_PRICE_USD, what: "did a tx land: Base, Polygon, Solana, XRPL" },
  "/api/tokenized-stock": { price: TOKENIZED_STOCK_PRICE_USD, what: "Coinbase tokenized stock token state" },
  "/api/watch": { price: WATCH_PRICE_USD, what: "page change check" },
  "/api/balance": { price: BALANCE_PRICE_USD, what: "payer balances and can-pay-now check" },
  "/api/tx-guard": { price: TX_GUARD_PRICE_USD, what: "lookalike and OFAC SDN check before a transfer" },
  "/api/grocery/normalize": { price: GROCERY_NORMALIZE_PRICE_USD, what: "parse recipe ingredient lines" },
  "/api/grocery/ingredient": { price: GROCERY_INGREDIENT_PRICE_USD, what: "ingredient nutrition facts" },
  "/api/chain/head": { price: CHAIN_HEAD_PRICE_USD, what: "block height on 5 chains" },
  "/api/token/meta": { price: TOKEN_META_PRICE_USD, what: "token name, symbol, decimals, supply" },
  "/api/name/resolve": { price: NAME_RESOLVE_PRICE_USD, what: "ENS and Basename lookup" },
  "/api/batch": { price: BATCH_PRICE_USD, what: "Up to 10 chain checks for one payment" },
};

/** route -> 2-3 related paid routes (same agent task, next likely step). */
export const RELATED: Readonly<Record<string, readonly string[]>> = {
  "/api/pulse": ["/api/signals", "/api/funding", "/api/gas"],
  "/api/signals": ["/api/pulse", "/api/funding", "/api/yield"],
  "/api/yield": ["/api/pulse", "/api/portfolio", "/api/balance"],
  "/api/portfolio": ["/api/balance", "/api/yield", "/api/pulse"],
  "/api/gas": ["/api/chain/head", "/api/tx-status", "/api/balance"],
  "/api/funding": ["/api/signals", "/api/pulse"],
  "/api/fetch": ["/api/extract", "/api/http", "/api/watch"],
  "/api/http": ["/api/fetch", "/api/x402-check"],
  "/api/extract": ["/api/fetch", "/api/pdf", "/api/search"],
  "/api/x402-check": ["/api/bazaar-check", "/api/market/search", "/api/http"],
  "/api/x402-check/deep": ["/api/bazaar-check", "/api/tx-guard", "/api/market/quote"],
  "/api/bazaar-check": ["/api/x402-check", "/api/market/search"],
  "/api/screenshot": ["/api/fetch", "/api/pdf", "/api/extract"],
  "/api/search": ["/api/fetch", "/api/extract"],
  "/api/pdf": ["/api/extract", "/api/fetch"],
  "/api/market/search": ["/api/market/quote", "/api/x402-check"],
  "/api/market/quote": ["/api/market/search", "/api/x402-check"],
  "/api/discourse/split": ["/api/search", "/api/extract"],
  "/api/tx-status": ["/api/chain/head", "/api/balance", "/api/gas"],
  "/api/tokenized-stock": ["/api/token/meta", "/api/pulse", "/api/balance"],
  "/api/watch": ["/api/fetch", "/api/extract"],
  "/api/balance": ["/api/tx-guard", "/api/token/meta", "/api/tx-status"],
  "/api/tx-guard": ["/api/name/resolve", "/api/balance", "/api/tx-status"],
  "/api/grocery/normalize": ["/api/grocery/ingredient"],
  "/api/grocery/ingredient": ["/api/grocery/normalize"],
  "/api/chain/head": ["/api/tx-status", "/api/gas", "/api/balance"],
  "/api/token/meta": ["/api/balance", "/api/tokenized-stock", "/api/tx-guard"],
  "/api/name/resolve": ["/api/tx-guard", "/api/balance", "/api/token/meta"],
  // Batch (listed 10/19): complements only (routes batch cannot run). Batch is NOT added to any other
  // route's list, so existing single-route paid responses are unchanged.
  "/api/batch": ["/api/tx-guard", "/api/portfolio"],
};

export const HINT_KEY = "relatedRoutes";
export const HINT_NOTE = "Free hint, not charged. Each listed route is a separate paid x402 call at the price shown.";

export type RelatedHint = { note: string; routes: { path: string; price: string; what: string }[] };

export function relatedHint(path: string): RelatedHint | null {
  const rel = RELATED[path];
  if (!rel || rel.length === 0) return null;
  const routes = rel.flatMap((p) => {
    const i = ROUTE_INFO[p];
    return i ? [{ path: p, price: i.price, what: i.what }] : [];
  });
  return routes.length ? { note: HINT_NOTE, routes } : null;
}

/** Whole map for /.well-known/related-routes. */
export function relatedRoutesDocument() {
  return {
    version: 1,
    note: "Free map of related Horizon Pulse paid routes. Paid JSON responses carry the same list under relatedRoutes. Prices are per call in USDC.",
    routes: Object.keys(ROUTE_INFO).map((path) => ({
      path,
      price: ROUTE_INFO[path].price,
      what: ROUTE_INFO[path].what,
      related: relatedHint(path)?.routes ?? [],
    })),
  };
}

function settled(res: Response): boolean {
  return Boolean(res.headers.get("payment-response") ?? res.headers.get("x-payment-response"));
}

/**
 * Splice `relatedRoutes` into a settled 2xx JSON object body. Returns the
 * original response untouched on any doubt or error (never throws).
 */
export async function withRelatedRoutes<T extends Response>(path: string, method: string, res: T): Promise<T | Response> {
  try {
    if (method === "HEAD" || res.status < 200 || res.status >= 300 || !settled(res)) return res;
    if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return res;
    const hint = relatedHint(path);
    if (!hint) return res;
    const text = await res.clone().text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return res;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || HINT_KEY in (parsed as object)) return res;
    const end = text.lastIndexOf("}");
    if (end < 0) return res;
    const isEmpty = Object.keys(parsed as object).length === 0;
    const body = `${text.slice(0, end)}${isEmpty ? "" : ","}${JSON.stringify(HINT_KEY)}:${JSON.stringify(hint)}${text.slice(end)}`;
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  } catch {
    return res;
  }
}
