import type { NextConfig } from "next";
import { SITE_PAGES_SOURCE, SITE_SECURITY_HEADERS } from "./lib/security-headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: SITE_PAGES_SOURCE, headers: SITE_SECURITY_HEADERS.map((h) => ({ ...h })) }];
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
  },
};

export default nextConfig;
