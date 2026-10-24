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
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { getPayTo, USDC_BASE } from "./config";
import { EURC_BASE, EURUSD_RATE, EURUSD_RATE_DATE, eurcAtomicFromUsdAtomic, isEurcAsset } from "./eurc-config";
import type { SolanaRailConfig } from "./solana-config";
import type { XrplRailConfig } from "./xrpl-config";

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
  /** EURC rail only (flag on): the token, and the fixed rate the EURC amount used. */
  currency?: "EURC";
  eurUsdRate?: string;
  rateDate?: string;
};

const paidRail = new AsyncLocalStorage<PaidRail>();

/** Base USDC rail (CDP). payTo read at call time, as the old block did. */
export function baseRail(): PaidRail {
  return { network: "base", asset: USDC_BASE, payTo: getPayTo() };
}

/** Base EURC rail (HP_EURC_ENABLED only): same network label and pinned payTo, EURC asset. */
export function eurcRail(): PaidRail {
  return { network: "base", asset: EURC_BASE, payTo: getPayTo() };
}

/**
 * Base rail for a request on the EURC-enabled handler: EURC when the v2
 * PAYMENT-SIGNATURE's accepted asset is EURC, else Base USDC. Never throws.
 * Only a label for the `priced` block: CDP verifies/settles the payload against
 * the matching accepts entry, so a forged asset field cannot change what is paid.
 */
export function baseRailFor(req: Request): PaidRail {
  try {
    const raw = req.headers.get("payment-signature")?.trim();
    if (raw) {
      const p = decodePaymentSignatureHeader(raw) as { accepted?: { asset?: unknown } };
      if (isEurcAsset(p?.accepted?.asset)) return eurcRail();
    }
  } catch {
    /* fall through to USDC */
  }
  return baseRail();
}

/** Solana USDC rail (PayAI): the same config the Solana-only server verifies/settles against. */
export function solanaRail(config: Pick<SolanaRailConfig, "network" | "asset" | "payTo">): PaidRail {
  return { network: config.network, asset: config.asset, payTo: config.payTo };
}

/**
 * XRPL RLUSD rail: network = xrpl:N, asset = RLUSD hex currency + issuer
 * ("<hex>.<issuer>", so the issuer is always named), payTo = pinned per network.
 * amountAtomic stays the 6-decimal USD atomic used on every rail.
 */
export function xrplRail(config: Pick<XrplRailConfig, "network" | "asset" | "issuer" | "payTo">): PaidRail {
  return { network: config.network, asset: `${config.asset}.${config.issuer}`, payTo: config.payTo };
}

/** Wrap a route handler so it runs with `rail()` as its paid-rail context. */
export function runOnPaidRail<R, T extends Response>(rail: () => PaidRail, handler: (req: R) => Promise<T>): (req: R) => Promise<T> {
  return (req: R) => paidRail.run(rail(), () => handler(req));
}

/** Like runOnPaidRail, but the rail is chosen per request. */
export function runOnPaidRailFor<R extends Request, T extends Response>(rail: (req: R) => PaidRail, handler: (req: R) => Promise<T>): (req: R) => Promise<T> {
  return (req: R) => paidRail.run(rail(req), () => handler(req));
}

/** The rail of the server running the current handler, or null outside both paid servers. */
export function currentPaidRail(): PaidRail | null {
  return paidRail.getStore() ?? null;
}

/** The `priced` block for a route at this price, on the rail this call is paid on. */
export function pricedBlock(amountUsd: string, amountAtomic: string): PricedBlock {
  const rail = currentPaidRail() ?? baseRail();
  if (isEurcAsset(rail.asset)) {
    // EURC atomic at the fixed rate (lib/eurc-config.ts); amountUsd stays the USD list price.
    return {
      amountUsd,
      amountAtomic: eurcAtomicFromUsdAtomic(amountAtomic),
      asset: rail.asset,
      network: rail.network,
      payTo: rail.payTo,
      currency: "EURC",
      eurUsdRate: EURUSD_RATE,
      rateDate: EURUSD_RATE_DATE,
    };
  }
  return { amountUsd, amountAtomic, asset: rail.asset, network: rail.network, payTo: rail.payTo };
}
