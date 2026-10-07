/**
 * SPIKE harness, BASE SEPOLIA ONLY. Local server on 127.0.0.1 + buyer + worker.
 * Keys come from a file outside the repo (BATCH_SPIKE_KEYS); private keys are never printed.
 * Usage: npx tsx scripts/batch-spike-run.ts <calls|dryrun|claim|refund|status>
 */
import fs from "node:fs";
import http from "node:http";
import { HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import { BatchSettlementChannelManager } from "@x402/evm/batch-settlement/server";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http as vhttp, erc20Abi } from "viem";
import { baseSepolia } from "viem/chains";

const keys = JSON.parse(fs.readFileSync(process.env.BATCH_SPIKE_KEYS!, "utf8"));
const buyerKey = JSON.parse(fs.readFileSync(process.env.BATCH_SPIKE_BUYER_KEYS!, "utf8")).payer;
process.env.BATCH_SPIKE_ENABLED = "1";
process.env.BATCH_SPIKE_RECEIVER = privateKeyToAccount(keys.receiver).address;
process.env.BATCH_SPIKE_AUTHORIZER_KEY = keys.authorizer;
process.env.BATCH_SPIKE_REDIS_URL ??= "redis://127.0.0.1:6379";
const { BASE_SEPOLIA_CAIP2, getBatchScheme, getBatchReceiver, withBatchAccept } = await import("../lib/batch-spike.ts");

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const FAC_URL = process.env.BATCH_SPIKE_FACILITATOR_URL ?? "https://x402.org/facilitator";
const PORT = 4410, PATH = "/api/gas", PRICE = "$0.01";
const receiver = getBatchReceiver()!;
const fac = new HTTPFacilitatorClient({ url: FAC_URL });
const pub = createPublicClient({ chain: baseSepolia, transport: vhttp("https://sepolia.base.org") });
const bal = async (a: `0x${string}`) => Number(await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] })) / 1e6;
const log = (o: object) => { const l = JSON.stringify({ t: new Date().toISOString(), ...o }); console.log(l); fs.appendFileSync(process.env.BATCH_SPIKE_LOG!, l + "\n"); };

async function startServer() {
  const rs = new x402ResourceServer(fac).register(BASE_SEPOLIA_CAIP2, getBatchScheme());
  // Run uses only the Sepolia batch entry (no mainnet exact in a testnet run); route ordering
  // with exact first is asserted separately against lib/x402-server.ts.
  const accepts = withBatchAccept(PATH, PRICE, [] as object[]);
  const hs = new x402HTTPResourceServer(rs, { [`GET ${PATH}`]: { accepts, description: "spike", mimeType: "application/json" } } as never);
  await hs.initialize();
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1:${PORT}`);
    const adapter = { getHeader: (n: string) => req.headers[n.toLowerCase()] as string | undefined, getMethod: () => req.method!, getPath: () => url.pathname, getUrl: () => url.href, getAcceptHeader: () => "application/json", getUserAgent: () => "", getQueryParams: () => Object.fromEntries(url.searchParams), getQueryParam: (n: string) => url.searchParams.get(n) ?? undefined };
    const ctx = { adapter, path: url.pathname, method: req.method!, paymentHeader: (req.headers["payment-signature"] || req.headers["x-payment"]) as string | undefined };
    try {
      const r = await hs.processHTTPRequest(ctx as never);
      if (r.type === "no-payment-required") { res.writeHead(404); return res.end(); }
      if (r.type === "payment-error") { res.writeHead(r.response.status, r.response.headers); return res.end(JSON.stringify(r.response.body ?? {})); }
      const body = Buffer.from(JSON.stringify({ gas: "spike-ok" }));
      const s = await hs.processSettlement(r.paymentPayload, r.paymentRequirements, r.declaredExtensions, { request: ctx, responseBody: body } as never);
      if (!s.success) { log({ settleFail: s.errorReason }); res.writeHead(s.response.status, s.response.headers); return res.end(JSON.stringify(s.response.body ?? {})); }
      res.writeHead(200, s.headers); res.end(body);
    } catch (e) { log({ serverError: String((e as Error)?.message || e) }); res.writeHead(500); res.end(); }
  });
  await new Promise<void>((ok) => srv.listen(PORT, "127.0.0.1", ok));
  return srv;
}

const mode = process.argv[2];
const buyer = privateKeyToAccount(buyerKey);
log({ mode, facilitator: FAC_URL, receiver, buyer: buyer.address, receiverUSDC: await bal(receiver), buyerUSDC: await bal(buyer.address) });
const scheme = getBatchScheme();
const manager = new BatchSettlementChannelManager({ scheme, facilitator: fac, receiver, token: USDC, network: BASE_SEPOLIA_CAIP2 });

if (mode === "calls") {
  const srv = await startServer();
  const { createBatchBuyer } = await import("../lib/batch-buyer.ts");
  const buyerClient = createBatchBuyer(buyer as never, pub as never, BASE_SEPOLIA_CAIP2, { depositPolicy: { depositMultiplier: 10 }, ...(process.env.BATCH_SPIKE_SALT ? { salt: process.env.BATCH_SPIKE_SALT as `0x${string}` } : {}), storage: new FileClientChannelStorage({ directory: process.env.BATCH_SPIKE_CLIENT_DIR! }) as never });
  const n = Number(process.argv[3] ?? 5);
  for (let i = 0; i < n; i++) {
    const r = await buyerClient.payGet(`http://127.0.0.1:${PORT}${PATH}`);
    log({ call: i + 1, status: r.response.status, attempt: r.attempt, tx: r.settle?.transaction ?? null, charged: (r.settle as any)?.extra?.chargedAmount, cumulative: (r.settle as any)?.extra?.channelState?.chargedCumulativeAmount, error: (r as any).error });
  }
  srv.close();
} else if (mode === "dryrun") {
  const v = await manager.getClaimableVouchers();
  log({ dryRun: true, claimable: v.length, vouchers: v });
} else if (mode === "worker") {
  process.env.BATCH_SPIKE_FACILITATOR_URL = FAC_URL;
  process.env.BATCH_SPIKE_WORKER_LOG ??= process.env.BATCH_SPIKE_LOG!.replace(/\.jsonl$/, "-worker.jsonl");
  const { runWorker } = await import("./batch-spike-worker.ts");
  log({ worker: await runWorker({ refundIdleSecs: process.argv[3] ? Number(process.argv[3]) : undefined }) });
} else if (mode === "claim") {
  log({ claim: await manager.claim({ maxClaimsPerBatch: 10 }) });
} else if (mode === "settle") {
  log({ settle: await manager.settle() });
} else if (mode === "refund") {
  log({ refund: await manager.refund(process.argv[3] ? [process.argv[3]] : undefined) });
}
log({ end: mode, receiverUSDC: await bal(receiver), buyerUSDC: await bal(buyer.address) });
process.exit(0);
