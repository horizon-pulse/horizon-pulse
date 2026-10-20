import { NextRequest } from "next/server";
import { premiumHandler, premiumOptions } from "@/lib/premium/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // spec §5: 50 s work + ~10 s settle reserve

type Ctx = { params: Promise<{ tier: string }> };

/** Premium tier URL (spec v3.2). INERT (404) unless HP_PREMIUM_ENABLED=true. Base-only, not on MCP (N1). */
async function handle(req: NextRequest, ctx: Ctx) {
  const { tier } = await ctx.params;
  return premiumHandler(req, "seller-watch", tier);
}
export const GET = handle;
export const POST = handle;
export async function OPTIONS(_req: NextRequest, ctx: Ctx) {
  const { tier } = await ctx.params;
  return premiumOptions("seller-watch", tier);
}
