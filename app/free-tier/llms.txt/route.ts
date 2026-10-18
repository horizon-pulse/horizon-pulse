import { freeTierMode, llmsWithFreeTier, readPublicDoc } from "@/lib/free-tier";

/**
 * /llms.txt when HP_FREE_TIER=optin (next.config beforeFiles rewrite): public/llms.txt
 * plus the "Free tier (opt-in)" section. Off -> 404 here and /llms.txt stays the static file.
 */
export const dynamic = "force-static";

export function GET(): Response {
  if (freeTierMode() !== "optin") return new Response("Not found", { status: 404 });
  return new Response(llmsWithFreeTier(readPublicDoc("llms.txt")), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}
