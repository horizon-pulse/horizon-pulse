/**
 * Odin 2026-10-13 hygiene (b): x402/core matches a route key with no verb on
 * EVERY method (GBLIN), so every paid route config is keyed by verb.
 * Single-verb routes: exactly "GET <path>" + "HEAD <path>" (same config object,
 * so HEAD's 402 equals GET's). http/extract keep their GET/POST split + bare
 * key (HEAD coverage), unchanged by this commit.
 */
import { describe, expect, it } from "vitest";
import type { RoutesConfig } from "@x402/core/server";
import * as S from "@/lib/x402-server";

const SINGLE: Array<[string, () => RoutesConfig]> = [
  ["/api/pulse", S.pulseRouteConfig],
  ["/api/signals", S.signalsRouteConfig],
  ["/api/yield", S.yieldRouteConfig],
  ["/api/portfolio", S.portfolioRouteConfig],
  ["/api/gas", S.gasRouteConfig],
  ["/api/funding", S.fundingRouteConfig],
  ["/api/fetch", S.fetchRouteConfig],
  ["/api/x402-check", S.x402CheckRouteConfig],
  ["/api/bazaar-check", S.bazaarCheckRouteConfig],
  ["/api/market/search", S.marketSearchRouteConfig],
  ["/api/market/quote", S.marketQuoteRouteConfig],
  ["/api/screenshot", S.screenshotRouteConfig],
  ["/api/search", S.searchRouteConfig],
  ["/api/pdf", S.pdfRouteConfig],
];

describe("paid route configs are keyed by HTTP verb", () => {
  it("covers 14 single-verb routes", () => expect(SINGLE.length).toBe(14));
  for (const [path, build] of SINGLE) {
    it(`${path}: only GET and HEAD keys, same config`, () => {
      const routes = build() as Record<string, unknown>;
      expect(Object.keys(routes).sort()).toEqual([`GET ${path}`, `HEAD ${path}`]);
      expect(routes[`HEAD ${path}`]).toBe(routes[`GET ${path}`]);
    });
  }
  it("http/extract keep GET + POST keys", () => {
    for (const [p, b] of [["/api/http", S.httpRouteConfig], ["/api/extract", S.extractRouteConfig]] as const) {
      const keys = Object.keys(b());
      expect(keys).toContain(`GET ${p}`);
      expect(keys).toContain(`POST ${p}`);
    }
  });
});
