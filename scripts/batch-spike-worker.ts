/**
 * SPIKE worker (Base Sepolia only): claim -> confirm -> settle -> confirm -> balance check,
 * plus idle refunds with backoff. Fixes from the 2026-10-07 run:
 *  - claim and settle are SEPARATE passes; settle runs only after the claim tx is confirmed
 *    on-chain (claimAndSettle() raced and threw `nothing_to_settle`, losing the claim result);
 *  - every claim/settle/refund result is persisted (append-only JSONL) BEFORE the next step;
 *  - refunds retry with exponential backoff (first attempt failed in the facilitator's RPC send).
 * Revenue is only the receiver's confirmed USDC balance delta; test runs are tagged test=true.
 * Usage: npx tsx scripts/batch-spike-worker.ts [--dry-run] [--refund-idle=<secs>]
 */
import fs from "node:fs";
import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { BatchSettlementChannelManager } from "@x402/evm/batch-settlement/server";
import { createPublicClient, erc20Abi, http } from "viem";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA_CAIP2, getBatchReceiver, getBatchScheme } from "../lib/batch-spike";

export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const STATE = process.env.BATCH_SPIKE_WORKER_LOG ?? "batch-spike-worker.jsonl";
const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.BATCH_SPIKE_RPC ?? "https://sepolia.base.org") });

const persist = (o: Record<string, unknown>) =>
  fs.appendFileSync(STATE, JSON.stringify({ t: new Date().toISOString(), network: "base-sepolia", test: true, ...o }) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function confirm(hash: string, confirmations = 2) {
  const r = await pub.waitForTransactionReceipt({ hash: hash as `0x${string}`, confirmations, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
  return r.blockNumber;
}

export async function withBackoff<T>(label: string, fn: () => Promise<T>, tries = 4, baseMs = 15_000): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      persist({ step: label, attempt: i + 1, error: String((e as Error).message ?? e).slice(0, 300) });
      if (i + 1 >= tries) throw e;
      await sleep(baseMs * 2 ** i);
    }
  }
}

function facilitator() {
  const url = process.env.BATCH_SPIKE_FACILITATOR_URL; // testnet override (e.g. x402.org); default CDP
  return url ? new HTTPFacilitatorClient({ url }) : new HTTPFacilitatorClient(createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET));
}

export async function runWorker(opts: { dryRun?: boolean; refundIdleSecs?: number } = {}) {
  const receiver = getBatchReceiver();
  if (!receiver) throw new Error("batch spike disabled; set BATCH_SPIKE_* env (testnet only)");
  const manager = new BatchSettlementChannelManager({ scheme: getBatchScheme(), facilitator: facilitator(), receiver, token: USDC_BASE_SEPOLIA, network: BASE_SEPOLIA_CAIP2 });
  const balance = async () => pub.readContract({ address: USDC_BASE_SEPOLIA, abi: erc20Abi, functionName: "balanceOf", args: [receiver] });

  const claimable = await manager.getClaimableVouchers();
  persist({ step: "scan", claimable: claimable.length, dryRun: !!opts.dryRun });
  if (opts.dryRun) return { claimable: claimable.length };

  // Pass 1: claim, persist, confirm.
  const claims = claimable.length ? await withBackoff("claim", () => manager.claim({ maxClaimsPerBatch: 10 }), 4, 15_000) : [];
  for (const c of claims) persist({ step: "claim", vouchers: c.vouchers, tx: c.transaction });
  for (const c of claims) persist({ step: "claim-confirmed", tx: c.transaction, block: String(await confirm(c.transaction)) });

  // Pass 2: settle only after claims are confirmed; persist, confirm, check balance delta.
  let settle: { transaction: string } | undefined;
  if (claims.length) {
    const before = await balance();
    settle = await withBackoff("settle", () => manager.settle(), 3, 10_000);
    persist({ step: "settle", tx: settle.transaction });
    const block = await confirm(settle.transaction);
    const after = await balance();
    persist({ step: "settle-confirmed", tx: settle.transaction, block: String(block), receiverDeltaAtomic: String(after - before) });
  }

  // Pass 3: refund idle channels, with backoff.
  if (opts.refundIdleSecs !== undefined) {
    const refunds = await withBackoff("refund", () => manager.refundIdleChannels({ idleSecs: opts.refundIdleSecs! }));
    for (const r of refunds) {
      persist({ step: "refund", channel: r.channel, tx: r.transaction });
      persist({ step: "refund-confirmed", tx: r.transaction, block: String(await confirm(r.transaction)) });
    }
  }
  return { claims, settle };
}

if (process.argv[1]?.includes("batch-spike-worker")) {
  const refundArg = process.argv.find((a) => a.startsWith("--refund-idle="));
  runWorker({ dryRun: process.argv.includes("--dry-run"), refundIdleSecs: refundArg ? Number(refundArg.split("=")[1]) : undefined })
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
