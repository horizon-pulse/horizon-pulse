import {
  createX402GetHandler,
  discoveryOptionsResponse,
  screenshotRouteConfig,
} from "@/lib/x402-server";
import { screenshotHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // XRPL time budget (Odin C1): >= XRPL_ROUTE_MAX_DURATION_S

/**
 * Unpaid GET → 402 with payment requirements (no CDP / facilitator needed).
 * Paid GET with CDP → withX402 verify+settle (lazy-init).
 * Paid GET without CDP → 503.
 */
export const GET = createX402GetHandler(
  screenshotHandler,
  screenshotRouteConfig(),
  paymentOpts,
);

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
