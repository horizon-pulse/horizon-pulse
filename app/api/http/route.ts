import {
  createX402GetHandler,
  discoveryOptionsResponse,
  httpRouteConfig,
} from "@/lib/x402-server";
import { httpHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unpaid GET/POST → 402 with payment requirements (no CDP needed).
 * Paid + CDP → withX402 verify+settle (lazy-init).
 * Paid without CDP → 503.
 *
 * Both methods share the same $0.01 price / payTo / facilitator stack.
 * createX402GetHandler is method-agnostic (name is historical).
 */
const paid = createX402GetHandler(
  httpHandler,
  httpRouteConfig(),
  paymentOpts,
);

export const GET = paid;
export const POST = paid;

export async function OPTIONS() {
  const res = await discoveryOptionsResponse(paymentOpts);
  // Advertise both paid verbs for CORS / Allow (same price).
  res.headers.set("Allow", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return res;
}
