/**
 * SPIKE check (Base Sepolia, testnet): builds the EURC requirement for /api/gas, signs an
 * EIP-3009 authorization with the throwaway Sepolia buyer, and asks the x402.org facilitator to
 * VERIFY only (no settle, no money moves). Paid settle needs testnet EURC in the buyer wallet.
 * Buyer note: x402Client blocks non-default assets by default; EURC must be opted in via
 * spendControls.allowedAssets (with an atomic cap).
 * Usage: EURC_SPIKE_ENABLED=1 EURC_SPIKE_PAY_TO=0x… BUYER_KEYS=/path/keys.json npx tsx scripts/eurc-spike-check.mts [--settle]
 */
import fs from "node:fs";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { gasRouteConfig } from "../lib/x402-server.ts";
import { BASE_SEPOLIA, EURC_BASE_SEPOLIA } from "../lib/eurc-spike.ts";

const accepts = (gasRouteConfig()["/api/gas"] as { accepts: object[] }).accepts;
console.log("gas accepts order", JSON.stringify(accepts.map((a: any) => [a.scheme, a.network, typeof a.price === "string" ? `USDC ${a.price}` : `EURC ${a.price.amount} atomic`])));
const fac = new HTTPFacilitatorClient({ url: process.env.EURC_SPIKE_FACILITATOR_URL ?? "https://x402.org/facilitator" });
const rs = new x402ResourceServer(fac).register(BASE_SEPOLIA, new ExactEvmScheme());
await rs.initialize();
const [req] = await rs.buildPaymentRequirements(accepts[1] as never);
console.log("EURC requirement", JSON.stringify(req));
const buyer = privateKeyToAccount(JSON.parse(fs.readFileSync(process.env.BUYER_KEYS!, "utf8")).payer);
const c = x402Client.fromConfig({
  schemes: [{ network: BASE_SEPOLIA, client: new ExactEvmClient(buyer as never) }],
  spendControls: { allowedAssets: [{ network: BASE_SEPOLIA, asset: EURC_BASE_SEPOLIA, maxAmountPerPayment: "20000" }] },
} as never);
const payload = await c.createPaymentPayload({ x402Version: 2, resource: { url: "http://127.0.0.1/api/gas" }, accepts: [req] } as never);
const v = await fac.verify(payload as never, req as never);
console.log("verify", JSON.stringify(v));
if (process.argv.includes("--settle") && v.isValid) console.log("settle", JSON.stringify(await fac.settle(payload as never, req as never)));
process.exit(0);
