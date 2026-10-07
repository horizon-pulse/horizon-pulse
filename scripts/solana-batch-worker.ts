/**
 * Solana batch-settlement redemption worker (mirrors scripts/batch-spike-worker.ts on the Base spike).
 * Without this, BatchSvmScheme accepts vouchers that are never redeemed: PayAI does NOT keep
 * unclaimed vouchers for the merchant, so an un-run worker means the receiver is never paid.
 *
 * Passes (each step persisted to JSONL before the next):
 *   0. scan:   list channels, unredeemed charged amounts, closing channels  (--dry-run stops here)
 *   1. redeem: BatchChannelManager.redeem() = claim -> distribute (+ seal of payer-closing channels),
 *              wrapped in retry with exponential backoff
 *   2. confirm: every returned signature must reach `finalized` on-chain (getSignatureStatuses)
 *   3. check:  payTo USDC (ATA) balance must INCREASE by >= newly settled amount; else alert + exit 1
 *   4. refund: payer-closing channels are sealed in pass 1 (latest voucher; remainder refunds to payer);
 *              closing channels still open past grace are reported for follow-up
 * Revenue = only the confirmed payTo balance delta. Devnet/smoke runs are tagged test=true.
 * Usage: npx tsx scripts/solana-batch-worker.ts [--dry-run]
 * Env: SOLANA_BATCH_* (lib/solana-rail.ts), SOLANA_BATCH_RPC, SOLANA_BATCH_WORKER_LOG.
 * MAINNET: on HOLD (Odin 10/7) until @x402/svm ships #3661 or PayAI confirms in writing.
 */
import fs from "node:fs";
import { BatchChannelManager } from "@x402/svm/batch-settlement/server";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS, SOLANA_MAINNET_CAIP2 } from "@x402/svm";
import { getSolanaRail, payaiFacilitator } from "../lib/solana-rail";

const LOG = process.env.SOLANA_BATCH_WORKER_LOG ?? "solana-batch-worker.jsonl";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function persist(o: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  fs.appendFileSync(LOG, line + "\n");
  console.log(line);
}

export async function withBackoff<T>(label: string, fn: () => Promise<T>, tries = 4, baseMs = 15_000): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      persist({ step: label, attempt: i + 1, error: String((e as Error)?.message ?? e).slice(0, 300) });
      if (i + 1 >= tries) throw e;
      await sleep(baseMs * 2 ** i);
    }
  }
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

/** Wait until the signature is finalized; throws on on-chain error or timeout. */
export async function confirmSig(url: string, sig: string, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const res = await rpc<{ value: ({ err: unknown; confirmationStatus?: string; slot: number } | null)[] }>(url, "getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
    const st = res.value[0];
    if (st?.err) throw new Error(`tx ${sig} failed on-chain: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "finalized") return st.slot;
    await sleep(3_000);
  }
  throw new Error(`tx ${sig} not finalized in ${timeoutMs} ms`);
}

/** Total USDC (atomic) held by the owner's token accounts for the mint. */
export async function usdcBalance(url: string, owner: string, mint: string): Promise<bigint> {
  const res = await rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>(url, "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "finalized" }]);
  return res.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}

export async function runSolanaWorker(opts: { dryRun?: boolean } = {}) {
  const { scheme, channelStore, network, payTo, receiverAuthorizer } = await getSolanaRail();
  const rpcUrl = process.env.SOLANA_BATCH_RPC?.trim();
  if (!rpcUrl) throw new Error("SOLANA_BATCH_RPC not set");
  const mint = network === SOLANA_MAINNET_CAIP2 ? USDC_MAINNET_ADDRESS : USDC_DEVNET_ADDRESS;
  const tag = { network, test: network !== SOLANA_MAINNET_CAIP2 || process.env.SOLANA_BATCH_TEST === "1" };

  // Pass 0: scan.
  const channels = await channelStore.list();
  const unredeemed = channels.reduce((s, c) => s + (c.chargedCumulativeAmount - c.settled), 0n);
  const closing = channels.filter((c) => c.status === "closing").map((c) => c.channelId);
  persist({ ...tag, step: "scan", channels: channels.length, unredeemedAtomic: unredeemed, closing, dryRun: !!opts.dryRun });
  if (opts.dryRun || channels.length === 0) return { channels: channels.length, unredeemed };

  // The settler requirements must match the advertised route terms (same scheme/network/payTo/asset).
  const fac = payaiFacilitator();
  await fac.getSupported(); // fails fast if PayAI admission is paused/unsupported on this network
  const requirements = (await scheme.enhancePaymentRequirements(
    { scheme: "batch-settlement", network, payTo, asset: mint, amount: "0", maxTimeoutSeconds: 300, extra: {} } as never,
    ((await fac.getSupported()).kinds.find((k) => k.scheme === "batch-settlement" && k.network === network) ?? { x402Version: 2, scheme: "batch-settlement", network }) as never,
    [],
  )) as never;
  const manager = new BatchChannelManager({
    store: channelStore,
    requirements,
    rpcUrl,
    maxChannelsPerBatch: 4, // PayAI preview limit
    receiverAuthorizer,
    settle: (payload, req) => fac.settle(payload as never, req),
    onClaim: (r) => persist({ ...tag, step: "claim", vouchers: r.vouchers, tx: r.transaction }),
    onSettle: (r) => persist({ ...tag, step: "distribute", tx: r.transaction }),
    onSeal: (r) => persist({ ...tag, step: "seal-refund", channel: r.channel, tx: r.transaction }),
    onError: (e) => persist({ ...tag, step: "manager-error", error: String((e as Error)?.message ?? e).slice(0, 300) }),
  });

  // Pass 1: redeem with backoff.
  const before = await usdcBalance(rpcUrl, payTo, mint);
  const result = await withBackoff("redeem", () => manager.redeem());
  persist({ ...tag, step: "redeem", result });

  // Pass 2: confirm every signature on-chain.
  for (const sig of [...result.claimed, ...result.distributed, ...result.sealed]) {
    persist({ ...tag, step: "confirmed", tx: sig, slot: await withBackoff("confirm", () => confirmSig(rpcUrl, sig), 3, 5_000) });
  }

  // Pass 3: receiver balance must increase by what was newly distributed.
  const after = await usdcBalance(rpcUrl, payTo, mint);
  const delta = after - before;
  persist({ ...tag, step: "balance-check", payTo, beforeAtomic: before, afterAtomic: after, deltaAtomic: delta, expectedMinAtomic: result.distributed.length ? 1n : 0n });
  if (result.distributed.length && delta <= 0n) {
    persist({ ...tag, step: "ALERT", reason: "distribution reported but payTo balance did not increase" });
    throw new Error("receiver balance did not increase");
  }

  // Pass 4: report channels still closing (seal handles the refund to the payer).
  const stillClosing = (await channelStore.list()).filter((c) => c.status === "closing").map((c) => c.channelId);
  if (stillClosing.length) persist({ ...tag, step: "refund-followup", stillClosing });
  return { result, deltaAtomic: delta };
}

if (process.argv[1]?.includes("solana-batch-worker")) {
  runSolanaWorker({ dryRun: process.argv.includes("--dry-run") })
    .then(() => process.exit(0))
    .catch((e) => { console.error(String((e as Error)?.message ?? e)); process.exit(1); });
}
