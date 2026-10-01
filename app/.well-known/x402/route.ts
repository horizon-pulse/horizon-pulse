import { NextResponse } from "next/server";
import { LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import {
  CONTACT_EMAIL,
  PUBLIC_BASE_URL,
  DISCOVERY_DESCRIPTION,
} from "@/lib/config";

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
      instructions: `x402 v2 on Base mainnet (eip155:8453), USDC, Coinbase CDP facilitator. Unpaid requests return HTTP 402 with a PAYMENT-REQUIRED header; retry with PAYMENT-SIGNATURE. Full schemas: ${PUBLIC_BASE_URL}/openapi.json and ${PUBLIC_BASE_URL}/llms.txt. Contact: ${CONTACT_EMAIL}.`,
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
