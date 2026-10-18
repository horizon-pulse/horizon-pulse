import { NextRequest, NextResponse } from "next/server";
import { pricedBlock } from "@/lib/paid-rail";
import type { Tier } from "@/lib/dark-routes";
import { INJECTION_METHOD, scanInput } from "@/lib/injection-scan";
import { guardedGet } from "@/lib/guarded-get";
import { DISCLAIMER, INJECTION_DISCLAIMER_ADDENDUM } from "@/lib/dark-checks-shared";

/** DARK (HP_INJECTION_SCAN_ENABLED). Any scored answer is billed; 400/413 bad input, blocked host, 502/504 fetch errors: not charged. Every body carries the disclaimer. */
export async function injectionScanHandler(req: NextRequest, tier: Tier, receiptId: string, get: typeof guardedGet = guardedGet): Promise<NextResponse> {
  const TIER_PRICE_USD = tier.usd;
  const TIER_PRICE_ATOMIC = tier.atomicStr;
  const refuse = (status: number, code: string, error: string) =>
    NextResponse.json({ ok: false, code, error, charged: false, receiptId, disclaimer: DISCLAIMER, heuristicsNote: INJECTION_DISCLAIMER_ADDENDUM }, { status });
  let text: string | null = null;
  let url: string | null = null;
  if (req.method === "POST") {
    try {
      const b = (await req.json()) as { text?: unknown; url?: unknown };
      text = typeof b?.text === "string" ? b.text : null;
      url = typeof b?.url === "string" ? b.url : null;
    } catch {
      return refuse(400, "bad_input", "Body must be JSON {text} or {url}");
    }
  } else {
    text = req.nextUrl.searchParams.get("text");
    url = req.nextUrl.searchParams.get("url");
  }
  const r = await scanInput({ text, url }, get);
  if (!r.ok) return refuse(r.status, r.code, r.error);
  const { ok: _ok, source: inputKind, ...scan } = r;
  return NextResponse.json({
    source: "injection-scan",
    priced: pricedBlock(TIER_PRICE_USD, TIER_PRICE_ATOMIC),
    receipt: { id: receiptId, route: "/api/injection/scan", tier: tier.id, amountAtomic: tier.atomicStr, issuedAt: new Date().toISOString() },
    asOf: new Date().toISOString(),
    input: inputKind,
    ...scan,
    method: INJECTION_METHOD,
    disclaimer: DISCLAIMER,
    heuristicsNote: INJECTION_DISCLAIMER_ADDENDUM,
  });
}
