import { makeDarkRoute } from "@/lib/dark-route-runtime";
import { PACKAGE_TIERS, packageTierEnabled } from "@/lib/dark-routes";
import { packageCheckHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** DARK: 404 unless HP_PACKAGE_CHECK_ENABLED=true. Not listed anywhere. tier=base|deep (PROPOSED prices); deep 404 before payment unless HP_PACKAGE_DEEP_ENABLED=true. */
const r = makeDarkRoute({ route: "pkg", path: "/api/package/check", tiers: PACKAGE_TIERS, defaultTier: "base", tierEnabled: (t) => packageTierEnabled(t), handler: (req, tier, receiptId) => packageCheckHandler(req, tier, receiptId) });
// Every method exported, so Next never answers one itself (405 / auto-OPTIONS with an Allow header).
export const GET = r.GET;
export const HEAD = r.HEAD;
export const POST = r.POST;
export const PUT = r.PUT;
export const PATCH = r.PATCH;
export const DELETE = r.DELETE;
export const OPTIONS = r.OPTIONS;
