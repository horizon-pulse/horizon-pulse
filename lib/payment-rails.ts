/**
 * Homepage "Payment options": every rail a paid route accepts, by asset and chain.
 * Must match the unpaid 402 `accepts` on live routes. EURC is listed only when eurcActive()
 * (flag + Base mainnet + fresh rate), the same gate the 402 uses.
 */
import { eurcActive } from "@/lib/eurc-config";
import { getSolanaRailConfig } from "@/lib/solana-config";
import { getPolygonRailConfig, POLYGON_MAINNET_CAIP2 } from "@/lib/polygon-config";
import { getXrplRailConfig, XRPL_MAINNET_CAIP2 } from "@/lib/xrpl-config";

export type Rail = { asset: string; chains: string[] };

export type PaymentRails = {
  rails: Rail[];
  eurc: boolean;
  solana: boolean;
  polygon: boolean;
  xrpl: boolean;
  premiumAssets: string[];
};

/**
 * Solana / Polygon / XRPL are shown only when get*RailConfig().enabled (and on mainnet), the same checks
 * lib/x402-server.ts uses to add those options to the unpaid 402. Read-only: no payment path changes.
 */
export function paymentRails(env: Record<string, string | undefined> = process.env): PaymentRails {
  const eurc = eurcActive();
  // The homepage cards print mainnet addresses, so a rail counts only when enabled on mainnet.
  const sol = getSolanaRailConfig(env);
  const poly = getPolygonRailConfig(env);
  const xr = getXrplRailConfig(env);
  const solana = sol.enabled;
  const polygon = poly.enabled && poly.config.network === POLYGON_MAINNET_CAIP2;
  const xrpl = xr.enabled && xr.config.network === XRPL_MAINNET_CAIP2;
  const usdcChains = ["Base"];
  if (solana) usdcChains.push("Solana");
  if (polygon) usdcChains.push("Polygon");
  const rails: Rail[] = [{ asset: "USDC", chains: usdcChains }];
  if (eurc) rails.push({ asset: "EURC", chains: ["Base"] });
  if (xrpl) rails.push({ asset: "RLUSD", chains: ["XRP Ledger"] });
  return { rails, eurc, solana, polygon, xrpl, premiumAssets: eurc ? ["USDC", "EURC"] : ["USDC"] };
}
