/**
 * Premium discovery entries (spec §3 item 3, §3a "How prices appear"). Additive ONLY when HP_PREMIUM_ENABLED=true;
 * flag off -> every discovery surface is byte-identical to main (tests/premium-golden.test.ts).
 * One canonical path URL per tier, its single price, Base-only accepts. No ?tier= alias anywhere. Not on MCP (N1).
 * Static public/openapi.json and public/llms.txt are NOT changed by this build (they cannot follow a runtime flag);
 * their premium entries ship in the launch commit that flips the flag (listed as unresolved for Odin).
 */
import { BASE_CAIP2, DEFAULT_PAY_TO, PUBLIC_BASE_URL, USDC_BASE } from "@/lib/config";
import { BUYER_TERMS_URL, DISCLAIMER, PREMIUM_CONTACT, REFUND_LINE } from "./copy";
import { listedTiers, tierPath } from "./tiers";
import { DD_AMOUNT, DD_DESCRIPTION, DD_PATH, DD_PRICE_USD, sellerDdEnabled } from "@/lib/seller-dd/config";

export function premiumResources(env: Record<string, string | undefined> = process.env): string[] {
  return listedTiers(env).map((x) => `${PUBLIC_BASE_URL}${tierPath(x)}`);
}

export function premiumWellKnownBlock(env: Record<string, string | undefined> = process.env) {
  const tiers = listedTiers(env);
  if (tiers.length === 0) return null;
  return {
    note: "Premium tiers are an exception to 'same price on every network': Base only (exact, eip155:8453), in USDC, or USDC or EURC for the $1 verified brief and the seller due-diligence check; eURC prices are converted from our USD list prices. One URL and one price per tier, not available over MCP.",
    networks: [BASE_CAIP2],
    asset: USDC_BASE,
    payTo: DEFAULT_PAY_TO,
    terms: BUYER_TERMS_URL,
    contact: PREMIUM_CONTACT,
    tiers: [
      ...tiers.map((x) => ({ url: `${PUBLIC_BASE_URL}${tierPath(x)}`, method: "GET", price: x.priceUsd, amount: x.amount, mode: x.mode })),
      // Site accuracy fix 10/21 (scan finding 5): Seller DD as a second premium entry, same gate as its route. The
      // top-level `sellerDd` block stays for compatibility.
      ...(sellerDdEnabled(env) ? [{ url: `${PUBLIC_BASE_URL}${DD_PATH}`, method: "POST", price: `$${DD_PRICE_USD}`, amount: DD_AMOUNT, mode: "sync" }] : []),
    ],
  };
}

export function premiumSkillSection(env: Record<string, string | undefined> = process.env): string {
  const tiers = listedTiers(env);
  if (tiers.length === 0) return "";
  const lines = tiers.map((x) => `- \`GET ${tierPath(x)}?${x.route === "research" ? "q=…" : "target=<https x402 URL>"}\` — ${x.priceUsd} (${x.mode})`);
  if (sellerDdEnabled(env)) lines.push(`- \`POST ${DD_PATH}\` with JSON \`{"resource": "<https x402 URL>", "expected_payTo": "<optional EVM address>"}\` — $${DD_PRICE_USD} (sync). ${DD_DESCRIPTION}`);
  return [
    "",
    "## Premium tiers (Base only)",
    "",
    "Each tier has its own URL and one price. Pay only on Base (eip155:8453, USDC, or USDC or EURC for the $1 verified brief and the seller due-diligence check; EURC prices are converted from our USD list prices. payTo " + DEFAULT_PAY_TO + "); other networks are refused with `rail_unavailable` before payment. The tier is part of the path only; a bare path or a tier query parameter returns 400. Not available over MCP.",
    "",
    ...lines,
    "",
    `Terms: ${BUYER_TERMS_URL}. ${REFUND_LINE}`,
    "",
    DISCLAIMER,
    "",
  ].join("\n");
}
