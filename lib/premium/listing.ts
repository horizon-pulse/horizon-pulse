/**
 * Public listing of live premium tiers (today: the $1 verified brief only) for every surface that shows
 * the paid-route count or list: homepage, /status, /agents, skill.md, openapi.json, llms.txt, hosted MCP.
 * Kept separate from LIVE_PAID_ROUTES because premium tiers are Base USDC only (the multi-network
 * catalog copy does not apply). Gated by the same switch as the route (tierAllowed), so a tier that
 * 404s is never listed. $5/$10 tiers are not listed.
 */
import { BRIEF_DESCRIPTION } from "./copy";
import { tierAllowed } from "./tiers";

export type PremiumListing = {
  id: "brief";
  path: string;
  method: "GET";
  priceUsd: string;
  amount: string;
  rail: string;
  /** Short, narrow summary (site tables). */
  summary: string;
  /** Counsel-reviewed long description (verbatim BRIEF_DESCRIPTION). */
  description: string;
  contract: string;
  terms: string;
  demo: string;
};

export const BRIEF_LISTING: PremiumListing = {
  id: "brief",
  path: "/api/research/report/brief",
  method: "GET",
  priceUsd: "$1",
  amount: "1000000",
  rail: "Base USDC only",
  summary: "Verified brief, three question types only: Base or Ethereum gas (on-chain read), USDC supply on Ethereum and Base (on-chain totalSupply), or an x402 spec fact. Charged only if at least 2 claims are independently confirmed; otherwise a 422, unpaid.",
  description: BRIEF_DESCRIPTION,
  contract: "/contracts/brief-verified",
  terms: "/premium-terms",
  demo: "/api/demo/brief-verified",
};

export const ALL_PREMIUM_LISTINGS: readonly PremiumListing[] = [BRIEF_LISTING];

/** Premium tiers listed right now (same gate as the route itself). */
export function premiumListings(env: Record<string, string | undefined> = process.env): PremiumListing[] {
  return ALL_PREMIUM_LISTINGS.filter((x) => tierAllowed(x.id, env));
}
