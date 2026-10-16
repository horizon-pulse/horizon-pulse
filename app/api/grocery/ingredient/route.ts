import { NextRequest, NextResponse } from "next/server";
import { GROCERY_INGREDIENT_PRICE_ATOMIC, GROCERY_INGREDIENT_PRICE_USD } from "@/lib/config";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { createX402GetHandler, discoveryOptionsResponse, groceryIngredientRoutesFor } from "@/lib/x402-server";
import { groceryIngredientHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // XRPL time budget: >= XRPL_ROUTE_MAX_DURATION_S

/**
 * NOT LAUNCHED while GROCERY_INGREDIENT_PRICE_USD is null (lib/config.ts): every verb answers
 * 503 not_launched, the handler never runs and no 402 is emitted. Once a price is set: unpaid
 * GET/POST -> 402 (all enabled rails); paid -> verify, run, settle only on < 400.
 */
const PRICE_SET = GROCERY_INGREDIENT_PRICE_USD !== null && GROCERY_INGREDIENT_PRICE_ATOMIC !== null;
const paymentOpts = PRICE_SET
  ? ({ maxAmountRequired: GROCERY_INGREDIENT_PRICE_ATOMIC as string, resource: "/api/grocery/ingredient", description: ROUTE_METADATA["/api/grocery/ingredient"].description } as const)
  : null;

const notLaunched = async () =>
  NextResponse.json({ ok: false, code: "not_launched", error: "/api/grocery/ingredient is not launched yet (price not set). Not charged." }, { status: 503, headers: { "Cache-Control": "no-store" } });

const paid = PRICE_SET && paymentOpts
  ? createX402GetHandler((req: NextRequest) => groceryIngredientHandler(req), groceryIngredientRoutesFor(GROCERY_INGREDIENT_PRICE_USD as string), paymentOpts)
  : notLaunched;

export const GET = paid;
export const POST = paid;

export async function OPTIONS() {
  if (!paymentOpts) return notLaunched();
  const res = await discoveryOptionsResponse(paymentOpts);
  res.headers.set("Allow", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return res;
}
