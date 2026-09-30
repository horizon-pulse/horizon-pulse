import { NextRequest, NextResponse } from "next/server";
import { SCREENSHOT_METHODOLOGY, takeScreenshot } from "@/lib/screenshot";
import { getPayTo, SCREENSHOT_PRICE_ATOMIC, SCREENSHOT_PRICE_USD, USDC_BASE } from "@/lib/config";

export const paymentOpts = {
  maxAmountRequired: SCREENSHOT_PRICE_ATOMIC,
  resource: "/api/screenshot",
  description:
    "Render a public URL in headless Chromium (?url=...&width&height&fullPage&format) → PNG/JPEG as base64 JSON + final URL, page status, title (SSRF-safe, capped)",
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
    priced: { amountUsd: SCREENSHOT_PRICE_USD, amountAtomic: SCREENSHOT_PRICE_ATOMIC, asset: USDC_BASE, network: "base", payTo: getPayTo() },
    asOf: new Date().toISOString(),
    ...result,
    methodology: SCREENSHOT_METHODOLOGY,
  });
}
