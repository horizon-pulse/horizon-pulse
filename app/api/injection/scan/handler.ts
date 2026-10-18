import { NextRequest, NextResponse } from "next/server";
import { pricedBlock } from "@/lib/paid-rail";
import type { Tier } from "@/lib/dark-routes";
import { scanInput } from "@/lib/injection-scan";
import { guardedGet } from "@/lib/guarded-get";

/** DARK (HP_INJECTION_SCAN_ENABLED). Any scored answer is billed; 400/413 bad input, blocked host, 502/504 fetch errors: not charged. */
export async function injectionScanHandler(req: NextRequest, tier: Tier, receiptId: string, get: typeof guardedGet = guardedGet): Promise<NextResponse> {
  const TIER_PRICE_USD = tier.usd;
  const TIER_PRICE_ATOMIC = tier.atomicStr;
  let text: string | null = null;
  let url: string | null = null;
  if (req.method === "POST") {
    try {
      const b = (await req.json()) as { text?: unknown; url?: unknown };
      text = typeof b?.text === "string" ? b.text : null;
      url = typeof b?.url === "string" ? b.url : null;
    } catch {
      return NextResponse.json({ ok: false, code: "bad_input", error: "Body must be JSON {text} or {url}", charged: false, receiptId }, { status: 400 });
    }
  } else {
    text = req.nextUrl.searchParams.get("text");
    url = req.nextUrl.searchParams.get("url");
  }
  const r = await scanInput({ text, url }, get);
  if (!r.ok) return NextResponse.json({ ok: false, code: r.code, error: r.error, charged: false, receiptId }, { status: r.status });
  const { ok: _ok, source: inputKind, ...scan } = r;
  return NextResponse.json({
    source: "injection-scan",
    priced: pricedBlock(TIER_PRICE_USD, TIER_PRICE_ATOMIC),
    receipt: { id: receiptId, route: "/api/injection/scan", tier: tier.id, amountAtomic: tier.atomicStr, issuedAt: new Date().toISOString() },
    asOf: new Date().toISOString(),
    input: inputKind,
    ...scan,
  });
}
