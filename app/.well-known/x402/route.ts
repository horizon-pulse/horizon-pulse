import { NextResponse } from "next/server";
import { LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import {
  CONTACT_EMAIL,
  PUBLIC_BASE_URL,
  DISCOVERY_DESCRIPTION,
  BASE_CAIP2,
} from "@/lib/config";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/solana-config";

/**
 * GET /.well-known/x402 — x402 discovery fan-out (compatibility path).
 *
 * Format: x402scan discovery spec (Merit-Systems/x402scan docs/DISCOVERY.md,
 * section B): { version: 1, resources: string[] } with optional
 * `instructions` / `ownershipProofs`. Each resource string may be prefixed
 * with its HTTP method ("GET https://…"), as parsed by @agentcash/discovery
 * (entries without a method default to POST, so we always prefix).
 *
 * Generated from lib/live-catalog.ts (single source of truth), so it lists
 * exactly the live paid routes; GET|POST routes appear once per method.
 * Free route, no payment logic.
 */
export const dynamic = "force-static";

function buildResources(): string[] {
  return LIVE_PAID_ROUTES.flatMap((route) => {
    const path = route.path.split("?")[0];
    return route.method
      .split("|")
      .map((method) => `${method} ${PUBLIC_BASE_URL}${path}`);
  });
}

export function GET(): NextResponse {
  return NextResponse.json(
    {
      version: 1,
      resources: buildResources(),
      description: DISCOVERY_DESCRIPTION,
      instructions: `x402 v2, scheme exact, USDC on Base mainnet (${BASE_CAIP2}, Coinbase CDP facilitator) or Solana mainnet (${SOLANA_MAINNET_CAIP2}, PayAI facilitator), same price on both networks. Unpaid requests return HTTP 402 with a PAYMENT-REQUIRED header listing one accepts entry per network; pay exactly one and retry with PAYMENT-SIGNATURE. Full schemas: ${PUBLIC_BASE_URL}/openapi.json and ${PUBLIC_BASE_URL}/llms.txt. Agent skill (step-by-step pay flow): ${PUBLIC_BASE_URL}/skill.md. MCP setup: ${PUBLIC_BASE_URL}/agents. Contact: ${CONTACT_EMAIL}.`,
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
