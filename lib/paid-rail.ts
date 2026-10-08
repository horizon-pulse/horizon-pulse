/**
 * The `priced` block in every paid route's 200 body, filled from the rail the
 * caller actually paid on (Base USDC via CDP, or Solana USDC via PayAI).
 *
 * How the rail is known: x402 runs verify -> route handler -> settle, all
 * against ONE requirement. The Base path (lib/x402-server.ts) and the Solana
 * path (lib/solana-rail.ts) each wrap the route handler they hand to their
 * own withX402 server with runOnPaidRail(), so while the handler runs,
 * AsyncLocalStorage holds the network / asset / payTo of the server that
 * verified this payment and will settle it. The Base server only accepts Base
 * USDC; the Solana server only accepts Solana USDC. If that settle fails the
 * body is never delivered (Base: withX402 returns a 402; Solana: Base-only
 * 402 or 502/504), so a delivered `priced` always names the settled rail.
 *
 * No paid-rail context (handler called outside both servers: the free
 * /api/demo samples and the Base-only MCP tools) -> Base, exactly as before.
 *
 * Amounts are the same on every rail (both USDCs have 6 decimals; the Solana
 * requirement is built from the same atomic amount). Base output is
 * byte-identical to the previous hard-coded block (same keys, same order).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getPayTo, USDC_BASE } from "./config";
import type { SolanaRailConfig } from "./solana-config";

export type PaidRail = {
  /** Base keeps its existing label "base"; other rails use their CAIP-2 id. */
  network: string;
  /** Token contract / mint the payment was made in. */
  asset: string;
  payTo: string;
};

export type PricedBlock = {
  amountUsd: string;
  amountAtomic: string;
  asset: string;
  network: string;
  payTo: string;
};

const paidRail = new AsyncLocalStorage<PaidRail>();

/** Base USDC rail (CDP). payTo read at call time, as the old block did. */
export function baseRail(): PaidRail {
  return { network: "base", asset: USDC_BASE, payTo: getPayTo() };
}

/** Solana USDC rail (PayAI): the same config the Solana-only server verifies/settles against. */
export function solanaRail(config: Pick<SolanaRailConfig, "network" | "asset" | "payTo">): PaidRail {
  return { network: config.network, asset: config.asset, payTo: config.payTo };
}

/** Wrap a route handler so it runs with `rail()` as its paid-rail context. */
export function runOnPaidRail<R, T extends Response>(rail: () => PaidRail, handler: (req: R) => Promise<T>): (req: R) => Promise<T> {
  return (req: R) => paidRail.run(rail(), () => handler(req));
}

/** The rail of the server running the current handler, or null outside both paid servers. */
export function currentPaidRail(): PaidRail | null {
  return paidRail.getStore() ?? null;
}

/** The `priced` block for a route at this price, on the rail this call is paid on. */
export function pricedBlock(amountUsd: string, amountAtomic: string): PricedBlock {
  const rail = currentPaidRail() ?? baseRail();
  return { amountUsd, amountAtomic, asset: rail.asset, network: rail.network, payTo: rail.payTo };
}
