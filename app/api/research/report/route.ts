import { NextRequest } from "next/server";
import { bareRouteResponse } from "@/lib/premium/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bare premium path: 404 while HP_PREMIUM_ENABLED is off, else 400 tier_required (spec v3.1 N2). Never a 402. */
async function handle(_req: NextRequest) {
  return bareRouteResponse("research");
}
export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
