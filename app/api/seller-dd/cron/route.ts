import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { persistAlert } from "@/lib/alert-persist";
import { premiumStore } from "@/lib/premium/store";
import { reconcileOpen } from "@/lib/seller-dd/caps";
import { nonceStateTwoNode } from "@/lib/seller-dd/checks";
import { sellerDdEnabled } from "@/lib/seller-dd/config";
import { testerStatus } from "@/lib/seller-dd/testpay";
import { reconcileUnconfirmed } from "@/lib/seller-dd/handler";
import { defaultWatchRpc, runWatch, type Rpc } from "@/lib/seller-dd/watch";
import type { NonceState } from "@/lib/seller-dd/caps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

let testOverrides: { rpc?: Rpc; nonceState?: (n: string) => Promise<NonceState>; now?: () => number } | null = null;
export function setSellerDdCronForTests(o: typeof testOverrides) { testOverrides = o; }

/**
 * Daily seller-dd cron (vercel.json "41 13 * * *", Hobby-compatible once a day):
 *   1. Sentinel C3 reconcile: release reservations only after validBefore + nonce unused on two nodes.
 *   2. Sentinel L-5 on-chain watch on the dd-tester (HIGH alerts, persisted to hp:alerts:premium).
 * Flag off -> 204 before ANY env secret, store or RPC access. Then `Authorization: Bearer <CRON_SECRET>` must match
 * (non-empty, >= 16 chars, constant-time), else 401 with no store access.
 */
export async function GET(req: NextRequest) {
  if (!sellerDdEnabled()) return new NextResponse(null, { status: 204 });
  const secret = process.env.CRON_SECRET ?? "";
  const got = /^Bearer\s+(.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const ok = secret.length >= 16 && got.length === secret.length && timingSafeEqual(Buffer.from(got), Buffer.from(secret));
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const store = premiumStore();
  const t = await testerStatus();
  if (!store || !t.ok) {
    const kind = !t.ok && t.code === "tester_address_mismatch" ? "seller_dd_tester_address_mismatch" : "seller_dd_cron_unavailable";
    console.error(`[seller-dd][ALERT][HIGH] ${JSON.stringify({ kind, severity: "high", route: "/api/seller-dd/cron" })}`);
    persistAlert("premium", { kind, severity: "high", route: "/api/seller-dd/cron", payer: null });
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  const now = testOverrides?.now?.() ?? Date.now();
  const reconcile = await reconcileOpen(store, testOverrides?.nonceState ?? (await nonceStateTwoNode(t.address)), now).catch(() => ({ error: "reconcile_failed" }));
  const unconfirmed = await reconcileUnconfirmed(store, now).catch(() => ({ error: "unconfirmed_reconcile_failed" }));
  const watch = await runWatch(store, t.address, testOverrides?.rpc ?? defaultWatchRpc());
  for (const a of watch.alerts) {
    console.error(`[seller-dd][ALERT][HIGH] ${JSON.stringify({ ...a, route: "/api/seller-dd/cron" })}`);
    persistAlert("premium", { kind: a.kind, severity: "high", route: "/api/seller-dd/cron", payer: null }, { exemptFromCap: true });
  }
  return NextResponse.json({ reconcile, unconfirmed, watch: { ok: watch.ok, from_block: watch.from_block, to_block: watch.to_block, alerts: watch.alerts.map((a) => a.kind) } }, { headers: { "Cache-Control": "no-store" } });
}
