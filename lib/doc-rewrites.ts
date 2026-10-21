/**
 * Build-time beforeFiles rewrites for the static docs (no "@/" imports: next.config loads this).
 * /llms.txt and /openapi.json are served by app/free-tier/* when EITHER the free tier is optin (lib/free-tier-mode.ts)
 * OR seller due-diligence is on (HP_PREMIUM_ENABLED=true AND HP_SELLER_DD_ENABLED=true, same exact-string gate as
 * lib/seller-dd/config.ts). Both off -> no rewrites: the public/ files, byte-identical.
 * (Vercel env changes take effect on the next deploy, like every other flag here.)
 */
import { freeTierMode } from "./free-tier-mode";

type Env = Record<string, string | undefined>;

export function sellerDdDocsOn(env: Env = process.env): boolean {
  return env.HP_PREMIUM_ENABLED === "true" && env.HP_SELLER_DD_ENABLED === "true";
}

export function docRewrites(env: Env = process.env) {
  if (freeTierMode(env) !== "optin" && !sellerDdDocsOn(env)) return [];
  return [
    { source: "/llms.txt", destination: "/free-tier/llms.txt" },
    { source: "/openapi.json", destination: "/free-tier/openapi.json" },
  ];
}
