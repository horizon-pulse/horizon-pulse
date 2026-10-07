/**
 * OUTLINE (spike, Base Sepolia only): claim + payout worker for batch-settlement.
 * Not wired to any cron. Run manually on testnet only, after Odin OK:
 *   npx tsx --tsconfig tsconfig.json scripts/batch-spike-worker.ts
 * Needs the same BATCH_SPIKE_* env as the server, plus CDP_API_KEY_ID/SECRET.
 *
 * Plan of record (implement before any run):
 *  1. claim(): redeem stored vouchers onchain (CDP facilitator; deposits/claims/refunds
 *     are each one onchain tx, first 1,000/month free then $0.001).
 *  2. settle(): move claimed funds to the receiver. A claim is NOT revenue; only the
 *     receiver's USDC balance delta counts (verify via RPC before bookkeeping).
 *  3. refundIdleChannels(): return unused deposits after idle window.
 *  4. Log every tx to streams/x402-services/batch-spike-ledger.jsonl, deduped by tx hash;
 *     tag network=base-sepolia, test=true. Never count toward revenue or buyer totals.
 *  5. Alert if a claim is older than withdrawDelay/2.
 */
import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { BatchSettlementChannelManager } from "@x402/evm/batch-settlement/server";
import { BASE_SEPOLIA_CAIP2, getBatchReceiver, getBatchScheme } from "../lib/batch-spike";

/** Circle testnet USDC on Base Sepolia. */
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

async function main() {
  const receiver = getBatchReceiver();
  if (!receiver) throw new Error("batch spike disabled; set BATCH_SPIKE_* env (testnet only)");
  const facilitator = new HTTPFacilitatorClient(
    createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET),
  );
  const manager = new BatchSettlementChannelManager({
    scheme: getBatchScheme(),
    facilitator,
    receiver,
    token: USDC_BASE_SEPOLIA,
    network: BASE_SEPOLIA_CAIP2,
  });
  const dryRun = process.argv.includes("--dry-run");
  const claimable = await manager.getClaimableVouchers();
  console.log(JSON.stringify({ claimable: claimable.length, dryRun }));
  if (dryRun) return;
  const out = await manager.claimAndSettle({ maxClaimsPerBatch: 10 });
  console.log(JSON.stringify(out));
  // TODO(spike): balance-delta check + ledger append (step 2 and 4) before trusting output.
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
