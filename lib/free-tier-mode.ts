/**
 * HP_FREE_TIER mode parser + the build-time doc rewrites (no imports: next.config
 * loads this). "optin" turns the free daily cap on (lib/free-tier.ts); anything else
 * is "off", the code default.
 */
export type FreeTierMode = "off" | "optin";

type Env = Record<string, string | undefined>;

/**
 * Env var holding the server secret for the keyed IP hashes (HMAC-SHA256; Counsel ruling B
 * 10/18: unsalted sha256 of an IP is reversible, so keyed hashes only). NAME ONLY: the
 * secret is Michael's to create and set; this code never generates or defaults one.
 */
export const FREE_IP_HMAC_KEY_ENV = "HP_FREE_IP_HMAC_KEY";
/**
 * Any string of 43+ characters (e.g. password-manager output; base64 not required, Odin 10/18).
 * Shorter values are treated as unset (a guessable key would make the hashes reversible again).
 * The raw string is used exactly as set (no trimming); lib/free-tier.ts derives the master key
 * from it with HKDF-SHA256, then the per-day and marker keys from the master key.
 */
export const MIN_FREE_IP_HMAC_KEY_CHARS = 43;

/** The raw secret string, or null when unset/shorter than 43 chars. Null -> the free tier and marker writing are OFF. */
export function freeIpHmacKey(env: Env = process.env): string | null {
  const k = env[FREE_IP_HMAC_KEY_ENV] ?? "";
  return k.length >= MIN_FREE_IP_HMAC_KEY_CHARS ? k : null;
}

/**
 * "optin" only when HP_FREE_TIER=optin AND the HMAC secret is set. Secret missing -> "off":
 * every surface stays byte-identical to the code default (never an unkeyed-hash fallback).
 */
export function freeTierMode(env: Env = process.env): FreeTierMode {
  if ((env.HP_FREE_TIER ?? "").trim().toLowerCase() !== "optin") return "off";
  return freeIpHmacKey(env) ? "optin" : "off";
}

/** Write payer markers while the tier is optin, or when pre-seeding (HP_FREE_PAYER_MARK=on); never without the secret. */
export function payerMarkWriting(env: Env = process.env): boolean {
  if (!freeIpHmacKey(env)) return false;
  return freeTierMode(env) === "optin" || (env.HP_FREE_PAYER_MARK ?? "").trim().toLowerCase() === "on";
}

/** Payer-marker retention in days: HP_FREE_PAYER_MARK_TTL_DAYS, 1-30, default 14 (Counsel: 14 preferred, 30 max). */
export const DEFAULT_PAYER_MARK_TTL_DAYS = 14;
export function payerMarkTtlDays(env: Env = process.env): number {
  const s = (env.HP_FREE_PAYER_MARK_TTL_DAYS ?? "").trim();
  if (!/^\d{1,2}$/.test(s)) return DEFAULT_PAYER_MARK_TTL_DAYS;
  const n = Number(s);
  return n >= 1 && n <= 30 ? n : DEFAULT_PAYER_MARK_TTL_DAYS;
}

/**
 * public/llms.txt and public/openapi.json are static files. With HP_FREE_TIER=optin
 * at build time, beforeFiles rewrites serve the free-tier-annotated copies
 * (app/free-tier/*) at the same URLs. Off -> no rewrites: the static files, byte-identical.
 * (Vercel env changes take effect on the next deploy, like every other flag here.)
 */
export function freeTierRewrites(env: Env = process.env) {
  if (freeTierMode(env) !== "optin") return [];
  return [
    { source: "/llms.txt", destination: "/free-tier/llms.txt" },
    { source: "/openapi.json", destination: "/free-tier/openapi.json" },
  ];
}
