import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as researchTier from "@/app/api/research/report/[tier]/route";
import * as researchBare from "@/app/api/research/report/route";
import * as watchTier from "@/app/api/seller-watch/[tier]/route";
import * as watchBare from "@/app/api/seller-watch/route";
import * as wellKnown from "@/app/.well-known/x402/route";
import * as skill from "@/app/skill.md/route";
import * as llms from "@/app/free-tier/llms.txt/route";
import * as openapi from "@/app/free-tier/openapi.json/route";
import * as mcp from "@/app/mcp/route";
import { allowedTierIds, listedTiers, PREMIUM_TIERS, tierAllowed } from "@/lib/premium/tiers";

const OTHERS = ["standard", "extended", "report", "monitor", "watch", "watch-report"];
function call(id: string, method = "GET", q = "q=How%20much%20USDC%20is%20in%20circulation") {
  const watch = id.startsWith("watch");
  const base = watch ? "/api/seller-watch" : "/api/research/report";
  const req = new NextRequest(`https://horizonpulse.dev${base}/${id}?${watch ? "target=https://example.com/x" : q}`, { method });
  const mod = watch ? watchTier : researchTier;
  const ctx = { params: Promise.resolve({ tier: id }) };
  return (method === "OPTIONS" ? mod.OPTIONS(req, ctx) : mod.GET(req, ctx)) as Promise<Response>;
}
const text = async (r: Response | Promise<Response>) => (await r).text();
const set = (tiers?: string) => { vi.stubEnv("HP_PREMIUM_ENABLED", "true"); if (tiers !== undefined) vi.stubEnv("HP_PREMIUM_TIERS", tiers); else vi.stubEnv("HP_PREMIUM_TIERS", undefined as unknown as string); };
afterEach(() => vi.unstubAllEnvs());

describe("HP_PREMIUM_TIERS allowlist (fail closed)", () => {
  it("parses a comma list; unset/empty gives no tiers", () => {
    expect([...allowedTierIds({ HP_PREMIUM_TIERS: " brief , " })]).toEqual(["brief"]);
    expect(allowedTierIds({}).size).toBe(0);
    expect(allowedTierIds({ HP_PREMIUM_TIERS: "" }).size).toBe(0);
    expect(tierAllowed("brief", { HP_PREMIUM_TIERS: "brief" })).toBe(false); // premium off
    expect(tierAllowed("brief", { HP_PREMIUM_ENABLED: "true", HP_PREMIUM_TIERS: "brief" })).toBe(true);
  });

  for (const v of [undefined, ""]) {
    it(`premium on, HP_PREMIUM_TIERS=${JSON.stringify(v)}: every tier, bare route and OPTIONS is 404; nothing listed`, async () => {
      set(v);
      for (const x of PREMIUM_TIERS) {
        expect((await call(x.id)).status).toBe(404);
        expect((await call(x.id, "OPTIONS")).status).toBe(404);
      }
      expect((await researchBare.GET(new NextRequest("https://horizonpulse.dev/api/research/report"))).status).toBe(404);
      expect((await watchBare.GET(new NextRequest("https://horizonpulse.dev/api/seller-watch"))).status).toBe(404);
      expect(listedTiers()).toEqual([]);
      expect(await text(wellKnown.GET())).not.toMatch(/research\/report|seller-watch/);
      expect(await text(skill.GET())).not.toMatch(/research\/report|seller-watch/);
    });
  }

  it("brief only: brief reaches the handler; every other tier is 404 exactly like flag-off (even with ?tier=)", async () => {
    set("brief");
    const r = await call("brief");
    expect(r.status).not.toBe(404); // reaches the handler (402 path covered in premium-ladder with keys stubbed)
    for (const id of OTHERS) {
      const a = await call(id); expect(a.status).toBe(404);
      expect(a.headers.get("payment-required")).toBeNull();
      expect((await call(id, "OPTIONS")).status).toBe(404);
      expect((await call(id, "GET", "q=x&tier=brief")).status).toBe(404);
    }
    vi.stubEnv("HP_PREMIUM_ENABLED", "false");
    const off = await call("standard");
    vi.stubEnv("HP_PREMIUM_ENABLED", "true");
    const gated = await call("standard");
    expect(gated.status).toBe(off.status);
    expect(await gated.text()).toBe(await off.text());
    expect((await watchBare.GET(new NextRequest("https://horizonpulse.dev/api/seller-watch"))).status).toBe(404);
  });

  it("brief only: discovery, skill, openapi, llms and MCP list only the brief", async () => {
    set("brief");
    expect(listedTiers().map((x) => x.id)).toEqual(["brief"]);
    const listings = [await text(wellKnown.GET()), await text(skill.GET()), await text(llms.GET()), await text(openapi.GET()), await text(mcp.GET())];
    for (const s of listings) for (const id of OTHERS) expect(s).not.toMatch(new RegExp(`(research/report|seller-watch)/${id}\\b`));
    expect(listings[0]).toContain("/api/research/report/brief");
    expect(listings[1]).toContain("/api/research/report/brief");
  });
});
