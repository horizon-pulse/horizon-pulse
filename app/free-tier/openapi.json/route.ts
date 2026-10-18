import { freeTierMode, openApiWithFreeTier, readPublicDoc } from "@/lib/free-tier";

/**
 * /openapi.json when HP_FREE_TIER=optin (next.config beforeFiles rewrite): public/openapi.json
 * plus x-free-tier (top level and on the 7 free-tier GETs) and the copy in info.description.
 * Off -> 404 here and /openapi.json stays the static file.
 */
export const dynamic = "force-static";

export function GET(): Response {
  if (freeTierMode() !== "optin") return new Response("Not found", { status: 404 });
  return new Response(`${JSON.stringify(openApiWithFreeTier(JSON.parse(readPublicDoc("openapi.json"))), null, 2)}\n`, {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}
