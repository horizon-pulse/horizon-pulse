import type { NextConfig } from "next";
import { darkPageExtensions } from "./lib/dark-paths";
import { freeTierRewrites } from "./lib/free-tier-mode";
import { API_SECURITY_HEADERS, API_SOURCE, SITE_PAGES_SOURCE, SITE_SECURITY_HEADERS, WELL_KNOWN_SECURITY_HEADERS, WELL_KNOWN_SOURCE } from "./lib/security-headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Dark routes (lib/dark-paths.ts): their route/page files carry a flag extension (route.pkg.ts ...)
  // that is a page extension only when the flag is exactly "true" at build time. Flag off -> the file
  // is not a route, the URL is a plain unknown path (every method, header, case and encoding).
  pageExtensions: darkPageExtensions(),
  async headers() {
    return [
      { source: SITE_PAGES_SOURCE, headers: SITE_SECURITY_HEADERS.map((h) => ({ ...h })) },
      { source: API_SOURCE, headers: API_SECURITY_HEADERS.map((h) => ({ ...h })) },
      { source: WELL_KNOWN_SOURCE, headers: WELL_KNOWN_SECURITY_HEADERS.map((h) => ({ ...h })) },
    ];
  },
  // Free daily cap (lib/free-tier-mode.ts): HP_FREE_TIER=optin -> llms.txt / openapi.json
  // served with the opt-in section; off (default) -> no rewrites, static files unchanged.
  async rewrites() {
    return { beforeFiles: freeTierRewrites(), afterFiles: [], fallback: [] };
  },
  // Headless Chromium for /api/screenshot: keep out of the bundle, ship the
  // brotli'd binary with every function that can invoke the handler.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core", "@x402/extensions"],
  // @x402/extensions: @x402/next loads "@x402/extensions/bazaar" through a
  // webpackIgnore'd dynamic import (bazaar validation/enrichment). Bundled, the
  // package was never traced into the functions, so every cold start logged
  // "Failed to load bazaar extension: Cannot find package '@x402/extensions'"
  // (pre-existing: same on 6d2bdac). External → required from node_modules and
  // traced with its deps.
  outputFileTracingIncludes: {
    "/api/screenshot": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/demo/*": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/mcp": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/free-tier/llms.txt": ["./public/llms.txt"],
    "/free-tier/openapi.json": ["./public/openapi.json"],
  },
};

export default nextConfig;
