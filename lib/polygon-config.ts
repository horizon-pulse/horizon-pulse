/**
 * Polygon PoS USDC rail (x402 v2 `exact`, EIP-3009): feature flag + constants.
 * Pure and synchronous. Mirrors the XRPL staged rollout:
 *
 *   - OFF unless HP_POLYGON_ENABLED is exactly "true". OFF = every route serves
 *     byte-for-byte the 402 it served before this branch.
 *   - payTo is the SAME EOA as Base (lib/config.ts DEFAULT_PAY_TO, no code /
 *     nonce 0 on Polygon, read 2026-10-12). HP_POLYGON_PAYTO must equal it
 *     exactly (lower-case); the env can only confirm it, never change it.
 *   - Asset is pinned to NATIVE USDC (Circle) 0x3c499c…3359 on eip155:137.
 *     Bridged USDC.e (0x2791…4174) is refused in code and can never be served.
 *   - Mainnet (eip155:137) is LOCKED in code (POLYGON_MAINNET_ALLOWED = false).
 *     Flipping it is a code change + Odin Class A + Michael's final yes after he
 *     confirms his wallet app shows Polygon for 0x5b32.
 *   - Mainnet facilitator: CDP (same CDP_API_KEY_ID/SECRET as Base).
 *   - Testnet (eip155:80002, Amoy) needs HP_POLYGON_TESTNET=true too and uses
 *     Polygon's public Amoy facilitator. For the e2e proof only.
 *   - Base stays the first `accepts` entry; Polygon is appended LAST.
 */
import { DEFAULT_PAY_TO } from "./config";

export const POLYGON_MAINNET_CAIP2 = "eip155:137" as const;
export const POLYGON_AMOY_CAIP2 = "eip155:80002" as const;
export type PolygonNetwork = typeof POLYGON_MAINNET_CAIP2 | typeof POLYGON_AMOY_CAIP2;

/** Native USDC on Polygon PoS (Circle). name()="USD Coin", EIP-712 version()="2", 6 decimals (read 2026-10-12). */
export const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const;
/** Bridged USDC.e on Polygon. NEVER accepted. */
export const USDC_E_POLYGON_REFUSED = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
/** Circle testnet USDC on Amoy. name()="USDC", version()="2", 6 decimals (read 2026-10-12). */
export const USDC_AMOY = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" as const;

/** Code-level mainnet lock. While false, eip155:137 is OFF whatever the env says. */
export const POLYGON_MAINNET_ALLOWED: boolean = true;

export const POLYGON_AMOY_FACILITATOR_URL = "https://x402-amoy.polygon.technology" as const;

export type PolygonRailConfig = {
  network: PolygonNetwork;
  asset: string;
  /** EIP-712 domain of the token (goes in accepts[].extra). */
  eip712: { name: string; version: string };
  payTo: string;
  /** "cdp" = CDP facilitator (createFacilitatorConfig); otherwise an https URL. */
  facilitator: "cdp" | typeof POLYGON_AMOY_FACILITATOR_URL;
};

export type PolygonConfigResult =
  | { enabled: true; config: PolygonRailConfig }
  | { enabled: false; reason: string; misconfigured: boolean };

type Env = Record<string, string | undefined>;
const off = (reason: string, misconfigured: boolean): PolygonConfigResult => ({ enabled: false, reason, misconfigured });

export function polygonAssetFor(network: PolygonNetwork): { asset: string; eip712: { name: string; version: string } } {
  return network === POLYGON_MAINNET_CAIP2
    ? { asset: USDC_POLYGON, eip712: { name: "USD Coin", version: "2" } }
    : { asset: USDC_AMOY, eip712: { name: "USDC", version: "2" } };
}

export function getPolygonRailConfig(env: Env = process.env, mainnetAllowed: boolean = POLYGON_MAINNET_ALLOWED): PolygonConfigResult {
  try {
    if (env.HP_POLYGON_ENABLED !== "true") return off("HP_POLYGON_ENABLED is not exactly 'true'", false);

    const rawNet = env.HP_POLYGON_NETWORK;
    let network: PolygonNetwork;
    if (rawNet === undefined || rawNet === "" || rawNet === POLYGON_MAINNET_CAIP2) {
      if (!mainnetAllowed) return off("eip155:137 (mainnet) is locked (POLYGON_MAINNET_ALLOWED is false)", true);
      network = POLYGON_MAINNET_CAIP2;
    } else if (rawNet === POLYGON_AMOY_CAIP2) {
      if (env.HP_POLYGON_TESTNET !== "true") return off("eip155:80002 needs HP_POLYGON_TESTNET=true", true);
      network = POLYGON_AMOY_CAIP2;
    } else return off("HP_POLYGON_NETWORK must be exactly eip155:137 or eip155:80002", true);

    const payTo = env.HP_POLYGON_PAYTO;
    if (payTo === undefined || payTo === "") return off("HP_POLYGON_PAYTO is not set", true);
    if (payTo !== DEFAULT_PAY_TO) return off("HP_POLYGON_PAYTO does not match the pinned payTo exactly", true);
    if (!/^0x[a-f0-9]{40}$/.test(DEFAULT_PAY_TO)) return off("pinned payTo is malformed", true);

    const { asset, eip712 } = polygonAssetFor(network);
    if (asset.toLowerCase() === USDC_E_POLYGON_REFUSED.toLowerCase()) return off("USDC.e is refused", true);
    if (network === POLYGON_MAINNET_CAIP2 && asset !== USDC_POLYGON) return off("mainnet asset must be native USDC", true);

    if (network === POLYGON_MAINNET_CAIP2 && !(env.CDP_API_KEY_ID?.trim() && env.CDP_API_KEY_SECRET?.trim()))
      return off("eip155:137 needs CDP_API_KEY_ID/SECRET", true);

    return {
      enabled: true,
      config: {
        network,
        asset,
        eip712,
        payTo: DEFAULT_PAY_TO,
        facilitator: network === POLYGON_MAINNET_CAIP2 ? "cdp" : POLYGON_AMOY_FACILITATOR_URL,
      },
    };
  } catch {
    return off("config parse threw", true);
  }
}
