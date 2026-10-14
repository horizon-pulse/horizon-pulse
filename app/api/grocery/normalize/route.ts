import { createX402GetHandler, discoveryOptionsResponse, groceryNormalizeRouteConfig } from "@/lib/x402-server";
import { groceryNormalizeHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // XRPL time budget: >= XRPL_ROUTE_MAX_DURATION_S

/** Unpaid GET/POST → 402 (all enabled rails). Paid → verify, run, settle only on < 400. Same price on both verbs. */
const paid = createX402GetHandler((req) => groceryNormalizeHandler(req), groceryNormalizeRouteConfig(), paymentOpts);
export const GET = paid;
export const POST = paid;

export async function OPTIONS() {
  const res = await discoveryOptionsResponse(paymentOpts);
  res.headers.set("Allow", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return res;
}
