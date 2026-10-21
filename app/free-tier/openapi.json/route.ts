import { freeTierMode, openApiWithFreeTier, readPublicDoc } from "@/lib/free-tier";
import { sellerDdEnabled } from "@/lib/seller-dd/config";
import { openApiWithSellerDd } from "@/lib/seller-dd/discovery";

/**
 * /openapi.json when HP_FREE_TIER=optin and/or seller-dd is on (next.config beforeFiles rewrite, lib/doc-rewrites.ts):
 * public/openapi.json plus x-free-tier (optin only) and the /api/seller-dd/single path (seller-dd only).
 * Both off -> 404 here and /openapi.json stays the static file.
 */
export const dynamic = "force-static";

export function GET(): Response {
  const free = freeTierMode() === "optin";
  if (!free && !sellerDdEnabled()) return new Response("Not found", { status: 404 });
  const base = JSON.parse(readPublicDoc("openapi.json"));
  return new Response(`${JSON.stringify(openApiWithSellerDd(free ? openApiWithFreeTier(base) : base), null, 2)}\n`, {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}
