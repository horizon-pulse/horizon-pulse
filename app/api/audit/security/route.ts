import { makeDarkRoute } from "@/lib/dark-route-runtime";
import { AUDIT_TIERS, auditTierEnabled } from "@/lib/dark-routes";
import { auditHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** DARK: 404 unless HP_AUDIT_SECURITY_ENABLED=true. Not listed anywhere. tier=quick|standard|extended|report; full|history|deep are 404 unless HP_AUDIT_HIGH_TIERS_ENABLED=true (separate flag, default off). */
const r = makeDarkRoute({
  route: "audit",
  path: "/api/audit/security",
  tiers: AUDIT_TIERS,
  defaultTier: "quick",
  tierEnabled: (t) => auditTierEnabled(t),
  handler: (req, tier, receiptId) => auditHandler(req, tier, receiptId),
});
export const GET = r.GET;
export const POST = r.POST;
export const OPTIONS = r.OPTIONS;
