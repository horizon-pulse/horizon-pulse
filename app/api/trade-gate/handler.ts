import { NextRequest, NextResponse } from "next/server";
import { pricedBlock } from "@/lib/paid-rail";
import type { Tier } from "@/lib/dark-routes";
import { evaluateTradeGate, TRADE_GATE_DISCLAIMER, TRADE_GATE_HASH_NOTE, TRADE_GATE_ID_NOTE, TRADE_GATE_MAX_BODY_BYTES, TRADE_GATE_RULES_NOTE } from "@/lib/trade-gate";

/**
 * DARK (HP_TRADE_GATE_ENABLED). POST JSON only. A checked answer is billed; bad input (400/413/405-as-400) is not.
 * Counsel E6/E7: nothing from the request or the response is stored or logged here; hashes go back to the caller only.
 * The input (order, account, rules, attestations) is never echoed back.
 */
export async function tradeGateHandler(req: NextRequest, tier: Tier, receiptId: string, now: () => Date = () => new Date()): Promise<NextResponse> {
  const TIER_PRICE_USD = tier.usd;
  const TIER_PRICE_ATOMIC = tier.atomicStr;
  const refuse = (status: number, code: string, error: string) =>
    NextResponse.json({ ok: false, code, error, charged: false, receiptId, disclaimer: TRADE_GATE_DISCLAIMER }, { status });
  if (req.method !== "POST") return refuse(400, "bad_input", "POST a JSON body {order, account, rules, attestations, as_of}");
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return refuse(400, "bad_input", "Body could not be read");
  }
  if (Buffer.byteLength(raw, "utf8") > TRADE_GATE_MAX_BODY_BYTES) return refuse(413, "too_large", `Body is over ${TRADE_GATE_MAX_BODY_BYTES} bytes`);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse(400, "bad_input", "Body must be JSON");
  }
  const r = evaluateTradeGate(body, now());
  if (!r.ok) return refuse(r.status, r.code, r.error);
  const { ok: _ok, ...result } = r;
  const issuedAt = now().toISOString();
  return NextResponse.json({
    source: "trade-gate",
    priced: pricedBlock(TIER_PRICE_USD, TIER_PRICE_ATOMIC),
    receipt: { id: receiptId, route: "/api/trade-gate", tier: tier.id, amountAtomic: tier.atomicStr, issuedAt },
    ...result,
    notes: { rules: TRADE_GATE_RULES_NOTE, hashes: TRADE_GATE_HASH_NOTE, ids: TRADE_GATE_ID_NOTE },
    disclaimer: TRADE_GATE_DISCLAIMER,
  });
}
