import { tokenizedStockRouteConfig, createX402GetHandler, discoveryOptionsResponse } from "@/lib/x402-server";
import { tokenizedStockHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // XRPL time budget: >= XRPL_ROUTE_MAX_DURATION_S

/** Unpaid GET → 402 (all enabled rails). Paid → verify, run, settle only on < 400. */
export const GET = createX402GetHandler((req) => tokenizedStockHandler(req), tokenizedStockRouteConfig(), paymentOpts);

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
