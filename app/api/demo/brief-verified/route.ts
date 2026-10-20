import { NextResponse } from "next/server";
import { premiumEnabled } from "@/lib/premium/tiers";
import demo from "@/lib/premium/demo-brief-verified.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Free, labelled recording of a real verified-brief response (spec §7.4 / Odin checklist 5). 404 while premium is off. */
export async function GET() {
  if (!premiumEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(demo, { headers: { "cache-control": "public, max-age=300", "x-hp-demo": "recording" } });
}
