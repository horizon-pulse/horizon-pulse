import { makeDarkRoute } from "@/lib/dark-route-runtime";
import { REPO_PRESSURE_TIERS } from "@/lib/dark-routes";
import { REPO_PRESSURE_DISCLAIMER } from "@/lib/repo-pressure";
import { repoPressureHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** DARK: 404 unless HP_REPO_PRESSURE_ENABLED=true (default off). Not listed anywhere. base $0.01, range $0.02. */
const r = makeDarkRoute({ route: "repopressure", path: "/api/repo-pressure", tiers: REPO_PRESSURE_TIERS, defaultTier: "base", disclaimer: REPO_PRESSURE_DISCLAIMER, handler: (req, tier, receiptId) => repoPressureHandler(req, tier, receiptId) });
export const GET = r.GET;
export const HEAD = r.HEAD;
export const POST = r.POST;
export const PUT = r.PUT;
export const PATCH = r.PATCH;
export const DELETE = r.DELETE;
export const OPTIONS = r.OPTIONS;
