import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Headless Chromium for /api/screenshot: keep out of the bundle, ship the
  // brotli'd binary with every function that can invoke the handler.
  //
  // @x402/extensions: @x402/next loads "@x402/extensions/bazaar" with a
  // webpackIgnore'd dynamic import(), so the bundler leaves it as a runtime
  // Node import. While the package was bundled (via our static import in
  // lib/x402-server.ts) output tracing never shipped node_modules/@x402/extensions,
  // and every cold function logged "Failed to load bazaar extension: Cannot find
  // package '@x402/extensions'". External = traced into each function, so that
  // runtime import resolves. 402 bytes are unchanged (tests/bazaar-enrichment-parity.test.ts).
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core", "@x402/extensions"],
  outputFileTracingIncludes: {
    "/api/screenshot": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/demo/*": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/mcp": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
};

export default nextConfig;
