/** money-market-rates wiring: FREE route on /docs, openapi, llms.txt and hosted MCP; never paid, never in x402 discovery. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MMR_DISCLAIMER, MMR_DESCRIPTION } from "@/lib/money-market-rates";

const ROOT = path.resolve(__dirname, "..");
const spec = JSON.parse(readFileSync(path.join(ROOT, "public", "openapi.json"), "utf8"));
const llms = readFileSync(path.join(ROOT, "public", "llms.txt"), "utf8");

describe("disclaimer wording", () => {
  it("names both NY Fed and Federal Reserve, pass-through unchanged, may not be current; no stress read", () => {
    expect(MMR_DISCLAIMER).toContain("Horizon Pulse is not affiliated with the New York Fed. The New York Fed does not sanction, endorse, or recommend any products or services offered by Horizon Pulse.");
    expect(MMR_DISCLAIMER).toContain("not affiliated with the Federal Reserve System");
    expect(MMR_DISCLAIMER).toContain("passed through unchanged");
    expect(MMR_DISCLAIMER).toContain("may not be current");
    expect(MMR_DESCRIPTION).toContain(MMR_DISCLAIMER);
    expect(MMR_DESCRIPTION).not.toMatch(/stress|spread|score/i);
  });
});

describe("openapi + docs + llms", () => {
  const op = spec.paths["/api/money-market-rates"]?.get;
  it("openapi documents it as free: no x-payment-info, security [], no 402, disclaimer present", () => {
    expect(op).toBeDefined();
    expect(op["x-payment-info"]).toBeUndefined();
    expect(op["x-free"]).toBe(true);
    expect(op.security).toEqual([]);
    expect(op.responses["402"]).toBeUndefined();
    expect(op.description).toContain(MMR_DISCLAIMER);
    expect(op.responses["200"].description).toContain(MMR_DISCLAIMER);
  });
  it("paid counts: 22 paid paths (16 + discourse/split + tx-status + tokenized-stock + watch + balance + tx-guard); 1 free path", () => {
    const paidPaths = Object.entries<Record<string, Record<string, unknown>>>(spec.paths).filter(([, it]) => Object.values(it).some((o) => o["x-payment-info"]));
    const freePaths = Object.entries<Record<string, Record<string, unknown>>>(spec.paths).filter(([, it]) => Object.values(it).some((o) => o["x-free"]));
    expect(paidPaths).toHaveLength(22);
    expect(freePaths.map(([p]) => p)).toEqual(["/api/money-market-rates"]);
  });
  it("llms.txt lists it as FREE with the exact disclaimer", () => {
    expect(llms).toContain("GET `/api/money-market-rates` — FREE (no x402, no 402)");
    expect(llms).toContain(MMR_DISCLAIMER);
  });
  it("/docs renders the free section from openapi (source check)", () => {
    const src = readFileSync(path.join(ROOT, "app", "docs", "page.tsx"), "utf8");
    expect(src).toContain('op["x-free"]');
    expect(src).toContain("Free data (no payment)");
  });
  it("skill.md routes (paid) skip it", async () => {
    const { loadSkillRoutes } = await import("@/lib/agent-skill");
    const r = loadSkillRoutes();
    expect(r.some((x) => x.tool.includes("money"))).toBe(false);
    expect(new Set(r.map((x) => x.tool)).size).toBe(22);
  });
});

describe("x402 discovery excludes it", () => {
  it("/.well-known/x402 resources do not list money-market-rates (22 paid paths stay: 16 + discourse/split + tx-status + tokenized-stock + watch + balance + tx-guard; plain URLs since hygiene a)", async () => {
    const { GET } = await import("@/app/.well-known/x402/route");
    const res = await (GET as unknown as () => Promise<Response>)();
    const j = await res.json();
    expect(j.resources.some((x: string) => x.includes("money-market"))).toBe(false);
    expect(j.resources).toHaveLength(22);
  });
});

describe("hosted MCP", () => {
  it("23 tools: 22 paid (TOOLS) + 1 free money_market_rates with the disclaimer", async () => {
    const { TOOLS, FREE_TOOLS, buildMcpServer } = await import("@/lib/mcp-server");
    expect(TOOLS).toHaveLength(22);
    expect(TOOLS.some((t) => t.name === "money_market_rates")).toBe(false);
    expect(FREE_TOOLS.map((t) => t.name)).toEqual(["money_market_rates"]);
    expect(FREE_TOOLS[0].description).toContain(MMR_DISCLAIMER);
    const server = buildMcpServer() as unknown as { _registeredTools: Record<string, unknown> };
    expect(Object.keys(server._registeredTools)).toHaveLength(23);
  });
  it("free tool call returns the route's answer, never an x402 challenge", async () => {
    const { FREE_TOOLS } = await import("@/lib/mcp-server");
    const r = await FREE_TOOLS[0].call({ startDate: "2026-10-01" }); // 400 locally, no network
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("bad_request");
    expect(r.content[0].text).not.toMatch(/x402Version|accepts/);
  });
});

describe("Odin 10/12 9:20 fixes", () => {
  it("response body (REST and MCP) carries the full disclaimer in terms", async () => {
    const { termsBlock } = await import("@/lib/money-market-rates");
    const body = JSON.stringify(termsBlock(2026, ["EFFR"]));
    for (const s of ["Federal Reserve System", "may not be current", "free at"]) expect(body).toContain(s);
    const { FREE_TOOLS } = await import("@/lib/mcp-server");
    const { vi } = await import("vitest");
    const mod = await import("@/lib/money-market-rates");
    const spy = vi.spyOn(mod, "moneyMarketRates").mockImplementation(async (q) => ({ terms: mod.termsBlock(2026, q.rates) }) as never);
    const r = await FREE_TOOLS[0].call({ rates: "EFFR" });
    spy.mockRestore();
    for (const s of ["Federal Reserve System", "may not be current", "free at"]) expect(r.content[0].text).toContain(s);
  });
  it("MCP forwards the caller IP (x-real-ip, else first XFF) to the route", async () => {
    const { FREE_TOOLS, withMcpCaller, mcpClientIp } = await import("@/lib/mcp-server");
    expect(mcpClientIp(new Headers({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("9.9.9.9");
    expect(mcpClientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("1.1.1.1");
    expect(mcpClientIp(new Headers())).toBeUndefined();
    const { vi } = await import("vitest");
    const mod = await import("@/lib/money-market-rates");
    const seen: (string | undefined)[] = [];
    const spy = vi.spyOn(mod, "moneyMarketRates").mockImplementation(async (_q, d) => { seen.push(d.clientIp); return {} as never; });
    await withMcpCaller(new Request("https://horizonpulse.dev/mcp", { headers: { "x-forwarded-for": "4.4.4.4, 10.0.0.1" } }), () => FREE_TOOLS[0].call({}));
    await withMcpCaller(new Request("https://horizonpulse.dev/mcp", { headers: { "x-real-ip": "5.5.5.5" } }), () => FREE_TOOLS[0].call({}));
    spy.mockRestore();
    expect(seen).toEqual(["4.4.4.4", "5.5.5.5"]);
  });
});
