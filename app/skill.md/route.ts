import { buildSkillMarkdown } from "@/lib/agent-skill";

/**
 * GET /skill.md — agent skill (plain markdown with name/description front
 * matter) an agent can follow end to end: discover, pick a route, handle the
 * 402, pay, retry. Generated from public/openapi.json at build time, so routes
 * and prices match the live 402s. Free, static, no payment logic.
 */
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(buildSkillMarkdown(), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}
