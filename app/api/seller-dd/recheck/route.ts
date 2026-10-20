import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { premiumStore } from "@/lib/premium/store";
import { sellerDdEnabled } from "@/lib/seller-dd/config";
import { runRecheck } from "@/lib/seller-dd/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Counsel D3 re-check (operator-only). POST {"id":"dd_..."} with `Authorization: Bearer <CRON_SECRET>` (existing secret;
 * no new env). Flag off -> 404 before any secret/store access. Wrong/missing auth -> 401 with no store access.
 */
export async function POST(req: NextRequest) {
  if (!sellerDdEnabled()) return new NextResponse("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const secret = process.env.CRON_SECRET ?? "";
  const got = /^Bearer\s+(.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const ok = secret.length >= 16 && got.length === secret.length && timingSafeEqual(Buffer.from(got), Buffer.from(secret));
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let id = "";
  try { const b = JSON.parse((await req.text()).slice(0, 1024)); id = typeof b?.id === "string" ? b.id : ""; } catch { id = ""; }
  const store = premiumStore();
  if (!store) return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  const r = await runRecheck(store, id);
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
