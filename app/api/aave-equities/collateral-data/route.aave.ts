import { makeDarkRoute } from "@/lib/dark-route-runtime";
import { AAVE_EQUITIES_TIERS } from "@/lib/dark-routes";
import { AAVE_EQUITIES_DISCLAIMER } from "@/lib/aave-equities";
import { aaveEquitiesHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // same paid-rail time budget as every other paid route

/** DARK: 404 unless HP_AAVE_EQUITIES_ENABLED=true (default off). Not listed anywhere. Single base tier $0.01. */
const r = makeDarkRoute({ route: "aaveequities", path: "/api/aave-equities/collateral-data", tiers: AAVE_EQUITIES_TIERS, defaultTier: "base", disclaimer: AAVE_EQUITIES_DISCLAIMER, handler: (req, tier, receiptId) => aaveEquitiesHandler(req, tier, receiptId) });
export const GET = r.GET;
export const HEAD = r.HEAD;
export const POST = r.POST;
export const PUT = r.PUT;
export const PATCH = r.PATCH;
export const DELETE = r.DELETE;
export const OPTIONS = r.OPTIONS;
