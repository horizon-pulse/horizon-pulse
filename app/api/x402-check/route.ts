import {
  createX402GetHandler,
  discoveryOptionsResponse,
  x402CheckRouteConfig,
} from "@/lib/x402-server";
import { x402CheckHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unpaid GET → 402 with payment requirements (no CDP / facilitator needed).
 * Paid GET with CDP → withX402 verify+settle (lazy-init).
 * Paid GET without CDP → 503.
 */
export const GET = createX402GetHandler(
  x402CheckHandler,
  x402CheckRouteConfig(),
  paymentOpts,
);

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
