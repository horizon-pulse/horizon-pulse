import { makeDarkRoute } from "@/lib/dark-route-runtime";
import { TRADE_GATE_TIERS } from "@/lib/dark-routes";
import { TRADE_GATE_DISCLAIMER } from "@/lib/trade-gate";
import { tradeGateHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // same paid-rail time budget as every other paid route

/** DARK: 404 unless HP_TRADE_GATE_ENABLED=true (default off). Not listed anywhere. Single base tier $0.01 (PROPOSED). */
const r = makeDarkRoute({ route: "tradegate", path: "/api/trade-gate", tiers: TRADE_GATE_TIERS, defaultTier: "base", disclaimer: TRADE_GATE_DISCLAIMER, handler: (req, tier, receiptId) => tradeGateHandler(req, tier, receiptId) });
export const GET = r.GET;
export const HEAD = r.HEAD;
export const POST = r.POST;
export const PUT = r.PUT;
export const PATCH = r.PATCH;
export const DELETE = r.DELETE;
export const OPTIONS = r.OPTIONS;
