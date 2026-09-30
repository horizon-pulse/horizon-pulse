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
  SEARCH_PRICE_USD,
  PDF_PRICE_USD,
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
