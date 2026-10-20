import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { premiumStore } from "@/lib/premium/store";
import { reconcileOpen } from "@/lib/seller-dd/caps";
import { nonceStateTwoNode } from "@/lib/seller-dd/checks";
import { sellerDdEnabled } from "@/lib/seller-dd/config";
import { testerStatus } from "@/lib/seller-dd/testpay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Sentinel C3 reconcile: release reservations only after validBefore + nonce unused on two nodes. Flag off -> 204. Not scheduled in vercel.json yet (open item). */
export async function GET(req: NextRequest) {
  if (!sellerDdEnabled()) return new NextResponse(null, { status: 204 });
  const secret = process.env.CRON_SECRET ?? "";
  const got = /^Bearer\s+(.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const ok = secret.length >= 16 && got.length === secret.length && timingSafeEqual(Buffer.from(got), Buffer.from(secret));
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const store = premiumStore();
  const t = await testerStatus();
  if (!store || !t.ok) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const r = await reconcileOpen(store, await nonceStateTwoNode(t.address), Date.now());
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}
