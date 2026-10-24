/**
 * Public listing of live premium tiers (today: the $1 verified brief only) for every surface that shows
 * the paid-route count or list: homepage, /status, /agents, skill.md, openapi.json, llms.txt, hosted MCP.
 * Kept separate from LIVE_PAID_ROUTES because premium tiers are Base only, USDC or EURC (the multi-network
 * catalog copy does not apply). Gated by the same switch as the route (tierAllowed), so a tier that
 * 404s is never listed. $5/$10 tiers are not listed.
 *
 * COUNSEL CONDITION (item 8, PASS 10/20 on 6619952): no AI-provider line is in these listings because model calls are
 * off in prod. Before ANY model call goes live for briefs (HP_BRIEF_MODEL_ANSWER / HP_PREMIUM_LLM_ENABLED), add the
 * provider line (name only "an AI model provider") to every surface here, llms.txt and openapi, and get a Counsel review.
 */
import { BRIEF_DESCRIPTION } from "./copy";
import { tierAllowed } from "./tiers";
import { DD_AMOUNT, DD_DESCRIPTION, DD_PATH, DD_PRICE_USD, sellerDdEnabled } from "../seller-dd/config";

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
  rail: "USDC or EURC on Base only",
  summary: "Verified brief, three question types only: Base or Ethereum gas (on-chain read), USDC supply on Ethereum and Base (on-chain totalSupply), or an x402 spec fact. Charged only if at least 2 claims are confirmed in two sources as defined by the contract (two independent nodes, or two separate specification documents); otherwise a 422, unpaid.",
  description: BRIEF_DESCRIPTION,
  contract: "/contracts/brief-verified",
  terms: "/premium-terms",
  demo: "/api/demo/brief-verified",
};

/**
 * Site listing shape shared by every premium product shown on the human pages (homepage, /status, /agents, /docs,
 * skill.md). `label` is the plain name used in count lines ("the $1 verified brief", "the $5 seller due-diligence check").
 */
export type SiteListing = {
  id: "brief" | "seller-dd";
  label: string;
  path: string;
  method: "GET" | "POST";
  priceUsd: string;
  amount: string;
  rail: string;
  summary: string;
  description: string;
  contract: string | null;
  terms: string;
  demo: string | null;
};

/**
 * $5 seller due-diligence check (site accuracy fix, 10/21). summary/description are DD_DESCRIPTION from
 * lib/seller-dd/config.ts VERBATIM (Odin rule: Seller DD wording word-for-word from config). Price/amount/path from config.
 * No demo yet (/api/demo/seller-dd is 404), no contract page. NOT in ALL_PREMIUM_LISTINGS: gen-openapi bakes those into
 * the static public/openapi.json, while Seller DD is served only behind its own flag (lib/seller-dd/discovery.ts).
 */
export const SELLER_DD_LISTING: SiteListing = {
  id: "seller-dd",
  label: "seller due-diligence check",
  path: DD_PATH,
  method: "POST",
  priceUsd: `$${DD_PRICE_USD}`,
  amount: DD_AMOUNT,
  rail: "USDC or EURC on Base only",
  summary: DD_DESCRIPTION,
  description: DD_DESCRIPTION,
  contract: null,
  terms: "/premium-terms",
  demo: null,
};

export const ALL_PREMIUM_LISTINGS: readonly PremiumListing[] = [BRIEF_LISTING];

/** Premium tiers listed right now (same gate as the route itself). */
export function premiumListings(env: Record<string, string | undefined> = process.env): PremiumListing[] {
  return ALL_PREMIUM_LISTINGS.filter((x) => tierAllowed(x.id, env));
}

/**
 * Every premium product live right now, for public counts and site rows: the gated tiers (brief) plus Seller DD when
 * sellerDdEnabled() (the route's own gate, so a 404 route is never listed). Flag off -> same as premiumListings().
 */
export function livePremiumListings(env: Record<string, string | undefined> = process.env): SiteListing[] {
  const tiers: SiteListing[] = premiumListings(env).map((x) => ({ ...x, label: "verified brief" }));
  return sellerDdEnabled(env) ? [...tiers, SELLER_DD_LISTING] : tiers;
}
