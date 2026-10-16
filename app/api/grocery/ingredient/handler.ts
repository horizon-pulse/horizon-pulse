import { NextRequest, NextResponse } from "next/server";
import { GROCERY_INGREDIENT_PRICE_ATOMIC, GROCERY_INGREDIENT_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { GI_MAX_BODY_BYTES, GROCERY_INGREDIENT_DISCLAIMER, GROCERY_INGREDIENT_METHODOLOGY, groceryIngredient, parseIngredientInput } from "@/lib/grocery-ingredient";

const bad = (status: number, code: string, error: string) =>
  NextResponse.json({ ok: false, error, code, charged: false, disclaimer: GROCERY_INGREDIENT_DISCLAIMER, methodology: GROCERY_INGREDIENT_METHODOLOGY }, { status });

async function readInput(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  if (req.method === "POST") {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > GI_MAX_BODY_BYTES) return bad(400, "body_too_large", `JSON body is limited to ${GI_MAX_BODY_BYTES} bytes`);
    try {
      const j = JSON.parse(text);
      if (!j || typeof j !== "object" || Array.isArray(j)) return bad(400, "invalid_json", "Body must be a JSON object");
      return j as Record<string, unknown>;
    } catch {
      return bad(400, "invalid_json", "Body must be valid JSON");
    }
  }
  const q = req.nextUrl.searchParams;
  return { q: q.get("q") ?? undefined, barcode: q.get("barcode") ?? undefined, n: q.get("n") ?? undefined };
}

/**
 * 400 bad input, 404 no match, 502/503 Open Food Facts down/throttled with no other match: never
 * settle, not charged. Any 200 (at least one match) is billed. No prices, no retailer contact.
 */
export async function groceryIngredientHandler(req: NextRequest): Promise<NextResponse> {
  const raw = await readInput(req);
  if (raw instanceof NextResponse) return raw;
  const parsed = parseIngredientInput(raw);
  if (!parsed.ok) return bad(parsed.status, parsed.code, parsed.error);
  const result = await groceryIngredient(parsed.input);
  if (!result.ok) return bad(result.status, result.code, result.error);
  return NextResponse.json({
    source: "grocery-ingredient",
    priced: GROCERY_INGREDIENT_PRICE_USD && GROCERY_INGREDIENT_PRICE_ATOMIC ? pricedBlock(GROCERY_INGREDIENT_PRICE_USD, GROCERY_INGREDIENT_PRICE_ATOMIC) : null,
    asOf: new Date().toISOString(),
    ...result,
  });
}
