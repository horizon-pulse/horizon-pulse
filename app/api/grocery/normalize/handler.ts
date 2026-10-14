import { NextRequest, NextResponse } from "next/server";
import { GROCERY_NORMALIZE_PRICE_ATOMIC, GROCERY_NORMALIZE_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { GN_MAX_BODY_BYTES, GROCERY_NORMALIZE_METHODOLOGY, groceryNormalize, parseGroceryInput } from "@/lib/grocery-normalize";

export const paymentOpts = {
  maxAmountRequired: GROCERY_NORMALIZE_PRICE_ATOMIC,
  resource: "/api/grocery/normalize",
  description: ROUTE_METADATA["/api/grocery/normalize"].description,
} as const;

const bad = (status: number, code: string, error: string) =>
  NextResponse.json({ ok: false, error, code, charged: false, methodology: GROCERY_NORMALIZE_METHODOLOGY }, { status });

async function readInput(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  if (req.method === "POST") {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > GN_MAX_BODY_BYTES) return bad(400, "body_too_large", `JSON body is limited to ${GN_MAX_BODY_BYTES} bytes`);
    try {
      const j = JSON.parse(text);
      if (!j || typeof j !== "object" || Array.isArray(j)) return bad(400, "invalid_json", "Body must be a JSON object");
      return j as Record<string, unknown>;
    } catch {
      return bad(400, "invalid_json", "Body must be valid JSON");
    }
  }
  const q = req.nextUrl.searchParams;
  const items = q.get("ingredients");
  return {
    ingredients: items === null ? undefined : items.split("|"),
    servings: q.get("servings") ?? undefined,
    targetServings: q.get("targetServings") ?? undefined,
  };
}

/** Deterministic, no outbound calls. 400 bad input and 422 nothing parsed never settle: not charged. Any 200 is billed. */
export async function groceryNormalizeHandler(req: NextRequest): Promise<NextResponse> {
  const raw = await readInput(req);
  if (raw instanceof NextResponse) return raw;
  const parsed = parseGroceryInput(raw);
  if (!parsed.ok) return bad(parsed.status, parsed.code, parsed.error);
  const result = groceryNormalize(parsed.input);
  if (!result.ok) return bad(result.status, result.code, result.error);
  return NextResponse.json({
    source: "grocery-normalize",
    priced: pricedBlock(GROCERY_NORMALIZE_PRICE_USD, GROCERY_NORMALIZE_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
