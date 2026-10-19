import { createX402GetHandler, discoveryOptionsResponse, x402CheckDeepRouteConfig } from "@/lib/x402-server";
import { x402CheckDeepHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// XRPL time budget (Odin C1): >= XRPL_ROUTE_MAX_DURATION_S (lib/xrpl-rail.ts).
export const maxDuration = 60;

/** Unpaid GET → 402 (all enabled rails). Paid → verify, run, settle only on < 400. */
export const GET = createX402GetHandler((req) => x402CheckDeepHandler(req), x402CheckDeepRouteConfig(), paymentOpts);

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
