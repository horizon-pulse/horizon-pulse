import {
  createX402GetHandler,
  discoveryOptionsResponse,
  extractRouteConfig,
} from "@/lib/x402-server";
import { extractHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unpaid GET/POST → 402 with payment requirements (no CDP needed).
 * Paid + CDP → withX402 verify+settle (lazy-init).
 * Paid without CDP → 503.
 *
 * Both methods share the same $0.015 price / payTo / facilitator stack.
 * createX402GetHandler is method-agnostic (name is historical).
 */
const paid = createX402GetHandler(
  extractHandler,
  extractRouteConfig(),
  paymentOpts,
);

export const GET = paid;
export const POST = paid;

export async function OPTIONS() {
  const res = discoveryOptionsResponse(paymentOpts);
  // Advertise both paid verbs for CORS / Allow (same price).
  res.headers.set("Allow", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return res;
}
