/**
 * Build-time beforeFiles rewrites for the static docs (no runtime "@/" imports: next.config loads this; seller-dd/config
 * has only a type-only "@/" import, erased at compile).
 * /llms.txt and /openapi.json are served by app/free-tier/* when EITHER the free tier is optin (lib/free-tier-mode.ts)
 * OR seller due-diligence is on (sellerDdEnabled() imported from lib/seller-dd/config.ts: the route's own gate,
 * not a copy; Sentinel L1). Both off -> no rewrites: the public/ files, byte-identical.
 * (Vercel env changes take effect on the next deploy, like every other flag here.)
 */
import { freeTierMode } from "./free-tier-mode";
import { sellerDdEnabled } from "./seller-dd/config";

type Env = Record<string, string | undefined>;

/** Same function as the route gate (Sentinel L1: imported, not duplicated). */
export const sellerDdDocsOn = (env: Env = process.env): boolean => sellerDdEnabled(env);

export function docRewrites(env: Env = process.env) {
  if (freeTierMode(env) !== "optin" && !sellerDdDocsOn(env)) return [];
  return [
    { source: "/llms.txt", destination: "/free-tier/llms.txt" },
    { source: "/openapi.json", destination: "/free-tier/openapi.json" },
  ];
}
