/**
 * EURC copy for the $1 brief + Seller DD (Counsel E3, 10/24).
 * - Per-request surfaces (force-dynamic: /status, hosted MCP) use premiumRailLive(), i.e. the SAME eurcActive()
 *   check (flag exactly "true" + Base mainnet + rate age 0-14 days) that decides whether the 402 lists EURC.
 * - Build-time/static surfaces (public/llms.txt, public/openapi.json and every force-static route/page) cannot
 *   follow the flag after build, so they say "USDC or EURC" plus EURC_402_LINE.
 */
import { eurcActive } from "@/lib/eurc-config";

export const PREMIUM_RAIL_STATIC = "USDC or EURC on Base only";
export const PREMIUM_RAIL_USDC = "Base USDC only";
export const EURC_PRICE_LINE = "EURC prices are converted from our USD list prices.";
export const EURC_402_LINE = "EURC is offered only when it is listed in the 402 response.";

/** Live rail label: EURC wording only while the 402 actually offers EURC. */
export function premiumRailLive(active: boolean = eurcActive()): string {
  return active ? PREMIUM_RAIL_STATIC : PREMIUM_RAIL_USDC;
}
