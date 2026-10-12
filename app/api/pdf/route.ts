import {
  createX402GetHandler,
  discoveryOptionsResponse,
  pdfRouteConfig,
} from "@/lib/x402-server";
import { pdfHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // XRPL time budget (Odin C1): >= XRPL_ROUTE_MAX_DURATION_S

/**
 * Unpaid GET → 402 with payment requirements (no CDP / facilitator needed).
 * Paid GET with CDP → withX402 verify+settle (lazy-init).
 * Paid GET without CDP → 503.
 */
export const GET = createX402GetHandler(
  pdfHandler,
  pdfRouteConfig(),
  paymentOpts,
);

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
