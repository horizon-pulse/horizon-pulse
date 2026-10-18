/**
 * Every dark URL and the flag that turns it on. Dependency-free so next.config.ts can import it.
 *
 * While a flag is not exactly "true" at build time, next.config.ts rewrites its paths (beforeFiles,
 * every method, any query) to DARK_404_DESTINATION, a path that does not exist. The platform then
 * answers exactly as for any unknown path: same status, headers and 404 page on GET, HEAD, POST, PUT,
 * PATCH, DELETE and OPTIONS, with no Allow header and no x-matched-path naming the route (Odin 10:31
 * AM ET 10/18, after the 10:26 smoke found /web-checks/opt-out answering POST 405 / OPTIONS 204 + Allow).
 * Vercel applies env changes only on a new deployment (which rebuilds), so build-time is the same
 * moment the runtime flag changes. The route handlers keep their own per-request 404 on every method
 * as a second line (lib/dark-route-runtime.ts, app/web-checks/opt-out/route.ts).
 */
export const DARK_404_DESTINATION = "/_hp-dark-404";

export const DARK_PATHS = [
  { path: "/api/audit/security", flag: "HP_AUDIT_SECURITY_ENABLED" },
  { path: "/web-checks", flag: "HP_AUDIT_SECURITY_ENABLED" },
  { path: "/web-checks/opt-out", flag: "HP_AUDIT_SECURITY_ENABLED" },
  { path: "/api/package/check", flag: "HP_PACKAGE_CHECK_ENABLED" },
  { path: "/api/injection/scan", flag: "HP_INJECTION_SCAN_ENABLED" },
] as const;

/** All HTTP methods a dark route must answer exactly like an unknown path while dark. */
export const DARK_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export type Rewrite = { source: string; destination: string };

export function darkRewrites(env: Record<string, string | undefined> = process.env): Rewrite[] {
  return DARK_PATHS.filter((d) => env[d.flag] !== "true").map((d) => ({ source: d.path, destination: DARK_404_DESTINATION }));
}
