import {
  createX402GetHandler,
  discoveryOptionsResponse,
  searchRouteConfig,
} from "@/lib/x402-server";
import { searchHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Unpaid GET → 402 with payment requirements (no CDP / facilitator needed).
 * Paid GET with CDP → withX402 verify+settle (lazy-init).
 * Paid GET without CDP → 503.
 */
export const GET = createX402GetHandler(
  searchHandler,
  searchRouteConfig(),
  paymentOpts,
);

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
