/**
 * Security headers for SITE pages (Sentinel appsec 2026-10-17 §13; Michael via
 * Odin 10:24 PM ET 10/17). API routes, /mcp and /.well-known/* are excluded so
 * their CORS, x402 payment headers and bodies stay exactly as they are.
 * CSP ships as Report-Only first (Next inline scripts need 'unsafe-inline';
 * switch to enforcing after a clean week). Clickjacking is enforced by
 * X-Frame-Options DENY (frame-ancestors is ignored in Report-Only).
 */
export const SITE_CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Next `source` for every path except /api, /mcp and /.well-known (and their children). */
export const SITE_PAGES_SOURCE = "/((?!api(?:/|$)|mcp(?:/|$)|\\.well-known(?:/|$)).*)";

export const SITE_SECURITY_HEADERS = [
  { key: "Content-Security-Policy-Report-Only", value: SITE_CSP_REPORT_ONLY },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
] as const;

/**
 * API responses: X-Content-Type-Options nosniff ONLY (Odin 10:47 PM ET 10/17).
 * No Referrer-Policy, CSP or frame headers on the API; CORS, x402 payment
 * headers and bodies are untouched (headers() only adds a header).
 */
export const API_SOURCE = "/api/:path*";
export const API_SECURITY_HEADERS = [{ key: "X-Content-Type-Options", value: "nosniff" }] as const;
