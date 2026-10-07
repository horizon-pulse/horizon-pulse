/**
 * EURC as a second accepted asset next to USDC (USDC stays FIRST on every route).
 * Pricing (Michael, 2026-10-07): fixed EUR price, EUR 0.01 per call = 10000 atomic EURC (6 dp),
 * on any route listed in EURC_ROUTES. Not FX-derived; FX policy and off-ramp are undecided.
 *
 * EURC, verified on-chain 2026-10-07: EIP-3009 FiatToken, EIP-712 name "EURC", version "2", 6 dp.
 *   Base Sepolia 0x808456652fdb597867f38412077A9182bf77359F (testnet, default)
 *   Base mainnet 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42 (GATED: needs EURC_ALLOW_MAINNET=1,
 *   which needs a working CDP hp-testnet key (Michael), Odin Class A and Michael's final OK)
 * @x402 2.27 custom asset: price: { asset, amount, extra: { name, version } }.
 *
 * Env (OFF unless EURC_ENABLED=1 and EURC_PAY_TO set; placeholders only):
 *   EURC_ENABLED=1, EURC_PAY_TO=0x… (validated like PAY_TO),
 *   EURC_ROUTES=/api/gas,/api/funding (comma list; default = the two spike routes),
 *   EURC_NETWORK=base-sepolia (default) | base (needs EURC_ALLOW_MAINNET=1)
 * Legacy spike names EURC_SPIKE_ENABLED / EURC_SPIKE_PAY_TO are still read.
 */
import type { Network } from "@x402/core/types";

export const BASE_SEPOLIA: Network = "eip155:84532" as Network;
export const BASE_MAINNET: Network = "eip155:8453" as Network;
export const EURC_BASE_SEPOLIA = "0x808456652fdb597867f38412077A9182bf77359F" as const;
export const EURC_BASE_MAINNET = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as const;
/** EUR 0.01 per call, fixed (Michael 2026-10-07). */
export const EURC_PRICE_ATOMIC = "10000" as const;
export const EURC_DEFAULT_ROUTES = ["/api/gas", "/api/funding"] as const;
export const EURC_EIP712 = { name: "EURC", version: "2" } as const;

type EurcEnv = { payTo: `0x${string}`; network: Network; asset: string; routes: string[] };

export function eurcConfig(): EurcEnv | null {
  const on = (process.env.EURC_ENABLED ?? process.env.EURC_SPIKE_ENABLED)?.trim() === "1";
  if (!on) return null;
  const a = (process.env.EURC_PAY_TO ?? process.env.EURC_SPIKE_PAY_TO)?.trim().toLowerCase();
  if (!a || !/^0x[a-f0-9]{40}$/.test(a)) return null;
  if (a === "0xe16a1b12404cb2ebc6e783beca6e2a9253c3dc7e") throw new Error("Refusing retired payTo");
  const net = (process.env.EURC_NETWORK ?? "base-sepolia").trim().toLowerCase();
  const mainnet = net === "base" || net === "base-mainnet" || net === BASE_MAINNET;
  if (mainnet && process.env.EURC_ALLOW_MAINNET?.trim() !== "1") return null; // explicit mainnet gate
  const routes = (process.env.EURC_ROUTES?.split(",").map((r) => r.trim()).filter(Boolean)) ?? [...EURC_DEFAULT_ROUTES];
  return { payTo: a as `0x${string}`, network: mainnet ? BASE_MAINNET : BASE_SEPOLIA, asset: mainnet ? EURC_BASE_MAINNET : EURC_BASE_SEPOLIA, routes };
}
export const eurcEnabled = () => eurcConfig() !== null;
/** @deprecated spike name */
export const eurcSpikeEnabled = eurcEnabled;
export const eurcNetwork = () => eurcConfig()?.network ?? null;

export function isEurc(asset: string | undefined): boolean {
  const x = asset?.toLowerCase();
  return x === EURC_BASE_SEPOLIA.toLowerCase() || x === EURC_BASE_MAINNET.toLowerCase();
}

/** Append the EUR 0.01 EURC option AFTER the existing USDC entries, if this route is listed. */
export function withEurcAccept<T extends object>(path: string, accepts: T[]): T[] {
  const c = eurcConfig();
  if (!c || !c.routes.includes(path)) return accepts;
  return [
    ...accepts,
    { scheme: "exact", network: c.network, payTo: c.payTo, price: { asset: c.asset, amount: EURC_PRICE_ATOMIC, extra: { ...EURC_EIP712 } } } as unknown as T,
  ];
}
