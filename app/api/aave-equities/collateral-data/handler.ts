import { NextRequest, NextResponse } from "next/server";
import { pricedBlock } from "@/lib/paid-rail";
import type { Tier } from "@/lib/dark-routes";
import { readCapped } from "@/lib/aave-equities-body";
import { AAVE_EQUITIES_DISCLAIMER, AAVE_EQUITIES_SOURCES, AAVE_EQUITIES_UNTRUSTED, defaultDeps, parseInput, readCollateralData, type Deps } from "@/lib/aave-equities";

/**
 * DARK (HP_AAVE_EQUITIES_ENABLED). GET query or POST JSON {token?, collateral_amount?, debt_usdc?}.
 * A 200 answer is billed; bad input (400/413) and RPC down / unexpected onchain state (502) are not.
 * Nothing from the request is stored or logged. Market data only (Counsel review pending).
 */
export const AAVE_EQUITIES_MAX_BODY_BYTES = 4 * 1024;
export async function aaveEquitiesHandler(req: NextRequest, tier: Tier, receiptId: string, deps: Deps = defaultDeps()): Promise<NextResponse> {
  const TIER_PRICE_USD = tier.usd;
  const TIER_PRICE_ATOMIC = tier.atomicStr;
  const refuse = (status: number, code: string, error: string) =>
    NextResponse.json({ ok: false, code, error, charged: false, receiptId, disclaimer: AAVE_EQUITIES_DISCLAIMER }, { status });
  let raw: Record<string, unknown>;
  if (req.method === "POST") {
    const body = await readCapped(req, AAVE_EQUITIES_MAX_BODY_BYTES);
    if (body === "too_large") return refuse(413, "too_large", `Body is over ${AAVE_EQUITIES_MAX_BODY_BYTES} bytes`);
    if (body === null) return refuse(400, "bad_input", "Body could not be read");
    if (body.trim() === "") raw = {};
    else {
      try {
        const j: unknown = JSON.parse(body);
        if (!j || typeof j !== "object" || Array.isArray(j)) return refuse(400, "bad_input", "Body must be a JSON object");
        raw = j as Record<string, unknown>;
      } catch {
        return refuse(400, "bad_input", "Body must be JSON");
      }
    }
  } else {
    const q = req.nextUrl.searchParams;
    raw = { token: q.get("token"), collateral_amount: q.get("collateral_amount"), debt_usdc: q.get("debt_usdc") };
  }
  const p = parseInput(raw);
  if (!p.ok) return refuse(400, "bad_input", p.error);
  const r = await readCollateralData(p.input, deps);
  if (!r.ok) return refuse(r.status, r.code, r.error);
  const { ok: _ok, ...data } = r;
  return NextResponse.json({
    source: "aave-equities-collateral-data",
    priced: pricedBlock(TIER_PRICE_USD, TIER_PRICE_ATOMIC),
    receipt: { id: receiptId, route: "/api/aave-equities/collateral-data", tier: tier.id, amountAtomic: tier.atomicStr, issuedAt: new Date(deps.now()).toISOString() },
    ...data,
    sources: AAVE_EQUITIES_SOURCES,
    untrusted: AAVE_EQUITIES_UNTRUSTED,
    disclaimer: AAVE_EQUITIES_DISCLAIMER,
  });
}
