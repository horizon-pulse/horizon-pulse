import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { premiumStore } from "@/lib/premium/store";
import { sellerDdEnabled } from "@/lib/seller-dd/config";
import { openDispute, resolveDispute, VERDICT_ID_RE } from "@/lib/seller-dd/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Counsel retention ruling: open/resolve a dispute hold (operator-only, same HP_DD_RECHECK_SECRET rules: unset, short
 * or equal to CRON_SECRET -> 401). POST {"id":"dd_...","action":"open"|"resolve"}. Flag off -> 404 first.
 */
export async function POST(req: NextRequest) {
  if (!sellerDdEnabled()) return new NextResponse("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const secret = process.env.HP_DD_RECHECK_SECRET ?? ""; // Odin V1: dedicated secret; unset/short -> refuse everything
  const got = /^Bearer\s+(.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const sameAsCron = secret !== "" && secret === (process.env.CRON_SECRET ?? ""); // Sentinel INFO-2: shared secret -> refuse all
  const ok = !sameAsCron && secret.length >= 16 && got.length === secret.length && timingSafeEqual(Buffer.from(got), Buffer.from(secret));
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let id = ""; let action = "";
  try { const b = JSON.parse((await req.text()).slice(0, 1024)); id = typeof b?.id === "string" ? b.id : ""; action = typeof b?.action === "string" ? b.action : ""; } catch { id = ""; }
  const store = premiumStore();
  if (!store) return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  if (!VERDICT_ID_RE.test(id) || (action !== "open" && action !== "resolve")) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const r = await (action === "open" ? openDispute : resolveDispute)(store, id, Date.now()).catch(() => ({ ok: false as const, status: 503, error: "store_unavailable" }));
  return NextResponse.json(r.ok ? { id, ...r } : { error: r.error }, { status: r.ok ? 200 : r.status, headers: { "Cache-Control": "no-store" } });
}
