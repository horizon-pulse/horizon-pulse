/**
 * EURC on Base: an EXTRA accepts entry on the 29 standard paid routes.
 *
 * OFF unless HP_EURC_ENABLED is exactly "true" (code default: off). Off -> every
 * 402 / OPTIONS / paid path is byte-identical to main (tests/x402-flag-off.test.ts,
 * goldens NOT refreshed). Premium routes (lib/premium, /api/seller-dd) never call
 * this module and stay USDC-only.
 *
 * Asset: Circle's official EURC on Base mainnet, hard-coded here (never from env).
 * Source: Circle docs, "EURC contract addresses", Base mainnet
 * https://developers.circle.com/stablecoins/eurc-contract-addresses
 * (gate report: oversight/to-odin/2026-10-23-pulse-eurc-gate.md).
 * EIP-712 domain {name: "EURC", version: "2"}, 6 decimals, EIP-3009
 * transferWithAuthorization (same FiatToken v2 family as USDC).
 *
 * Pricing (Odin 11:37 PM ET 10/23): route prices stay in USD. The EURC amount is
 *   ceil(USD price / EURUSD_RATE * 1.01 * 1e6)
 * with a FIXED, hand-updated EUR/USD rate (USD per 1 EUR) and a 1% buffer,
 * rounded UP so we never receive less than the USD price at the recorded rate.
 * No live FX anywhere in the payment path. The rate and its date are shown in
 * the 402 entry's extra.
 *
 * payTo: always getPayTo() (pinned DEFAULT_PAY_TO guard in lib/config.ts);
 * this module never holds an address of its own.
 */
import { BASE_CAIP2, getNetworkCaip2, getPayTo } from "./config";

/** Circle EURC on Base mainnet (lower-case; compare case-insensitively). */
export const EURC_BASE = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42" as const;
export const EURC_DECIMALS = 6 as const;
/** EIP-712 domain of the EURC contract on Base (name(), version 2). */
export const EURC_EIP712 = { name: "EURC", version: "2" } as const;

/**
 * ECB euro foreign exchange reference rate, USD per 1 EUR.
 * Source: https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
 * (ECB page: https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-usd.en.html)
 * Reference date 2026-10-23, read 2026-10-23 ~11:45 PM ET. Update BY HAND only.
 * Kept as a decimal string; the math below is exact integer (BigInt) math.
 */
export const EURUSD_RATE = "1.1193" as const;
export const EURUSD_RATE_DATE = "2026-10-23" as const;
export const EURUSD_RATE_SOURCE = "ECB euro reference rate" as const;
/** Buffer over the reference rate, as a decimal string (1.01 = +1%). */
export const EURC_BUFFER = "1.01" as const;

/** Exactly "true" turns it on; anything else (unset, "TRUE", "1", " true") is off. */
export function eurcEnabled(): boolean {
  return process.env.HP_EURC_ENABLED === "true";
}

/** "1.1193" -> { num: 11193n, scale: 10000n }. Throws on anything not a plain positive decimal. */
function decimal(s: string): { num: bigint; scale: bigint } {
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`eurc: bad decimal ${JSON.stringify(s)}`);
  const [i, f = ""] = s.split(".");
  const num = BigInt(i + f);
  if (num <= 0n) throw new Error(`eurc: non-positive decimal ${s}`);
  return { num, scale: 10n ** BigInt(f.length) };
}

/**
 * USD atomic (6 decimals, as the USDC accept) -> EURC atomic (6 decimals):
 * ceil(usdAtomic * buffer / rate). Both tokens have 6 decimals, so this equals
 * ceil(USD price / rate * 1.01 * 1e6).
 */
export function eurcAtomicFromUsdAtomic(usdAtomic: string | bigint, rate: string = EURUSD_RATE, buffer: string = EURC_BUFFER): string {
  const usd = typeof usdAtomic === "bigint" ? usdAtomic : BigInt(usdAtomic);
  if (usd <= 0n) throw new Error("eurc: amount must be positive");
  const r = decimal(rate);
  const b = decimal(buffer);
  // usd * (b.num/b.scale) / (r.num/r.scale) = usd * b.num * r.scale / (b.scale * r.num)
  const n = usd * b.num * r.scale;
  const d = b.scale * r.num;
  return ((n + d - 1n) / d).toString();
}

/** "$0.002" -> "2000" (exact, 6 decimals). Null for anything else. */
export function usdPriceToAtomic(price: unknown): string | null {
  if (typeof price !== "string") return null;
  const m = /^\$(\d+)(?:\.(\d{1,6}))?$/.exec(price);
  if (!m) return null;
  const atomic = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return atomic > 0n ? atomic.toString() : null;
}

/** The `extra` of the EURC entry: EIP-712 domain first, then the pricing facts. */
export function eurcExtra() {
  return {
    name: EURC_EIP712.name,
    version: EURC_EIP712.version,
    eurUsdRate: EURUSD_RATE,
    rateDate: EURUSD_RATE_DATE,
    rateSource: EURUSD_RATE_SOURCE,
    buffer: EURC_BUFFER,
    pricing: "EURC amount = ceil(USD price / eurUsdRate * buffer), 6 decimals; fixed rate, no live FX",
  };
}

/** True when the route config runs on Base mainnet (EURC exists only there). */
export function eurcNetworkOk(): boolean {
  return getNetworkCaip2() === BASE_CAIP2;
}

/** Route-config accept (x402 AssetAmount price) for a USD atomic amount. */
export function eurcRouteAccept(usdAtomic: string) {
  return {
    scheme: "exact",
    network: BASE_CAIP2,
    payTo: getPayTo(),
    price: { amount: eurcAtomicFromUsdAtomic(usdAtomic), asset: EURC_BASE, extra: eurcExtra() },
  };
}

/** Wire-format requirement (the local no-CDP 402), same fields as the USDC entry there. */
export function eurcRequirement(usdAtomic: string) {
  return {
    scheme: "exact",
    network: BASE_CAIP2,
    amount: eurcAtomicFromUsdAtomic(usdAtomic),
    asset: EURC_BASE,
    payTo: getPayTo(),
    maxTimeoutSeconds: 300,
    extra: eurcExtra(),
  };
}

export function isEurcAsset(asset: unknown): boolean {
  return typeof asset === "string" && asset.toLowerCase() === EURC_BASE;
}
