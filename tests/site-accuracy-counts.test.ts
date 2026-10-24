/**
 * Site accuracy scan (10/21): every public count/range on the human pages equals the single source catalog
 * (lib/live-catalog.ts catalogStats + lib/premium/listing.ts livePremiumListings), including Seller DD when its flag is
 * on, and matches the machine surfaces (/.well-known/x402 resources, openapi operations). Flag off -> pre-fix values.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const ON = { HP_PREMIUM_ENABLED: "true", HP_PREMIUM_TIERS: "brief", HP_SELLER_DD_ENABLED: "true" };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
async function on() {
  for (const [k, v] of Object.entries(ON)) vi.stubEnv(k, v);
  vi.resetModules();
}
const render = async (mod: string) => {
  const m = await import(/* @vite-ignore */ mod);
  const el = await m.default();
  return renderToStaticMarkup(el ?? createElement("div"));
};
const unescape = (h: string) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/<!-- -->/g, "");
const text = (h: string) => unescape(h.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ");

describe("site counts derive from the catalog (Seller DD live)", () => {
  it("catalogStats: 31 paid, 36 operations, 6 accept POST, 29 of 31 samples", async () => {
    await on();
    const { catalogStats, LIVE_PAID_ROUTES } = await import("@/lib/live-catalog");
    const s = catalogStats();
    expect(s.premium.map((x) => x.id)).toEqual(["brief", "seller-dd"]);
    expect(s.paidRoutes).toBe(LIVE_PAID_ROUTES.length + 2);
    expect(s.paidRoutes).toBe(31);
    expect(s.paidOperations).toBe(36);
    expect(s.postAccepting).toBe(6);
    expect(s.freeSamples).toBe(29);
    expect(s.noSample).toEqual(["/api/batch", "/api/seller-dd/single"]);
    expect(s.premiumPrices).toEqual(["$1", "$5"]);
  });

  it("machine surfaces agree: /.well-known/x402 URLs = paid routes; openapi paid operations = paidOperations", async () => {
    await on();
    const { catalogStats } = await import("@/lib/live-catalog");
    const s = catalogStats();
    const { GET } = await import("@/app/.well-known/x402/route");
    const doc = await GET().json();
    expect(doc.resources.length).toBe(s.paidRoutes);
    expect(doc.premium.tiers.map((t: { method: string; url: string }) => `${t.method} ${t.url.replace(/^https:\/\/[^/]+/, "")}`)).toEqual(["GET /api/research/report/brief", "POST /api/seller-dd/single"]);
    expect(doc.sellerDd).toBeTruthy(); // kept for compatibility
    const { openApiWithSellerDd } = await import("@/lib/seller-dd/discovery");
    const oa = openApiWithSellerDd(JSON.parse(readFileSync("public/openapi.json", "utf8")));
    const ops = Object.values<Record<string, Record<string, unknown>>>(oa.paths).flatMap((item) => Object.values(item)).filter((op) => op && (op["x-payment-info"] || op["x-premium-payment-info"]));
    expect(ops.length).toBe(s.paidOperations);
  });

  it("homepage: hero, stats, premium section with Seller DD (config wording verbatim), free row", async () => {
    await on();
    const { catalogStats } = await import("@/lib/live-catalog");
    const { DD_DESCRIPTION } = await import("@/lib/seller-dd/config");
    const s = catalogStats();
    const t = text(await render("@/app/page"));
    expect(t).toContain(`${s.paidRoutes} paid services for market data`);
    expect(t).toContain("Plus two premium checks in Base USDC: a $1 verified brief and a $5 seller due-diligence check.");
    expect(t).toContain("web and everyday 10 · premium 2");
    expect(t).toContain("29 of 31 paid routes have a free demo twin (none for /api/batch or /api/seller-dd/single)");
    expect(t).toContain("URLs in /.well-known/x402 · 6 accept POST");
    expect(t).toContain("USDC, exact amount in the 402 · premium $1 and $5");
    expect(t).toContain("Premium (USDC or EURC on Base only)");
    expect(t).toContain(DD_DESCRIPTION);
    expect(t).toContain("/api/money-market-rates");
    expect(t).not.toMatch(/\b30 paid|\b30 routes|Thirty routes|29 of 30|5 also accept/);
  });

  it("/status: 31 routes, 36 endpoints, all four rails, Seller DD row", async () => {
    await on();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const t = text(await render("@/app/status/page"));
    expect(t).toContain("36 endpoints in /.well-known/x402");
    expect(t).toContain("Same price on all four rails (premium checks: Base USDC only).");
    expect(t).toContain("/api/seller-dd/single");
    expect(t).not.toContain("Same price on Base and Solana");
    expect(t).not.toMatch(/\b35 endpoints|\b30 routes/);
  });

  it("/agents, /docs and skill.md name Seller DD and use 31 / 36", async () => {
    await on();
    const a = text(await render("@/app/agents/page"));
    expect(a).toContain("31 paid routes.");
    expect(a).toContain("the $1 verified brief and the $5 seller due-diligence check: Base USDC only");
    const d = text(await render("@/app/docs/page"));
    expect(d).toContain("31 paid routes and 36 operations");
    expect(d).toContain("POST /api/seller-dd/single");
    const { buildSkillMarkdown } = await import("@/lib/agent-skill");
    const { premiumSkillSection } = await import("@/lib/premium/discovery");
    const md = buildSkillMarkdown() + premiumSkillSection();
    expect(md).toContain("31 paid routes. 29 of them cost $0.002 to $0.04");
    expect(md).toContain("the $5 seller due-diligence check (`POST /api/seller-dd/single`, USDC or EURC on Base only");
    expect(md).toContain("- `POST /api/seller-dd/single`");
    expect(md).toContain("/api/money-market-rates`: FREE route");
    for (const x of [a, d, md]) expect(x).not.toMatch(/\bxai\b|grok/i);
  });

  it("Seller DD 402 carries extensions.bazaar (POST, json) and the same accepts", async () => {
    await on();
    const { ddPaymentRequired } = await import("@/lib/seller-dd/handler");
    const b = ddPaymentRequired() as unknown as { extensions: { bazaar: { info: { input: { method: string; bodyType: string } }; schema: { properties: { input: { properties: { method: { enum: string[] } } } } } } }; accepts: { payTo: string; amount: string; network: string }[] };
    expect(b.extensions.bazaar.info.input).toMatchObject({ method: "POST", bodyType: "json" });
    expect(b.extensions.bazaar.schema.properties.input.properties.method.enum).toEqual(["POST"]);
    expect(b.accepts).toEqual([expect.objectContaining({ payTo: "0x5b32c973596078a967562ca652761404f19be0e9", amount: "5000000", network: "eip155:8453" })]);
    expect(JSON.stringify(b.extensions)).not.toMatch(/0x[0-9a-f]{64}/i); // no hashes in the example
  });
});

describe("flag off: pre-fix counts", () => {
  it("no premium -> 29 routes, 34 operations, 5 POST, 28 samples (no batch twin)", async () => {
    const { catalogStats } = await import("@/lib/live-catalog");
    const s = catalogStats();
    expect([s.paidRoutes, s.paidOperations, s.postAccepting, s.freeSamples]).toEqual([29, 34, 5, 28]);
    expect(s.premium).toEqual([]);
  });
});
