import { NextRequest, NextResponse } from "next/server";
import { SCREENSHOT_METHODOLOGY, takeScreenshot } from "@/lib/screenshot";
import { SCREENSHOT_PRICE_ATOMIC, SCREENSHOT_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: SCREENSHOT_PRICE_ATOMIC,
  resource: "/api/screenshot",
  description: ROUTE_METADATA["/api/screenshot"].description,
} as const;

/** Failures return >=400 so settlement is skipped (caller not charged). */
export async function screenshotHandler(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const g = (k: string) => q.get(k) ?? undefined;
  const result = await takeScreenshot({
    url: g("url"),
    width: g("width"),
    height: g("height"),
    fullPage: g("fullPage"),
    format: g("format"),
    delayMs: g("delayMs"),
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, code: result.code, charged: false, methodology: SCREENSHOT_METHODOLOGY },
      { status: result.status },
    );
  }
  return NextResponse.json({
    source: "screenshot",
    priced: pricedBlock(SCREENSHOT_PRICE_USD, SCREENSHOT_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
    methodology: SCREENSHOT_METHODOLOGY,
  });
}
