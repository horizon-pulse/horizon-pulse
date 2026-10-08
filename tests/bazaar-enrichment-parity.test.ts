/**
 * @x402/extensions load error (Vercel runtime log, 2026-10-08):
 *   "Failed to load bazaar extension: Error: Cannot find package '@x402/extensions'
 *    imported from /var/task/.next/server/chunks/_02b5yh9._.js"
 *
 * @x402/next loads "@x402/extensions/bazaar" with a webpackIgnore'd dynamic
 * import(). With the package bundled, output tracing never shipped it, so the
 * import failed on every cold function and the bazaar server extension was
 * never registered. next.config.ts now lists @x402/extensions in
 * serverExternalPackages so it is traced and the import resolves.
 *
 * Resolving it turns the library's runtime enrichment ON in production. These
 * tests pin that this changes no 402 byte: every unpaid surface (CDP mode) is
 * identical with the real bazaar extension loaded and with a stub (the
 * pre-fix production state), and route validation emits no warnings.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV, captureRoutes } from "./helpers/capture";

async function captureCdp(stubBazaar: boolean) {
  vi.resetModules();
  vi.stubEnv("CDP_API_KEY_ID", CDP_ENV.CDP_API_KEY_ID);
  vi.stubEnv("CDP_API_KEY_SECRET", CDP_ENV.CDP_API_KEY_SECRET);
  const { getResourceServer } = await import("@/lib/x402-server");
  // Stub = a "bazaar" key with no enrichDeclaration: withX402 skips loading
  // the real extension, which is what production did while the import failed.
  if (stubBazaar) getResourceServer().registerExtension({ key: "bazaar" });
  const routes = await captureRoutes();
  return { routes, server: getResourceServer() };
}

describe("bazaar enrichment parity (@x402/extensions load fix)", () => {
  beforeEach(() => {
    installFacilitatorMock();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("next.config.ts externalizes @x402/extensions", () => {
    const cfg = readFileSync(path.resolve(__dirname, "..", "next.config.ts"), "utf8");
    expect(cfg).toMatch(/serverExternalPackages:\s*\[[^\]]*"@x402\/extensions"[^\]]*\]/);
  });

  it("402s are byte-identical with the real bazaar extension loaded vs not; no validation warnings", async () => {
    const logged: string[] = [];
    const record = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    vi.spyOn(console, "warn").mockImplementation(record);
    vi.spyOn(console, "error").mockImplementation(record);

    const real = await captureCdp(false);
    const ext = (real.server as unknown as { registeredExtensions: Map<string, { enrichDeclaration?: unknown }> })
      .registeredExtensions.get("bazaar");
    expect(typeof ext?.enrichDeclaration).toBe("function"); // the library's extension really loaded
    expect(logged.filter((l) => /bazaar/i.test(l))).toEqual([]);

    const stub = await captureCdp(true);
    const keys = Object.keys(real.routes);
    expect(keys.length).toBeGreaterThanOrEqual(41);
    for (const k of keys) expect(real.routes[k], k).toEqual(stub.routes[k]);
  });
});
