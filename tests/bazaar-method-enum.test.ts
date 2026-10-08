/**
 * Bazaar discovery: each route key's schema input.method enum is exactly the
 * one method that key charges (Class B fix, branch fix-bazaar-method-enum).
 *
 * Production never runs @x402/next's bazaar enrichment (its lazy
 * webpackIgnore'd import of @x402/extensions/bazaar does not load in the
 * Vercel bundle), so the 402 carries the declaration as built in
 * lib/x402-server.ts. Before this fix that was the library's verb family:
 * ["GET","HEAD","DELETE"] on GET keys and ["POST","PUT","PATCH"] on POST keys,
 * while vitest (where the enrichment does run) and the golden showed ["GET"].
 * These tests check the declaration itself and a CDP-mode 402 with the
 * enrichment disabled, i.e. what production serves.
 */
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV, PAID_ROUTES } from "./helpers/capture";

type Bazaar = {
  info: { input: { method: string } };
  schema: { properties: { input: { properties: { method: { type: string; enum: string[] } } } } };
};

const POST_ROUTES = new Set(["http", "extract"]);
const ROOT = path.resolve(__dirname, "..");

async function allRouteConfigs(): Promise<Record<string, { extensions?: { bazaar?: Bazaar } }>> {
  const S = (await import("@/lib/x402-server")) as Record<string, unknown>;
  const out: Record<string, { extensions?: { bazaar?: Bazaar } }> = {};
  for (const [k, f] of Object.entries(S)) {
    if (k.endsWith("RouteConfig") && typeof f === "function") Object.assign(out, (f as () => object)());
  }
  return out;
}

describe("bazaar method.enum = the charged method", () => {
  beforeEach(() => {
    installFacilitatorMock();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("every declared route key: enum is [info.input.method] and matches the key's verb", async () => {
    const configs = await allRouteConfigs();
    const keys = Object.keys(configs);
    expect(keys.length).toBeGreaterThanOrEqual(PAID_ROUTES.length);
    for (const key of keys) {
      const bazaar = configs[key].extensions?.bazaar;
      expect(bazaar, key).toBeDefined();
      const method = bazaar!.info.input.method;
      const expected = key.startsWith("POST ") ? "POST" : "GET";
      expect(method, key).toBe(expected);
      expect(bazaar!.schema.properties.input.properties.method, key).toEqual({ type: "string", enum: [expected] });
    }
  });

  it("CDP-mode 402 without runtime enrichment (as in production): GET -> [GET], POST -> [POST]", async () => {
    vi.stubEnv("CDP_API_KEY_ID", CDP_ENV.CDP_API_KEY_ID);
    vi.stubEnv("CDP_API_KEY_SECRET", CDP_ENV.CDP_API_KEY_SECRET);
    const { getResourceServer } = await import("@/lib/x402-server");
    // A "bazaar" extension with no enrichDeclaration: withX402 sees the key as
    // already registered and skips loading the real one, as happens on Vercel.
    getResourceServer().registerExtension({ key: "bazaar" });
    for (const route of PAID_ROUTES) {
      const mod = (await import(path.join(ROOT, "app", "api", route, "route.ts"))) as Record<
        string,
        (r: NextRequest) => Promise<Response>
      >;
      const methods = POST_ROUTES.has(route) ? ["GET", "POST"] : ["GET"];
      for (const m of methods) {
        const res = await mod[m](
          new NextRequest(`https://horizonpulse.dev/api/${route}`, { method: m, headers: { accept: "application/json" } }),
        );
        expect(res.status, `${m} ${route}`).toBe(402);
        const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!) as unknown as {
          extensions: { bazaar: Bazaar };
        };
        const bazaar = pr.extensions.bazaar;
        expect(bazaar.info.input.method, `${m} ${route}`).toBe(m);
        expect(bazaar.schema.properties.input.properties.method.enum, `${m} ${route}`).toEqual([m]);
      }
    }
  });
});
