/**
 * Single source of truth for the live paid catalog.
 * Frozen after first settlement — do not add routes or change prices here
 * without an explicit product decision.
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
} from "./config";

export type LiveRoute = {
  path: string;
  method: "GET";
  priceUsd: string;
  priceAtomic: string;
  /** Short agent-facing summary */
  summary: string;
};

/** Exactly six live paid routes. No coming-soon / 404 placeholders. */
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
] as const;

/** First on-chain settle (pulse $0.005). Catalog frozen thereafter. */
export const FIRST_SETTLE = {
  /** Truncated Base tx hash — do not invent a full hash */
  txTruncated: "0xedbd1a51…",
  amountUsd: "$0.005",
  route: "/api/pulse",
} as const;

export const CATALOG_NOTE =
  "Catalog frozen after first settlement — six live routes only; no new endpoints and no price changes." as const;
