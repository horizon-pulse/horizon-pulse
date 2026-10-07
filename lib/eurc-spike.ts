/**
 * SPIKE (Base Sepolia only, TESTNET): EURC as a second accepted asset next to USDC on
 * /api/gas and /api/funding. USDC (mainnet `exact`) stays FIRST. Michael via Odin 2026-10-07.
 *
 * EURC on Base Sepolia, verified on-chain 2026-10-07 (sepolia.base.org):
 *   0x808456652fdb597867f38412077A9182bf77359F, name "EURC", version "2", 6 decimals.
 *   FiatToken proxy -> impl 0xd74cc5d4…c5b5 exposes transferWithAuthorization (0xe3ee160e) and
 *   receiveWithAuthorization (0xef55bec6); DOMAIN_SEPARATOR matches EIP-712 {EURC, 2, 84532}.
 * @x402 2.27 accepts a custom asset via `price: { asset, amount, extra: { name, version } }`.
 *
 * OFF unless EURC_SPIKE_ENABLED=1 and EURC_SPIKE_PAY_TO (0x…, same validated payTo pattern) are set.
 * Prices are in EURC atomic units (6 dp) and are a 1:1 copy of the USD number for the test only;
 * no EUR price is published.
 */
import type { Network } from "@x402/core/types";

export const BASE_SEPOLIA: Network = "eip155:84532" as Network;
export const EURC_BASE_SEPOLIA = "0x808456652fdb597867f38412077A9182bf77359F" as const;
export const EURC_SPIKE_ROUTES = ["/api/gas", "/api/funding"] as const;

export function eurcSpikePayTo(): `0x${string}` | null {
  if (process.env.EURC_SPIKE_ENABLED?.trim() !== "1") return null;
  const a = process.env.EURC_SPIKE_PAY_TO?.trim().toLowerCase();
  if (!a || !/^0x[a-f0-9]{40}$/.test(a)) return null;
  if (a === "0xe16a1b12404cb2ebc6e783beca6e2a9253c3dc7e") throw new Error("Refusing retired payTo");
  return a as `0x${string}`;
}
export const eurcSpikeEnabled = () => eurcSpikePayTo() !== null;

/** "$0.01" -> "10000" (6 dp). */
function atomic(usd: string): string {
  const n = Number(usd.replace(/^\$/, ""));
  return String(Math.round(n * 1e6));
}

/** Append EURC (Base Sepolia, exact/EIP-3009) AFTER the existing USDC entries. */
export function withEurcAccept<T extends object>(path: string, usdPrice: string, accepts: T[]): T[] {
  const payTo = eurcSpikePayTo();
  if (!payTo || !(EURC_SPIKE_ROUTES as readonly string[]).includes(path)) return accepts;
  return [
    ...accepts,
    {
      scheme: "exact",
      network: BASE_SEPOLIA,
      payTo,
      price: { asset: EURC_BASE_SEPOLIA, amount: atomic(usdPrice), extra: { name: "EURC", version: "2" } },
    } as unknown as T,
  ];
}
