import { NextResponse } from "next/server";
import { tierAllowed } from "@/lib/premium/tiers";
import demo from "@/lib/premium/demo-brief-verified.json";
import { ADVICE_DISCLAIMER } from "@/lib/premium/synthesis";
import { BRIEF_VERIFIED_SENTENCE } from "@/lib/premium/copy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Free, labelled recording of a real verified-brief response (spec §7.4 / Odin checklist 5). 404 while premium is off. */
export async function GET() {
  if (!tierAllowed("brief")) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Round 7 (Claude §3 #4): same disclaimer field the live brief response carries (research.ts runVerifiedBrief).
  return NextResponse.json({ ...demo, disclaimer: `${ADVICE_DISCLAIMER} ${BRIEF_VERIFIED_SENTENCE}` }, { headers: { "cache-control": "public, max-age=300", "x-hp-demo": "recording" } });
}
