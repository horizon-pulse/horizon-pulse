/**
 * Free fixed-input samples for every paid route (GET /api/demo/<route>).
 * Real handler output on FIXED inputs only — callers cannot choose a URL or
 * address, so demos can't be used as a free proxy. Not x402 resources: kept
 * out of /.well-known/x402, OpenAPI, and Bazaar discovery on purpose.
 */
import {
  EXTRACT_PRICE_USD,
  SCREENSHOT_PRICE_USD,
  X402_CHECK_PRICE_USD,
  BAZAAR_CHECK_PRICE_USD,
  MARKET_SEARCH_PRICE_USD,
  MARKET_QUOTE_PRICE_USD,
  SEARCH_PRICE_USD,
  PDF_PRICE_USD,
  DISCOURSE_SPLIT_PRICE_USD,
  TX_STATUS_PRICE_USD,
  TOKENIZED_STOCK_PRICE_USD,
  WATCH_PRICE_USD,
  BALANCE_PRICE_USD,
  FETCH_PRICE_USD,
  FUNDING_PRICE_USD,
  GAS_PRICE_USD,
  HTTP_PRICE_USD,
  PORTFOLIO_PRICE_USD,
  PULSE_PRICE_USD,
  SIGNALS_PRICE_USD,
  YIELD_PRICE_USD,
} from "@/lib/config";

/** Well-known public address (vitalik.eth), used only as a labeled sample. */
export const DEMO_PORTFOLIO_ADDRESS =
  "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as const;

export type DemoRoute = {
  route: string;
  priceUsd: string;
  /** Fixed query string passed to the real handler (no user input). */
  query: string;
  input: string;
};

export const DEMO_ROUTES: DemoRoute[] = [
  { route: "fetch", priceUsd: FETCH_PRICE_USD, query: "url=https://example.com", input: "url=https://example.com (fixed)" },
  { route: "http", priceUsd: HTTP_PRICE_USD, query: "url=https://example.com&method=GET", input: "GET https://example.com (fixed)" },
  { route: "extract", priceUsd: EXTRACT_PRICE_USD, query: "url=https://horizonpulse.dev&fields=%7B%22heading%22%3A%22h1%22%2C%22links%22%3A%7B%22selector%22%3A%22a%22%2C%22attr%22%3A%22href%22%2C%22all%22%3Atrue%2C%22limit%22%3A5%7D%7D", input: 'url=https://horizonpulse.dev, fields={"heading":"h1","links":{"selector":"a","attr":"href","all":true,"limit":5}} (fixed)' },
  { route: "x402-check", priceUsd: X402_CHECK_PRICE_USD, query: "url=https://horizonpulse.dev/api/pulse", input: "url=https://horizonpulse.dev/api/pulse (fixed)" },
  { route: "bazaar-check", priceUsd: BAZAAR_CHECK_PRICE_USD, query: "url=horizonpulse.dev", input: "url=horizonpulse.dev (fixed; sample reused for 10 min)" },
  { route: "market-search", priceUsd: MARKET_SEARCH_PRICE_USD, query: "q=horizon%20pulse%20bazaar%20check&n=1", input: "q=horizon pulse bazaar check, n=1 (fixed; sample reused for 10 min)" },
  { route: "market-quote", priceUsd: MARKET_QUOTE_PRICE_USD, query: "url=https%3A%2F%2Fhorizonpulse.dev%2Fapi%2Fpulse", input: "url=https://horizonpulse.dev/api/pulse (fixed; sample reused for 10 min)" },
  { route: "discourse-split", priceUsd: DISCOURSE_SPLIT_PRICE_USD, query: "q=tabs%20or%20spaces%20for%20indentation&sides=tabs,spaces", input: "q=tabs or spaces for indentation, sides=tabs,spaces (fixed; canned recorded sample, not re-run)" },
  { route: "tx-status", priceUsd: TX_STATUS_PRICE_USD, query: "network=base&tx=0xe6e6ebd93db6735aad12a86a1084d5e1d6759e31fbedf7b741946f2bf410644f", input: "network=base, tx=0xe6e6…644f (fixed: a finalized Base USDC transfer; sample reused for 10 min)" },
  { route: "tokenized-stock", priceUsd: TOKENIZED_STOCK_PRICE_USD, query: "symbol=AAPL", input: "symbol=AAPL (fixed; on-chain status read of the AAPLc token contract on Base, no price; sample reused for 10 min). Not investment advice." },
  { route: "watch", priceUsd: WATCH_PRICE_USD, query: "url=https://example.com", input: "url=https://example.com (fixed; first check: returns the baseline state token, no since; sample reused for 10 min)" },
  { route: "balance", priceUsd: BALANCE_PRICE_USD, query: `evm=${DEMO_PORTFOLIO_ADDRESS}`, input: `evm=${DEMO_PORTFOLIO_ADDRESS} (fixed: Base and Polygon rails, same public address as the portfolio demo; sample reused for 10 min)` },
  { route: "screenshot", priceUsd: SCREENSHOT_PRICE_USD, query: "url=https://horizonpulse.dev", input: "url=https://horizonpulse.dev (fixed, 1280x800 png)" },
  { route: "search", priceUsd: SEARCH_PRICE_USD, query: "q=x402%20payment%20protocol&n=2", input: "q=x402 payment protocol, n=2 (fixed; recorded sample, refreshed at most daily)" },
  { route: "pdf", priceUsd: PDF_PRICE_USD, query: "url=https://horizonpulse.dev/sample.pdf", input: "url=https://horizonpulse.dev/sample.pdf (fixed, 1 page)" },
  { route: "pulse", priceUsd: PULSE_PRICE_USD, query: "", input: "none" },
  { route: "signals", priceUsd: SIGNALS_PRICE_USD, query: "", input: "none" },
  { route: "yield", priceUsd: YIELD_PRICE_USD, query: "", input: "none" },
  { route: "gas", priceUsd: GAS_PRICE_USD, query: "", input: "none" },
  { route: "funding", priceUsd: FUNDING_PRICE_USD, query: "", input: "none" },
  { route: "portfolio", priceUsd: PORTFOLIO_PRICE_USD, query: `address=${DEMO_PORTFOLIO_ADDRESS}`, input: `address=${DEMO_PORTFOLIO_ADDRESS} (vitalik.eth, public sample address)` },
];
