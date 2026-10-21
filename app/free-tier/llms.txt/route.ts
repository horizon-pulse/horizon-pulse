import { freeTierMode, llmsWithFreeTier, readPublicDoc } from "@/lib/free-tier";
import { sellerDdEnabled } from "@/lib/seller-dd/config";
import { llmsWithSellerDd } from "@/lib/seller-dd/discovery";

/**
 * /llms.txt when HP_FREE_TIER=optin and/or seller-dd is on (next.config beforeFiles rewrite, lib/doc-rewrites.ts):
 * public/llms.txt plus the "Free tier (opt-in)" section (optin only) and the seller-dd section (seller-dd only).
 * Both off -> 404 here and /llms.txt stays the static file.
 */
export const dynamic = "force-static";

export function GET(): Response {
  const free = freeTierMode() === "optin";
  if (!free && !sellerDdEnabled()) return new Response("Not found", { status: 404 });
  const base = readPublicDoc("llms.txt");
  return new Response(llmsWithSellerDd(free ? llmsWithFreeTier(base) : base), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}
