import { makeDarkRoute } from "@/lib/dark-route-runtime";
import { INJECTION_TIERS } from "@/lib/dark-routes";
import { injectionScanHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** DARK: 404 unless HP_INJECTION_SCAN_ENABLED=true. Not listed anywhere. Single base tier (PROPOSED price). */
const r = makeDarkRoute({ route: "injection", path: "/api/injection/scan", tiers: INJECTION_TIERS, defaultTier: "base", handler: (req, tier, receiptId) => injectionScanHandler(req, tier, receiptId) });
export const GET = r.GET;
export const POST = r.POST;
export const OPTIONS = r.OPTIONS;
