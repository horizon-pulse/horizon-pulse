/**
 * Optional ?symbol= for /api/pulse, /api/signals, /api/funding.
 *
 * Every symbol here was checked live on 2026-10-21 against all three existing
 * vendors: Coinbase Exchange <SYM>-USD product online (spot + daily candles),
 * CoinGecko id answers /simple/price and /coins/<id>/ohlc, and OKX lists a
 * <SYM>-USDT-SWAP perpetual whose public funding-rate endpoint answers.
 * One table drives all three routes, so the supported list is the same on each.
 *
 * No ?symbol= -> null -> the route's fixed BTC/ETH/SOL set, byte-identical to before.
 * Unsupported / malformed -> 400 before any payment verify or settle (no charge).
 */
import { NextRequest, NextResponse } from "next/server";

export const MARKET_SYMBOLS = {
  BTC: { coingecko: "bitcoin", coinbase: "BTC-USD", okx: "BTC-USDT-SWAP" },
  ETH: { coingecko: "ethereum", coinbase: "ETH-USD", okx: "ETH-USDT-SWAP" },
  SOL: { coingecko: "solana", coinbase: "SOL-USD", okx: "SOL-USDT-SWAP" },
  LINK: { coingecko: "chainlink", coinbase: "LINK-USD", okx: "LINK-USDT-SWAP" },
  QNT: { coingecko: "quant-network", coinbase: "QNT-USD", okx: "QNT-USDT-SWAP" },
  XRP: { coingecko: "ripple", coinbase: "XRP-USD", okx: "XRP-USDT-SWAP" },
  DOGE: { coingecko: "dogecoin", coinbase: "DOGE-USD", okx: "DOGE-USDT-SWAP" },
  ADA: { coingecko: "cardano", coinbase: "ADA-USD", okx: "ADA-USDT-SWAP" },
  AVAX: { coingecko: "avalanche-2", coinbase: "AVAX-USD", okx: "AVAX-USDT-SWAP" },
  DOT: { coingecko: "polkadot", coinbase: "DOT-USD", okx: "DOT-USDT-SWAP" },
  LTC: { coingecko: "litecoin", coinbase: "LTC-USD", okx: "LTC-USDT-SWAP" },
  BCH: { coingecko: "bitcoin-cash", coinbase: "BCH-USD", okx: "BCH-USDT-SWAP" },
  UNI: { coingecko: "uniswap", coinbase: "UNI-USD", okx: "UNI-USDT-SWAP" },
  AAVE: { coingecko: "aave", coinbase: "AAVE-USD", okx: "AAVE-USDT-SWAP" },
  ATOM: { coingecko: "cosmos", coinbase: "ATOM-USD", okx: "ATOM-USDT-SWAP" },
  NEAR: { coingecko: "near", coinbase: "NEAR-USD", okx: "NEAR-USDT-SWAP" },
  XLM: { coingecko: "stellar", coinbase: "XLM-USD", okx: "XLM-USDT-SWAP" },
  SUI: { coingecko: "sui", coinbase: "SUI-USD", okx: "SUI-USDT-SWAP" },
  HBAR: { coingecko: "hedera-hashgraph", coinbase: "HBAR-USD", okx: "HBAR-USDT-SWAP" },
} as const;

export type MarketSymbol = keyof typeof MARKET_SYMBOLS;
export const MARKET_SYMBOL_LIST = Object.keys(MARKET_SYMBOLS) as MarketSymbol[];

export const SYMBOL_PARAM_DESCRIPTION =
  `Optional single coin ticker (case-insensitive). Omit for the default BTC, ETH and SOL set. Supported: ${MARKET_SYMBOL_LIST.join(", ")}. Unsupported symbols get a 400 before payment (no charge).`;

export type SymbolParse =
  | { ok: true; symbols: MarketSymbol[] | null }
  | { ok: false; error: string };

export function parseSymbolParam(url: string): SymbolParse {
  const params = new URL(url).searchParams;
  if (!params.has("symbol")) return { ok: true, symbols: null };
  const all = params.getAll("symbol");
  if (all.length > 1) return { ok: false, error: "Pass one symbol (e.g. symbol=LINK)" };
  const raw = all[0]!.trim().toUpperCase();
  if (!raw) return { ok: false, error: "symbol is empty: pass a ticker (e.g. symbol=LINK) or omit it for BTC, ETH and SOL" };
  if (raw.length > 12 || !Object.prototype.hasOwnProperty.call(MARKET_SYMBOLS, raw)) {
    return { ok: false, error: `Unsupported symbol "${raw.slice(0, 12)}"` };
  }
  return { ok: true, symbols: [raw as MarketSymbol] };
}

export function unsupportedSymbolResponse(route: string, error: string): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      code: "unsupported_symbol",
      error,
      route,
      supported: MARKET_SYMBOL_LIST,
      charged: false,
      note: "Rejected before payment; nothing was verified or settled.",
    },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

type Handler = (req: NextRequest) => Promise<NextResponse>;

/** Runs before the x402 handler: a bad ?symbol= never reaches verify/settle. */
export function withSymbolGate(route: string, next: Handler): Handler {
  return async (req) => {
    const p = parseSymbolParam(req.url);
    if (!p.ok) return unsupportedSymbolResponse(route, p.error);
    return next(req);
  };
}
