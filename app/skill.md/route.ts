import { buildSkillMarkdown } from "@/lib/agent-skill";
import { freeTierMode, skillWithFreeTier } from "@/lib/free-tier";

/**
 * GET /skill.md — agent skill (plain markdown with name/description front
 * matter) an agent can follow end to end: discover, pick a route, handle the
 * 402, pay, retry. Generated from public/openapi.json at build time, so routes
 * and prices match the live 402s. Free, static, no payment logic.
 */
export const dynamic = "force-static";

export function GET(): Response {
  const md = buildSkillMarkdown();
  // HP_FREE_TIER=optin appends the free-tier section; off -> byte-identical.
  return new Response(freeTierMode() === "optin" ? skillWithFreeTier(md) : md, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}
