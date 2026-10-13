/**
 * Odin 2026-10-13: on every paid route, an unpaid HEAD returns a PAYMENT-REQUIRED
 * header that is byte-identical to GET's (accepts, resource, bazaar extension
 * method and all), with all four rails on and with the default env.
 * Offline only: nothing is signed or sent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { NextRequest } from "next/server";
import { PAID_ROUTES } from "./helpers/capture";
import { installRpc as installSolanaRpc } from "./helpers/solana-env";
import { installXrplFacilitators, stubXrplOn } from "./helpers/xrpl-env";
import { resetSolanaRailForTests } from "@/lib/solana-rail";
import { resetXrplRailForTests } from "@/lib/xrpl-rail";
import { resetPolygonRailForTests } from "@/lib/polygon-rail";

const PR = "payment-required";

async function compareAll() {
  expect(PAID_ROUTES.length).toBe(16);
  for (const route of PAID_ROUTES) {
    const mod = (await import(path.join(__dirname, "..", "app", "api", route, "route.ts"))) as {
      GET: (r: NextRequest) => Promise<Response>;
    };
    const u = `https://horizonpulse.dev/api/${route}`;
    const g = await mod.GET(new NextRequest(u, { headers: { accept: "application/json" } }));
    const h = await mod.GET(new NextRequest(u, { method: "HEAD", headers: { accept: "application/json" } }));
    expect(g.status, route).toBe(402);
    expect(h.status, route).toBe(402);
    const gh = g.headers.get(PR);
    const hh = h.headers.get(PR);
    expect(gh, route).toBeTruthy();
    expect(hh, route).toBe(gh);
  }
}

describe("HEAD PAYMENT-REQUIRED header is byte-equal to GET's on every paid route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetSolanaRailForTests();
    resetXrplRailForTests();
    resetPolygonRailForTests();
  });

  it("default env", async () => {
    await compareAll();
  });

  it("all four rails on (Base, Solana, Polygon, XRPL)", async () => {
    vi.stubEnv("HP_SOLANA_ENABLED", "true");
    vi.stubEnv("HP_SOLANA_PAYTO", "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz");
    vi.stubEnv("HP_POLYGON_ENABLED", "true");
    vi.stubEnv("HP_POLYGON_PAYTO", "0x5b32c973596078a967562ca652761404f19be0e9");
    installSolanaRpc("present");
    stubXrplOn({}, true, "ready", true);
    // Facilitators stubbed (CDP keys + /supported); unpaid requests never verify or settle.
    installXrplFacilitators({
      verify: () => ({ isValid: false, invalidReason: "unexpected_in_test" }),
      settle: () => ({ success: false, errorReason: "unexpected_in_test" }),
    });
    await compareAll();
  });
});
