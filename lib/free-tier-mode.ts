/**
 * HP_FREE_TIER mode parser + the build-time doc rewrites (no imports: next.config
 * loads this). "optin" turns the free daily cap on (lib/free-tier.ts); anything else
 * is "off", the code default.
 */
export type FreeTierMode = "off" | "optin";

export function freeTierMode(env: Record<string, string | undefined> = process.env): FreeTierMode {
  return (env.HP_FREE_TIER ?? "").trim().toLowerCase() === "optin" ? "optin" : "off";
}

/**
 * public/llms.txt and public/openapi.json are static files. With HP_FREE_TIER=optin
 * at build time, beforeFiles rewrites serve the free-tier-annotated copies
 * (app/free-tier/*) at the same URLs. Off -> no rewrites: the static files, byte-identical.
 * (Vercel env changes take effect on the next deploy, like every other flag here.)
 */
export function freeTierRewrites(env: Record<string, string | undefined> = process.env) {
  if (freeTierMode(env) !== "optin") return [];
  return [
    { source: "/llms.txt", destination: "/free-tier/llms.txt" },
    { source: "/openapi.json", destination: "/free-tier/openapi.json" },
  ];
}
