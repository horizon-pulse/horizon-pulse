import { NextRequest, NextResponse } from "next/server";
import { batchRouteConfig, createX402GetHandler, discoveryOptionsResponse } from "@/lib/x402-server";
import { batchEnabled } from "@/lib/batch";
import { batchHandler, paymentOpts } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // XRPL time budget: >= XRPL_ROUTE_MAX_DURATION_S

/**
 * INERT unless HP_BATCH_ENABLED=true: 404 on every verb (no 402, no
 * discovery). PROPOSED price, needs Michael's yes + Odin Class A PASS.
 */
let paid: ((req: NextRequest) => Promise<NextResponse>) | null = null;
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!batchEnabled()) return notFound();
  paid ??= createX402GetHandler((r) => batchHandler(r), batchRouteConfig(), paymentOpts);
  return paid(req);
}

export const POST = handle;
export const GET = handle;

export async function OPTIONS() {
  if (!batchEnabled()) return notFound();
  const res = await discoveryOptionsResponse(paymentOpts);
  res.headers.set("Allow", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return res;
}
