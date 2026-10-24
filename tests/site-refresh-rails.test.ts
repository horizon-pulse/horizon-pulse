/** Homepage payment-options section: lists exactly the live rails; EURC only when eurcActive(); premium = Base only. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock("@/lib/solana-config"); vi.doUnmock("@/lib/polygon-config"); vi.doUnmock("@/lib/xrpl-config"); vi.resetModules(); });
/** Same signal the 402 uses (get*RailConfig().enabled); mocked so tests don't need full rail env. */
function rails(on: { solana: boolean; polygon: boolean; xrpl: boolean }) {
  const r = (enabled: boolean, network: string) => () => (enabled ? { enabled: true, config: { network } } : { enabled: false, reason: "test", misconfigured: false });
  vi.doMock("@/lib/solana-config", async (o) => ({ ...(await o<object>()), getSolanaRailConfig: r(on.solana, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") }));
  vi.doMock("@/lib/polygon-config", async (o) => ({ ...(await o<object>()), getPolygonRailConfig: r(on.polygon, "eip155:137") }));
  vi.doMock("@/lib/xrpl-config", async (o) => ({ ...(await o<object>()), getXrplRailConfig: r(on.xrpl, "xrpl:0") }));
}
const ALL = { solana: true, polygon: true, xrpl: true };
const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
async function home(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  const m = await import("@/app/page");
  return text(renderToStaticMarkup(createElement(m.default)));
}

describe("homepage payment options", () => {
  it("EURC on: USDC (Base, Solana, Polygon), EURC (Base), RLUSD (XRP Ledger); premium USDC or EURC on Base", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-24T15:00:00Z"));
    const { paymentRails } = await (async () => { vi.stubEnv("HP_EURC_ENABLED", "true"); rails(ALL); vi.resetModules(); return import("@/lib/payment-rails"); })();
    expect(paymentRails().rails).toEqual([
      { asset: "USDC", chains: ["Base", "Solana", "Polygon"] },
      { asset: "EURC", chains: ["Base"] },
      { asset: "RLUSD", chains: ["XRP Ledger"] },
    ]);
    rails(ALL);
    const t = await home({ HP_EURC_ENABLED: "true", HP_PREMIUM_ENABLED: "true", HP_PREMIUM_TIERS: "brief", HP_SELLER_DD_ENABLED: "true" });
    expect(t).toContain("Open to every agent. Pay per call via x402.");
    expect(t).toContain("The $1 verified brief and the $5 seller due-diligence check accept USDC or EURC on Base only.");
    vi.useRealTimers();
  });
  it("EURC off: no EURC rail and premium is USDC only", async () => {
    vi.stubEnv("HP_EURC_ENABLED", "false"); rails(ALL); vi.resetModules();
    const { paymentRails } = await import("@/lib/payment-rails");
    expect(paymentRails().rails.map((r) => r.asset)).toEqual(["USDC", "RLUSD"]);
    expect(paymentRails().premiumAssets).toEqual(["USDC"]);
  });
  it("NOTE-S2: Solana / Polygon / RLUSD cards hidden when their rail is off", async () => {
    rails({ solana: false, polygon: false, xrpl: false });
    const { paymentRails } = await import("@/lib/payment-rails");
    expect(paymentRails().rails).toEqual([{ asset: "USDC", chains: ["Base"] }]);
    const t = await home({ HP_EURC_ENABLED: "false" });
    expect(t).not.toContain("Solana: pay to");
    expect(t).not.toContain("Polygon: pay to");
    expect(t).not.toContain("XRP Ledger: pay to");
    expect(t).toContain("Base: pay to");
  });
  it("NOTE-S2: all cards shown when all rails are on", async () => {
    rails(ALL);
    const t = await home({ HP_EURC_ENABLED: "false" });
    for (const k of ["Solana: pay to", "Polygon: pay to", "XRP Ledger: pay to"]) expect(t).toContain(k);
  });
  it("LOW-S1: homepage revalidates hourly", async () => {
    const m = await import("@/app/page");
    expect(m.revalidate).toBe(3600);
  });
});
