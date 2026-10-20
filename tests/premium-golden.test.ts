/**
 * Golden (T3.3 + Note 3): the 28 existing paid routes stay byte-identical with the premium build.
 *   - The 27 routes in tests/helpers/capture.ts: every 402 / OPTIONS byte (CDP + local mode) equals the UNCHANGED
 *     tests/fixtures/x402-flag-off.golden.json, with HP_PREMIUM_ENABLED off AND on (and the async flag on).
 *   - Discovery (/.well-known/x402, skill.md, openapi.json, llms.txt, x402list.txt) equals the golden with the flag
 *     off; with the flag on it only APPENDS (golden resources are a prefix; every golden key unchanged).
 *   - /api/batch (route 28, not in the capture helper): GET/POST/OPTIONS bytes identical with premium off vs on.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV, captureDiscovery, captureRoutes, type Captured } from "./helpers/capture";

const GOLDEN = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));

async function capture(env: Record<string, string>) {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv("CDP_API_KEY_ID", CDP_ENV.CDP_API_KEY_ID);
  vi.stubEnv("CDP_API_KEY_SECRET", CDP_ENV.CDP_API_KEY_SECRET);
  const cdp = await captureRoutes();
  vi.stubEnv("CDP_API_KEY_ID", "");
  vi.stubEnv("CDP_API_KEY_SECRET", "");
  const local = await captureRoutes();
  return { cdp, local, discovery: await captureDiscovery() };
}

async function batchBytes(env: Record<string, string>) {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries({ HP_BATCH_ENABLED: "true", ...env })) vi.stubEnv(k, v);
  vi.resetModules();
  const mod = await import("@/app/api/batch/route");
  const items = encodeURIComponent(JSON.stringify([{ route: "gas" }]));
  const snap = async (r: Response) => ({ s: r.status, h: [...r.headers.entries()].sort(), b: await r.text() });
  return JSON.stringify([
    await snap(await mod.GET(new NextRequest(`https://horizonpulse.dev/api/batch?items=${items}`, { headers: { accept: "application/json" } }))),
    await snap(await mod.POST(new NextRequest("https://horizonpulse.dev/api/batch", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ items: [{ route: "gas" }] }) }))),
    await snap(await mod.OPTIONS()),
  ]);
}

beforeEach(() => {
  installFacilitatorMock();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("premium build: existing routes byte-identical (golden)", () => {
  it("premium flag off: everything equals the unchanged golden fixture", async () => {
    const all = await capture({});
    expect(JSON.stringify(all, null, 1) + "\n").toBe(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));
  });
  for (const env of [{ HP_PREMIUM_ENABLED: "true" } as Record<string, string>, { HP_PREMIUM_ENABLED: "true", HP_PREMIUM_ASYNC_ENABLED: "true", PARALLEL_API_KEY: "k" }]) {
    it(`premium on ${JSON.stringify(Object.keys(env))}: all 27 captured routes' 402/OPTIONS bytes unchanged; discovery additive only`, async () => {
      const all = await capture(env);
      expect(JSON.stringify(all.cdp)).toBe(JSON.stringify(GOLDEN.cdp));
      expect(JSON.stringify(all.local)).toBe(JSON.stringify(GOLDEN.local));
      for (const k of ["sha256 public/openapi.json", "sha256 public/llms.txt", "sha256 public/.well-known/x402list.txt"]) expect(all.discovery[k]).toBe(GOLDEN.discovery[k]);
      const wk = JSON.parse((all.discovery["GET /.well-known/x402"] as Captured).body);
      const gwk = JSON.parse(GOLDEN.discovery["GET /.well-known/x402"].body);
      expect(wk.resources.slice(0, gwk.resources.length)).toEqual(gwk.resources);
      for (const k of Object.keys(gwk)) if (k !== "resources") expect(wk[k]).toEqual(gwk[k]);
      const skill = (all.discovery["GET /skill.md"] as Captured).body;
      expect(skill.startsWith(GOLDEN.discovery["GET /skill.md"].body)).toBe(true);
    });
  }
  it("/api/batch (route 28): GET / POST / OPTIONS bytes identical with premium off vs on", async () => {
    const off = await batchBytes({});
    const on = await batchBytes({ HP_PREMIUM_ENABLED: "true", HP_PREMIUM_ASYNC_ENABLED: "true" });
    expect(on).toBe(off);
    expect(off).toContain("402");
  });
});
