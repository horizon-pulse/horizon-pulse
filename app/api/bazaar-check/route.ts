import {
  bazaarCheckRouteConfig,
  createX402GetHandler,
  discoveryOptionsResponse,
} from "@/lib/x402-server";
import { withRequestArrival } from "@/lib/request-arrival";
import { bazaarCheckHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Unpaid GET → 402 with payment requirements (no CDP / facilitator needed).
 * Paid GET with CDP → withX402 verify+settle (lazy-init).
 * Paid GET without CDP → 503.
 */
const x402Get = createX402GetHandler(
  bazaarCheckHandler,
  bazaarCheckRouteConfig(),
  paymentOpts,
);

/**
 * Stamps the arrival time before verify, so the check's hard deadline
 * (BC_DEADLINE_MS in lib/bazaar-check.ts) counts from request arrival.
 */
export const GET: typeof x402Get = (req) => withRequestArrival(() => x402Get(req));

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
