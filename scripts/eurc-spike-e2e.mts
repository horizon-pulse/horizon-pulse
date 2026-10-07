/**
 * SPIKE e2e (Base Sepolia, testnet): local HTTP 402 server on /api/gas offering the EURC accept,
 * buyer x402HTTPClient opted in via spendControls.allowedAssets, plus a negative check that a client
 * WITHOUT the opt-in refuses EURC. Usage: EURC_SPIKE_ENABLED=1 EURC_SPIKE_PAY_TO=0x… BUYER_KEYS=… npx tsx scripts/eurc-spike-e2e.mts
 */
import fs from "node:fs";
import http from "node:http";
import { HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";
import { gasRouteConfig } from "../lib/x402-server.ts";
import { BASE_SEPOLIA, EURC_BASE_SEPOLIA } from "../lib/eurc-spike.ts";

const PORT = 4430, PATH = "/api/gas";
const eurcAccept = (gasRouteConfig()[PATH] as { accepts: object[] }).accepts[1];
const fac = new HTTPFacilitatorClient({ url: process.env.EURC_SPIKE_FACILITATOR_URL ?? "https://x402.org/facilitator" });
const rs = new x402ResourceServer(fac).register(BASE_SEPOLIA, new ExactEvmScheme());
const hs = new x402HTTPResourceServer(rs, { [`GET ${PATH}`]: { accepts: [eurcAccept], description: "eurc spike", mimeType: "application/json" } } as never);
await hs.initialize();
const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://127.0.0.1:${PORT}`);
  const adapter = { getHeader: (n: string) => req.headers[n.toLowerCase()] as string | undefined, getMethod: () => req.method!, getPath: () => url.pathname, getUrl: () => url.href, getAcceptHeader: () => "application/json", getUserAgent: () => "", getQueryParams: () => ({}), getQueryParam: () => undefined };
  const ctx = { adapter, path: url.pathname, method: req.method!, paymentHeader: req.headers["payment-signature"] as string | undefined };
  const r = await hs.processHTTPRequest(ctx as never);
  if (r.type === "payment-error") { res.writeHead(r.response.status, r.response.headers); return res.end(JSON.stringify(r.response.body ?? {})); }
  if (r.type !== "payment-verified") { res.writeHead(404); return res.end(); }
  const body = Buffer.from('{"gas":"eurc-spike-ok"}');
  const s = await hs.processSettlement(r.paymentPayload, r.paymentRequirements, r.declaredExtensions, { request: ctx, responseBody: body } as never);
  res.writeHead(s.success ? 200 : s.response.status, s.success ? s.headers : s.response.headers); res.end(s.success ? body : "{}");
});
await new Promise<void>((ok) => srv.listen(PORT, "127.0.0.1", ok));

const buyer = privateKeyToAccount(JSON.parse(fs.readFileSync(process.env.BUYER_KEYS!, "utf8")).payer);
const mk = (optIn: boolean) => new x402HTTPClient(x402Client.fromConfig({
  schemes: [{ network: BASE_SEPOLIA, client: new ExactEvmClient(buyer as never) }],
  ...(optIn ? { spendControls: { allowedAssets: [{ network: BASE_SEPOLIA, asset: EURC_BASE_SEPOLIA, maxAmountPerPayment: "20000" }] } } : {}),
} as never));
async function call(hc: x402HTTPClient) {
  const u = await fetch(`http://127.0.0.1:${PORT}${PATH}`);
  const pr = hc.getPaymentRequiredResponse((h) => u.headers.get(h), await u.json().catch(() => ({})));
  const pp = await hc.createPaymentPayload(pr);
  const p = await fetch(`http://127.0.0.1:${PORT}${PATH}`, { headers: hc.encodePaymentSignatureHeader(pp) });
  return { unpaid: u.status, paid: p.status, body: await p.text(), settle: p.ok ? hc.getPaymentSettleResponse((h) => p.headers.get(h)) : null };
}
try { await call(mk(false)); console.log("no-opt-in client: UNEXPECTEDLY paid"); } catch (e) { console.log("no-opt-in client refused:", String((e as Error).message).slice(0, 120)); }
console.log("opt-in client:", JSON.stringify(await call(mk(true))));
srv.close(); process.exit(0);
