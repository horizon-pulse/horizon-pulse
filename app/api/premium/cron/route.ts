import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { cronSweep, jobNow } from "@/lib/premium/jobs";
import { premiumStore } from "@/lib/premium/store";
import { premiumAsyncEnabled } from "@/lib/premium/tiers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily premium cron (vercel.json, Hobby-compatible: once a day). Purge + recovery + watch days + resolution (Q4).
 * Flag off -> 204, no KV. Then `Authorization: Bearer <CRON_SECRET>` (Vercel sends it for crons) must match exactly
 * (non-empty, constant-time); otherwise 401 with no KV access. HP_PREMIUM_WATCH_PAUSE=true -> watch checks skipped
 * (a skipped day becomes missed when its window closes: honest pro rata).
 */
export async function GET(req: NextRequest) {
  if (!premiumAsyncEnabled()) return new NextResponse(null, { status: 204 });
  const secret = process.env.CRON_SECRET ?? "";
  const got = /^Bearer\s+(.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const ok = secret.length >= 16 && got.length === secret.length && timingSafeEqual(Buffer.from(got), Buffer.from(secret));
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const store = premiumStore();
  if (!store) return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  const r = await cronSweep(store, jobNow() + 50_000, { watchPause: process.env.HP_PREMIUM_WATCH_PAUSE === "true" });
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}
