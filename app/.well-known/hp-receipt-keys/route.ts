import { NextResponse } from "next/server";
import { receiptPublicKeys } from "@/lib/receipt-signer";
import { sellerDdEnabled } from "@/lib/seller-dd/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public verify keys for signed receipts (spec §10). 404 until seller-dd is enabled and the receipt key is set. */
export function GET() {
  const k = sellerDdEnabled() ? receiptPublicKeys() : null;
  if (!k) return new NextResponse("Not Found", { status: 404 });
  return NextResponse.json(k, { headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
}
