/**
 * Single source of truth for the live paid catalog.
 *
 * Six crypto routes remain FROZEN (prices/behavior unchanged after first
 * settlement). Non-crypto LIVE: /api/fetch ($0.02 clean-text) and
 * /api/http ($0.01 universal proxy, volume-priced).
 *
 * Public host: https://horizonpulse.dev (canonical).
 * Backup: https://horizon-pulse-seven.vercel.app (Vercel).
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
  HTTP_PRICE_USD,
  HTTP_PRICE_ATOMIC,
} from "./config";

export type LiveRoute = {
  path: string;
  /** Display method(s); http is GET|POST at the same price */
  method: "GET" | "GET|POST";
  priceUsd: string;
  priceAtomic: string;
  /** Short agent-facing summary */
  summary: string;
};

/** Live paid routes. Crypto six frozen; fetch + http are non-crypto LIVE. */
export const LIVE_PAID_ROUTES: readonly LiveRoute[] = [
  {
    path: "/api/pulse",
    method: "GET",
    priceUsd: PULSE_PRICE_USD,
    priceAtomic: PULSE_PRICE_ATOMIC,
    summary: "BTC/ETH/SOL spot + momentum (CoinGecko)",
  },
  {
    path: "/api/signals",
    method: "GET",
    priceUsd: SIGNALS_PRICE_USD,
    priceAtomic: SIGNALS_PRICE_ATOMIC,
    summary: "RSI/MACD/Bollinger + OKX funding",
  },
  {
    path: "/api/yield",
    method: "GET",
    priceUsd: YIELD_PRICE_USD,
    priceAtomic: YIELD_PRICE_ATOMIC,
    summary: "DefiLlama yields (TVL ≥ $10M, prefer stablecoin/single-asset)",
  },
  {
    path: "/api/portfolio?address=0x…",
    method: "GET",
    priceUsd: PORTFOLIO_PRICE_USD,
    priceAtomic: PORTFOLIO_PRICE_ATOMIC,
    summary: "Base + Ethereum balances, risk score, rebalance suggestions",
  },
  {
    path: "/api/gas",
    method: "GET",
    priceUsd: GAS_PRICE_USD,
    priceAtomic: GAS_PRICE_ATOMIC,
    summary: "Base + Ethereum baseFee / priority / suggested maxFee + timingHint",
  },
  {
    path: "/api/funding",
    method: "GET",
    priceUsd: FUNDING_PRICE_USD,
    priceAtomic: FUNDING_PRICE_ATOMIC,
    summary: "OKX BTC/ETH/SOL perpetual funding + crowding hint",
  },
  {
    path: "/api/fetch?url=https://…",
    method: "GET",
    priceUsd: FETCH_PRICE_USD,
    priceAtomic: FETCH_PRICE_ATOMIC,
    summary:
      "Fetch public http(s) URL → clean text/markdown (SSRF-safe, ~200KB / 8s caps)",
  },
  {
    path: "/api/http",
    method: "GET|POST",
    priceUsd: HTTP_PRICE_USD,
    priceAtomic: HTTP_PRICE_ATOMIC,
    summary:
      "Universal agent HTTP proxy (url/method/headers/body) → status + filtered headers + body (SSRF-safe; $0.01 volume price)",
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
  "Six crypto routes frozen after first settlement (prices unchanged). Non-crypto LIVE: /api/fetch ($0.02 clean-text) and /api/http ($0.01 universal proxy, volume-priced)." as const;
