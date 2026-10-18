/**
 * Every dark URL, the flag that turns it on, and the file extension its route/page file carries.
 * Dependency-free so next.config.ts can import it.
 *
 * Mechanism (Odin C1/C2, 10:44 AM ET 10/18): the dark route and page files are named
 * route.<ext>.ts / page.<ext>.tsx, and next.config.ts adds "<ext>.ts" / "<ext>.tsx" to
 * pageExtensions ONLY when that flag is exactly "true" at build time. While a flag is off, its files
 * are not routes at all: the URL is a genuinely unknown path in the build, so it answers exactly like
 * one for every method, header set (RSC, prefetch, payment), case or percent-encoding. No rewrite,
 * so no x-nextjs-rewritten-path header and no special cache-control on encoded variants.
 * (Replaces the fde5293 beforeFiles rewrite to /_hp-dark-404, which leaked that header under RSC: 1.)
 * Vercel applies env changes only on a new deployment (which rebuilds). The route handlers keep their
 * own per-request 404 on every method as a second line (lib/dark-route-runtime.ts, opt-out route).
 */
export const DARK_PATHS = [
  { path: "/api/audit/security", flag: "HP_AUDIT_SECURITY_ENABLED", ext: "audit", file: "app/api/audit/security/route.audit.ts" },
  { path: "/web-checks", flag: "HP_AUDIT_SECURITY_ENABLED", ext: "audit", file: "app/web-checks/page.audit.tsx" },
  { path: "/web-checks/opt-out", flag: "HP_AUDIT_SECURITY_ENABLED", ext: "audit", file: "app/web-checks/opt-out/route.audit.ts" },
  { path: "/api/package/check", flag: "HP_PACKAGE_CHECK_ENABLED", ext: "pkg", file: "app/api/package/check/route.pkg.ts" },
  { path: "/api/injection/scan", flag: "HP_INJECTION_SCAN_ENABLED", ext: "inj", file: "app/api/injection/scan/route.inj.ts" },
] as const;

/** All HTTP methods a dark route must answer exactly like an unknown path while dark. */
export const DARK_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** Next's default pageExtensions; every non-dark route keeps exactly these. */
export const BASE_PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"] as const;

/** pageExtensions for this build: the defaults, plus "<ext>.ts"/"<ext>.tsx" for each flag that is exactly "true". */
export function darkPageExtensions(env: Record<string, string | undefined> = process.env): string[] {
  const on = [...new Set(DARK_PATHS.filter((d) => env[d.flag] === "true").map((d) => d.ext))];
  return [...BASE_PAGE_EXTENSIONS, ...on.flatMap((e) => [`${e}.tsx`, `${e}.ts`])];
}
