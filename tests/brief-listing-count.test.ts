import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { catalogStats, LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import { premiumListings, BRIEF_LISTING } from "@/lib/premium/listing";
import { buildMcpServer, VERIFIED_BRIEF_TOOL } from "@/lib/mcp-server";
import { buildSkillMarkdown, loadSkillRoutes } from "@/lib/agent-skill";
import { BRIEF_DESCRIPTION } from "@/lib/premium/copy";

afterEach(() => vi.unstubAllEnvs());
const on = () => { vi.stubEnv("HP_PREMIUM_ENABLED", "true"); vi.stubEnv("HP_PREMIUM_TIERS", "brief"); };
const oa = JSON.parse(readFileSync("public/openapi.json", "utf8"));
const llms = readFileSync("public/llms.txt", "utf8");
const toolNames = (s: ReturnType<typeof buildMcpServer>) => Object.keys((s as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);

describe("paid-route count includes the live $1 verified brief everywhere", () => {
  it("catalogStats: 29 + brief = 30 when live; 29 when off", () => {
    expect(catalogStats().paidRoutes).toBe(LIVE_PAID_ROUTES.length);
    on();
    expect(premiumListings().map((x) => x.id)).toEqual(["brief"]);
    expect(catalogStats().paidRoutes).toBe(LIVE_PAID_ROUTES.length + 1);
  });
  it("openapi: paid paths = catalog + brief; brief is Base-only via x-premium-payment-info; no $5/$10", () => {
    const paid = Object.entries<any>(oa.paths).filter(([, v]) => Object.values<any>(v).some((o) => o.responses?.["402"])).map(([p]) => p);
    expect(paid.length).toBe(LIVE_PAID_ROUTES.length + 1);
    const b = oa.paths[BRIEF_LISTING.path].get;
    expect(b["x-payment-info"]).toBeUndefined();
    expect(b["x-premium-payment-info"]).toMatchObject({ network: "eip155:8453", amount: "1000000", payTo: "0x5b32c973596078a967562ca652761404f19be0e9" });
    expect(b.description.startsWith(BRIEF_DESCRIPTION)).toBe(true);
    expect(JSON.stringify(oa)).not.toMatch(/research\/report\/(standard|extended)|xai|grok/i);
    expect(loadSkillRoutes().length).toBe(LIVE_PAID_ROUTES.length); // multi-network table stays 29
  });
  it("llms.txt: stated 30, lists the brief, says unpaid samples", () => {
    expect(llms).toContain(`${LIVE_PAID_ROUTES.length + 1} paid routes: the ${LIVE_PAID_ROUTES.length} in this table`);
    expect(llms).toContain("| GET | /api/research/report/brief?q=… | $1 | 1000000 |");
    expect(llms).toContain("/contracts/brief-verified");
    expect(llms).toContain("/premium-terms");
    expect(llms).not.toMatch(/free samples?/i);
    expect(llms).not.toMatch(/\bxai\b/i);
  });
  it("skill.md: 30 when live", () => {
    on();
    expect(buildSkillMarkdown()).toContain(`${LIVE_PAID_ROUTES.length + 1} paid routes.`);
  });
  it("hosted MCP: verified_brief_quote only when live; returns the unpaid 402, never pays", async () => {
    expect(toolNames(buildMcpServer())).not.toContain("verified_brief_quote");
    on();
    const names = toolNames(buildMcpServer());
    expect(names).toContain("verified_brief_quote");
    expect(names.filter((n) => /standard|extended/.test(n))).toEqual([]);
    expect(VERIFIED_BRIEF_TOOL.description).toContain("this tool never runs the brief or pays");
    expect(VERIFIED_BRIEF_TOOL.description).not.toMatch(/xai|grok/i);
  });
});
