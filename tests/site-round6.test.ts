/** Claude site review round 6 (10/19) batch: homepage copy comes from the catalog/config, not hardcoded. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LIVE_PAID_ROUTES, SITE_GROUPS, catalogStats, routePath } from "@/lib/live-catalog";
import { DEFAULT_PAY_TO } from "@/lib/config";
import { SOLANA_PAYTO } from "@/lib/solana-config";
import { USDC_POLYGON } from "@/lib/polygon-config";
import { XRPL_PAYTO, RLUSD_MAINNET_ISSUER } from "@/lib/xrpl-config";

const ROOT = join(__dirname, "..");
const html = async () => renderToStaticMarkup(createElement((await import("@/app/page")).default));

describe("site round 6", () => {
  it("every live route sits in exactly one of the 4 site groups", () => {
    expect(SITE_GROUPS).toHaveLength(4);
    const all = SITE_GROUPS.flatMap((g) => [...g.paths]);
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(LIVE_PAID_ROUTES.map(routePath)));
  });

  it("stats tile and hero use catalog counts", async () => {
    const s = catalogStats();
    const h = await html();
    expect(h).toContain(`${s.routes} paid services for market data, onchain checks, the web and documents.`);
    expect(h).toContain(s.bySiteGroup.map((g) => `${g.short} ${g.routes.length}`).join(" · "));
    expect(h).toContain(`${s.demoTwins} of ${s.routes} paid routes have a free demo twin (none for /api/batch)`);
    expect(h).not.toContain("a free twin for every route");
    expect(h).toContain(`URLs in /.well-known/x402 · ${s.postRoutes} also accept POST`);
  });

  it("discovery count equals the /.well-known/x402 resource count", async () => {
    const { GET } = await import("@/app/.well-known/x402/route");
    const doc = await GET().json();
    expect(doc.resources.length).toBe(catalogStats().routes);
  });

  it("payment block lists all 4 rails with payTo from config (when all 4 rails are enabled)", async () => {
    // NOTE-S2: non-Base cards are gated on get*RailConfig().enabled; force all on for this check.
    const on = (network: string) => () => ({ enabled: true, config: { network } });
    vi.doMock("@/lib/solana-config", async (o) => ({ ...(await o<object>()), getSolanaRailConfig: on("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") }));
    vi.doMock("@/lib/polygon-config", async (o) => ({ ...(await o<object>()), getPolygonRailConfig: on("eip155:137") }));
    vi.doMock("@/lib/xrpl-config", async (o) => ({ ...(await o<object>()), getXrplRailConfig: on("xrpl:0") }));
    vi.resetModules();
    const h = await html();
    vi.doUnmock("@/lib/solana-config"); vi.doUnmock("@/lib/polygon-config"); vi.doUnmock("@/lib/xrpl-config"); vi.resetModules();
    for (const v of [DEFAULT_PAY_TO, SOLANA_PAYTO, XRPL_PAYTO, USDC_POLYGON, RLUSD_MAINNET_ISSUER, "Polygon: pay to", "XRP Ledger: pay to", "same price on all four"]) expect(h).toContain(v);
    expect(h).not.toContain("same price on both");
  });

  it("brand kit files and header glyph are in place", () => {
    for (const f of ["favicon.ico", "hp-favicon.svg", "apple-touch-icon.png", "site.webmanifest", "icon-192.png", "icon-512.png", "icon.png"]) expect(existsSync(join(ROOT, "public", f))).toBe(true);
    expect(readFileSync(join(ROOT, "components/SiteHeader.tsx"), "utf8")).toContain("<circle");
  });

  it("llms.txt heading renamed", () => {
    const t = readFileSync(join(ROOT, "public/llms.txt"), "utf8");
    expect(t).toContain("## Route behavior and billing");
    expect(t).not.toMatch(/^## Honesty$/m);
  });
});
