import {
  createX402GetHandler,
  discoveryOptionsResponse,
  pulseRouteConfig,
} from "@/lib/x402-server";
import { pulseHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unpaid GET → 402 with payment requirements (no CDP / facilitator needed).
 * Paid GET with CDP → withX402 verify+settle (lazy-init).
 * Paid GET without CDP → 503.
 */
export const GET = createX402GetHandler(
  pulseHandler,
  pulseRouteConfig(),
  paymentOpts,
);

/** Free OPTIONS / discovery hint — some agents probe without payment first via GET 402 */
export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}

