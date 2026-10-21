import {
  createX402GetHandler,
  discoveryOptionsResponse,
  fundingRouteConfig,
} from "@/lib/x402-server";
import { withSymbolGate } from "@/lib/market-symbols";
import { fundingHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unpaid GET → 402 with payment requirements (no CDP / facilitator needed).
 * Paid GET with CDP → withX402 verify+settle (lazy-init).
 * Paid GET without CDP → 503.
 */
// Bad ?symbol= -> 400 here, before any 402 / verify / settle (no charge).
export const GET = withSymbolGate("/api/funding", createX402GetHandler(
  fundingHandler,
  fundingRouteConfig(),
  paymentOpts,
));

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}

// XRPL time budget (Odin C1): >= XRPL_ROUTE_MAX_DURATION_S (lib/xrpl-rail.ts).
export const maxDuration = 60;
