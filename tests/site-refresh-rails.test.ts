/** Homepage payment-options section: lists exactly the live rails; EURC only when eurcActive(); premium = Base only. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
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
    const { paymentRails } = await (async () => { vi.stubEnv("HP_EURC_ENABLED", "true"); vi.resetModules(); return import("@/lib/payment-rails"); })();
    expect(paymentRails().rails).toEqual([
      { asset: "USDC", chains: ["Base", "Solana", "Polygon"] },
      { asset: "EURC", chains: ["Base"] },
      { asset: "RLUSD", chains: ["XRP Ledger"] },
    ]);
    const t = await home({ HP_EURC_ENABLED: "true", HP_PREMIUM_ENABLED: "true", HP_PREMIUM_TIERS: "brief", HP_SELLER_DD_ENABLED: "true" });
    expect(t).toContain("Open to every agent. Pay per call via x402.");
    expect(t).toContain("The $1 verified brief and the $5 seller due-diligence check accept USDC or EURC on Base only.");
    vi.useRealTimers();
  });
  it("EURC off: no EURC rail and premium is USDC only", async () => {
    vi.stubEnv("HP_EURC_ENABLED", "false"); vi.resetModules();
    const { paymentRails } = await import("@/lib/payment-rails");
    expect(paymentRails().rails.map((r) => r.asset)).toEqual(["USDC", "RLUSD"]);
    expect(paymentRails().premiumAssets).toEqual(["USDC"]);
  });
});
