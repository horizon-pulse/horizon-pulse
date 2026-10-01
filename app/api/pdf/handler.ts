import { NextRequest, NextResponse } from "next/server";
import { PDF_METHODOLOGY, pdfToText } from "@/lib/pdf";
import { getPayTo, PDF_PRICE_ATOMIC, PDF_PRICE_USD, USDC_BASE } from "@/lib/config";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: PDF_PRICE_ATOMIC,
  resource: "/api/pdf",
  description: ROUTE_METADATA["/api/pdf"].description,
} as const;

/** Failures return >=400 so settlement is skipped (caller not charged). */
export async function pdfHandler(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const result = await pdfToText({ url: q.get("url") ?? undefined, pages: q.get("pages") ?? undefined });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, code: result.code, charged: false, methodology: PDF_METHODOLOGY },
      { status: result.status },
    );
  }
  return NextResponse.json({
    source: "pdf",
    priced: {
      amountUsd: PDF_PRICE_USD,
      amountAtomic: PDF_PRICE_ATOMIC,
      asset: USDC_BASE,
      network: "base",
      payTo: getPayTo(),
    },
    asOf: new Date().toISOString(),
    ...result,
  });
}
