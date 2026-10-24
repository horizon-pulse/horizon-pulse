/**
 * Homepage "Payment options": every rail a paid route accepts, by asset and chain.
 * Must match the unpaid 402 `accepts` on live routes. EURC is listed only when eurcActive()
 * (flag + Base mainnet + fresh rate), the same gate the 402 uses.
 */
import { eurcActive } from "@/lib/eurc-config";

export type Rail = { asset: string; chains: string[] };

export function paymentRails(): { rails: Rail[]; eurc: boolean; premiumAssets: string[] } {
  const eurc = eurcActive();
  const rails: Rail[] = [{ asset: "USDC", chains: ["Base", "Solana", "Polygon"] }];
  if (eurc) rails.push({ asset: "EURC", chains: ["Base"] });
  rails.push({ asset: "RLUSD", chains: ["XRP Ledger"] });
  return { rails, eurc, premiumAssets: eurc ? ["USDC", "EURC"] : ["USDC"] };
}
