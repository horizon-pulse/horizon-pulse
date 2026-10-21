import { NextResponse } from "next/server";
import { LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import {
  CONTACT_EMAIL,
  PUBLIC_BASE_URL,
  DISCOVERY_DESCRIPTION,
  BASE_CAIP2,
  BASE_PAY_TO_BASENAME,
  DEFAULT_PAY_TO,
} from "@/lib/config";
import { SOLANA_MAINNET_CAIP2, SOLANA_PAYTO } from "@/lib/solana-config";
import { freeTierMode, wellKnownFreeTier } from "@/lib/free-tier";
import { premiumResources, premiumWellKnownBlock } from "@/lib/premium/discovery";
import { sellerDdResources, sellerDdWellKnownBlock } from "@/lib/seller-dd/discovery";

/**
 * GET /.well-known/x402 — x402 discovery fan-out (compatibility path).
 *
 * Format: x402scan discovery spec (Merit-Systems/x402scan docs/DISCOVERY.md,
 * section B): { version: 1, resources: string[] } with optional
 * `instructions` / `ownershipProofs`. Each resource is a plain absolute URL,
 * exactly the spec's form. (Until 2026-10-13 entries were "GET https://…";
 * Agent402's crawler only splits "VERB /path", so it indexed 16 junk rows like
 * "/GET%20https://…". Verbs live in openapi.json and in each 402's bazaar
 * extension, which is where x402scan (@agentcash/discovery 1.7.x, OpenAPI-first)
 * and Agent402 read them.)
 *
 * Generated from lib/live-catalog.ts (single source of truth), so it lists
 * exactly the live paid routes; a GET|POST route appears once.
 * Free route, no payment logic.
 */
export const dynamic = "force-static";

function buildResources(): string[] {
  return [...new Set(LIVE_PAID_ROUTES.map((route) => `${PUBLIC_BASE_URL}${route.path.split("?")[0]}`))];
}

export function GET(): NextResponse {
  const doc = {
    version: 1,
    resources: buildResources(),
    description: DISCOVERY_DESCRIPTION,
    instructions: `x402 v2, scheme exact, USDC on Base mainnet (${BASE_CAIP2}, Coinbase CDP facilitator) or Solana mainnet (${SOLANA_MAINNET_CAIP2}, PayAI facilitator), or RLUSD on the XRP Ledger mainnet (xrpl:0, issuer rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De, verified on the validated ledger), or USDC on Polygon PoS mainnet (eip155:137, native USDC 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359, Coinbase CDP facilitator), same price on every network. Unpaid requests return HTTP 402 with a PAYMENT-REQUIRED header listing one accepts entry per network; pay exactly one and retry with PAYMENT-SIGNATURE. payTo: Base ${DEFAULT_PAY_TO} (Basename ${BASE_PAY_TO_BASENAME}, a label for that address; compare the hex payTo in the challenge), Solana ${SOLANA_PAYTO}, XRP Ledger r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf, Polygon ${DEFAULT_PAY_TO} (same address as Base). Full schemas: ${PUBLIC_BASE_URL}/openapi.json and ${PUBLIC_BASE_URL}/llms.txt. Agent skill (step-by-step pay flow): ${PUBLIC_BASE_URL}/skill.md. MCP setup: ${PUBLIC_BASE_URL}/agents. Contact: ${CONTACT_EMAIL}.`,
  };
  // Premium ladder (lib/premium): HP_PREMIUM_ENABLED=true appends per-tier URLs + a `premium` block; off -> `doc` unchanged.
  const premium = premiumWellKnownBlock();
  const withPremium0 = premium ? { ...doc, resources: [...doc.resources, ...premiumResources()], premium } : doc;
  // Seller due-diligence (lib/seller-dd/discovery.ts): HP_PREMIUM_ENABLED + HP_SELLER_DD_ENABLED appends its URL + a `sellerDd` block; off -> unchanged.
  const sellerDd = sellerDdWellKnownBlock();
  const withPremium = sellerDd ? { ...withPremium0, resources: [...withPremium0.resources, ...sellerDdResources()], sellerDd } : withPremium0;
  // Free daily cap (lib/free-tier.ts): HP_FREE_TIER=optin adds the copy + a freeTier block; off -> `doc` unchanged.
  return NextResponse.json(
    freeTierMode() === "optin" ? wellKnownFreeTier(withPremium) : withPremium,
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
