/**
 * Solana MAINNET batch smoke test: PREP ONLY. NOT RUN. Real money.
 * Checklist: docs/solana-mainnet-smoke-checklist.md. Every gate below must pass or the script exits
 * before touching the network. Private keys are read from files outside the repo and never printed.
 *
 *   SOLANA_SMOKE_APPROVAL=<id>        Michael's per-item funding OK (checklist item id), recorded in the push-log
 *   SOLANA_SMOKE_CLASS_A=<ref>        Odin Class A sign-off reference
 *   SOLANA_BATCH_ALLOW_MAINNET=1      plus SOLANA_BATCH_NETWORK=mainnet
 *   SOLANA_BATCH_PAY_TO               Michael's Ledger Solana address, confirmed with his passphrase
 *   SOLANA_BATCH_OPERATOR_KEY / _AUTHORIZER_KEY / _REDIS_URL   (see lib/solana-rail.ts)
 *   SOLANA_SMOKE_BUYER_KEYFILE        buyer key file (JSON byte array), funded per the checklist
 *   SOLANA_SMOKE_RPC                  mainnet RPC URL
 * Run (only after every checklist box is ticked): npx tsx scripts/solana-mainnet-smoke.mts --execute
 */
import fs from "node:fs";
import http from "node:http";
import { x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { BatchSvmScheme as BatchSvmClient } from "@x402/svm/batch-settlement/client";
import { BatchChannelManager } from "@x402/svm/batch-settlement/server";
import { createKeyPairSignerFromBytes } from "@solana/kit";

/** Hard caps for the smoke (the plan's "<= $0.10"). PayAI minimum initial deposit is 10000 atomic (0.01 USDC). */
const MAX_DEPOSIT_ATOMIC = 100_000n; // 0.10 USDC
const PRICE = "$0.005"; // /api/pulse per-call price; no batch price is published
const CALLS = 3;
const PORT = 4420, PATH = "/api/pulse";

function gate() {
  const need = ["SOLANA_SMOKE_APPROVAL", "SOLANA_SMOKE_CLASS_A", "SOLANA_BATCH_PAY_TO", "SOLANA_BATCH_OPERATOR_KEY", "SOLANA_BATCH_AUTHORIZER_KEY", "SOLANA_BATCH_REDIS_URL", "SOLANA_SMOKE_BUYER_KEYFILE", "SOLANA_SMOKE_RPC"];
  const missing = need.filter((k) => !process.env[k]?.trim());
  if (process.env.SOLANA_BATCH_ALLOW_MAINNET !== "1" || process.env.SOLANA_BATCH_NETWORK !== "mainnet") missing.push("SOLANA_BATCH_ALLOW_MAINNET=1 + SOLANA_BATCH_NETWORK=mainnet");
  if (!process.argv.includes("--execute")) missing.push("--execute flag");
  if (missing.length) { console.error("GATED, not running. Missing:", missing.join(", ")); process.exit(2); }
}

async function main() {
  gate();
  const { getSolanaRail, payaiFacilitator, withSolanaAccept } = await import("../lib/solana-rail.ts");
  const { scheme, channelStore, network, payTo } = await getSolanaRail();
  const fac = payaiFacilitator();
  const log = (o: object) => { const l = JSON.stringify({ t: new Date().toISOString(), network, test: true, ...o }); console.log(l); fs.appendFileSync("solana-mainnet-smoke.jsonl", l + "\n"); };

  // Local server with ONLY the Solana batch option (the Base exact option is not exercised here).
  const rs = new x402ResourceServer(fac).register(network, scheme);
  const hs = new x402HTTPResourceServer(rs, { [`GET ${PATH}`]: { accepts: withSolanaAccept(PATH, PRICE, [] as object[]), description: "smoke", mimeType: "application/json" } } as never);
  await hs.initialize(); // fails fast if PayAI admission is paused or batch is unsupported
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1:${PORT}`);
    const adapter = { getHeader: (n: string) => req.headers[n.toLowerCase()] as string | undefined, getMethod: () => req.method!, getPath: () => url.pathname, getUrl: () => url.href, getAcceptHeader: () => "application/json", getUserAgent: () => "", getQueryParams: () => ({}), getQueryParam: () => undefined };
    const ctx = { adapter, path: url.pathname, method: req.method!, paymentHeader: (req.headers["payment-signature"] as string) || undefined };
    const r = await hs.processHTTPRequest(ctx as never);
    if (r.type === "payment-error") { res.writeHead(r.response.status, r.response.headers); return res.end(JSON.stringify(r.response.body ?? {})); }
    if (r.type !== "payment-verified") { res.writeHead(404); return res.end(); }
    const body = Buffer.from('{"pulse":"smoke"}');
    const s = await hs.processSettlement(r.paymentPayload, r.paymentRequirements, r.declaredExtensions, { request: ctx, responseBody: body } as never);
    res.writeHead(s.success ? 200 : s.response.status, s.success ? s.headers : s.response.headers); res.end(s.success ? body : "{}");
  });
  await new Promise<void>((ok) => srv.listen(PORT, "127.0.0.1", ok));

  // Buyer: trusts only our operator, capped deposit.
  const buyer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.SOLANA_SMOKE_BUYER_KEYFILE!, "utf8"))));
  const operator = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(process.env.SOLANA_BATCH_OPERATOR_KEY!)));
  const bc = new BatchSvmClient(buyer as never, { rpcUrl: process.env.SOLANA_SMOKE_RPC, depositAmount: MAX_DEPOSIT_ATOMIC, serverSignedChannelsPolicy: { allowedOperators: [operator.address], maxDeposit: "$0.10" } } as never);
  const c = new x402Client(); c.register(network, bc); c.registerPolicy(bc.paymentPolicy as never); const hc = new x402HTTPClient(c);
  log({ step: "start", payTo, buyer: buyer.address, maxDepositAtomic: String(MAX_DEPOSIT_ATOMIC), calls: CALLS });

  for (let i = 0; i < CALLS; i++) {
    const u = await fetch(`http://127.0.0.1:${PORT}${PATH}`);
    const pr = hc.getPaymentRequiredResponse((h) => u.headers.get(h), await u.json().catch(() => ({})));
    const pp = await hc.createPaymentPayload(pr);
    const p = await fetch(`http://127.0.0.1:${PORT}${PATH}`, { headers: hc.encodePaymentSignatureHeader(pp) });
    const settle = p.ok ? hc.getPaymentSettleResponse((h) => p.headers.get(h)) : undefined;
    if (settle) await c.handlePaymentResponse({ paymentPayload: pp, requirements: pp.accepted, settleResponse: settle });
    log({ step: "call", n: i + 1, status: p.status, tx: settle?.transaction ?? null });
    if (!p.ok) break; // one attempt per call; stop and report
  }
  srv.close();

  // Redeem (claim + distribute) via PayAI, then buyer refund of the unused balance.
  const accept = (await rs.buildPaymentRequirements({ scheme: "batch-settlement", network, payTo, price: PRICE } as never))[0];
  const mgr = new BatchChannelManager({ store: channelStore, requirements: accept, rpcUrl: process.env.SOLANA_SMOKE_RPC, maxChannelsPerBatch: 4, settle: (payload, req) => fac.settle(payload as never, req) });
  log({ step: "redeem", result: await mgr.redeem() });
  log({ step: "next", note: "verify payTo ATA USDC delta on-chain; then buyer refund via bc.refund(url) or wait out withdrawDelay; record all tx in push-log; counts as TEST, not revenue" });
  process.exit(0);
}
main().catch((e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
