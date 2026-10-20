import { NextRequest, NextResponse } from "next/server";
import { premiumStore } from "@/lib/premium/store";
import { sellerDdEnabled } from "@/lib/seller-dd/config";
import { VERDICT_ID_RE, verifyView } from "@/lib/seller-dd/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Counsel D3 verify endpoint (free, read-only): GET ?id=dd_<24 hex> -> status current|superseded, superseded_by,
 * supersedes, verdict_sha256 (sha256 of the canonical signed verdict), kid. Never returns verdict contents or paid data.
 * 404 unless the seller-dd flags are on.
 */
export async function GET(req: NextRequest) {
  if (!sellerDdEnabled()) return new NextResponse("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const h = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  if (!VERDICT_ID_RE.test(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400, headers: h });
  const store = premiumStore();
  if (!store) return NextResponse.json({ error: "store_unavailable" }, { status: 503, headers: h });
  const v = await verifyView(store, id).catch(() => undefined);
  if (v === undefined) return NextResponse.json({ error: "store_unavailable" }, { status: 503, headers: h });
  if (!v) return NextResponse.json({ error: "unknown_verdict" }, { status: 404, headers: h });
  return NextResponse.json({ ...v, check: "Recompute sha256 over canonical JSON of the verdict you hold (including sig) and compare to verdict_sha256; verify sig with /.well-known/hp-receipt-keys." }, { headers: h });
}
