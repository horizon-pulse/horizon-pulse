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
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (!/^\d+$/.test(declared.trim()) || !Number.isFinite(n)) return refuse(400, "bad_input", "Content-Length is invalid");
    if (n > TRADE_GATE_MAX_BODY_BYTES) return refuse(413, "too_large", `Body is over ${TRADE_GATE_MAX_BODY_BYTES} bytes`);
  }
  const read = await readCappedBody(req, TRADE_GATE_MAX_BODY_BYTES);
  if (read === "too_large") return refuse(413, "too_large", `Body is over ${TRADE_GATE_MAX_BODY_BYTES} bytes`);
  if (read === null) return refuse(400, "bad_input", "Body could not be read");
  const raw = read;
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

/** Streams the body and stops as soon as it passes `max` bytes (Sentinel LOW-1: never buffer an oversized body). */
export async function readCappedBody(req: Request, max: number): Promise<string | "too_large" | null> {
  try {
    if (!req.body) return "";
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}
