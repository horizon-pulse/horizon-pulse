import { makeDarkRoute } from "@/lib/dark-route-runtime";
import { INJECTION_TIERS } from "@/lib/dark-routes";
import { injectionScanHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Odin 12:31 (Solana time budget): 60 s like every other paid route. The Solana paid path's worst case is 28.5 s
// (init 2.5 + verify 10 + settle 12 + on-chain check 4) plus the handler, and the XRPL worst case is 37.5 s; 30 s
// could cut a charged request off. maxDuration is a cap, not a cost: the scan's own runtime is unchanged.
export const maxDuration = 60;

/** DARK: 404 unless HP_INJECTION_SCAN_ENABLED=true. Not listed anywhere. Single base tier (PROPOSED price). */
const r = makeDarkRoute({ route: "injection", path: "/api/injection/scan", tiers: INJECTION_TIERS, defaultTier: "base", handler: (req, tier, receiptId) => injectionScanHandler(req, tier, receiptId) });
// Every method exported, so Next never answers one itself (405 / auto-OPTIONS with an Allow header).
export const GET = r.GET;
export const HEAD = r.HEAD;
export const POST = r.POST;
export const PUT = r.PUT;
export const PATCH = r.PATCH;
export const DELETE = r.DELETE;
export const OPTIONS = r.OPTIONS;
