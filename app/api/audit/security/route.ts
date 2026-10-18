import { makeDarkRoute } from "@/lib/dark-route-runtime";
import { AUDIT_TARGET_PER_MINUTE, AUDIT_TIERS } from "@/lib/dark-routes";
import { auditHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** DARK: 404 unless HP_AUDIT_SECURITY_ENABLED=true. Not listed anywhere. tier=quick|standard|extended|report|full|history|deep. */
const r = makeDarkRoute({
  route: "audit",
  path: "/api/audit/security",
  tiers: AUDIT_TIERS,
  defaultTier: "quick",
  handler: (req, tier, receiptId) => auditHandler(req, tier, receiptId),
  extraLimit: (req) => {
    const t = (req.nextUrl.searchParams.get("target") ?? req.nextUrl.searchParams.get("url") ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0];
    return t ? { key: `target:${t}`, perMinute: AUDIT_TARGET_PER_MINUTE } : null;
  },
});
export const GET = r.GET;
export const POST = r.POST;
export const OPTIONS = r.OPTIONS;
