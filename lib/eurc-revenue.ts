/**
 * EURC revenue log, kept SEPARATE from USDC (never summed together; different currency).
 * Records only successful EURC settlements. A record is test=true when the network is a testnet
 * or the payer is in EURC_TEST_WALLETS (comma list; e.g. Michael's 0x9936… test wallet).
 * Counting (scripts/eurc-revenue-count.mts) includes only test=false records.
 * Sink: one structured stdout line `[eurc-revenue] {…}` (Vercel logs) and, if EURC_REVENUE_LOG
 * is set, an append-only JSONL file (local/Fly). Serverless FS is not durable.
 */
import fs from "node:fs";
import type { SettleResultContext } from "@x402/core/server";
import { BASE_MAINNET, isEurc } from "./eurc-spike";

export type EurcRevenueRecord = {
  t: string; currency: "EUR"; asset: string; network: string; amountAtomic: string;
  payer: string | null; payTo: string; tx: string; resource: string | null; test: boolean;
};

const testWallets = () => new Set((process.env.EURC_TEST_WALLETS ?? "").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean));

export function eurcRecordFrom(ctx: SettleResultContext): EurcRevenueRecord | null {
  const req = ctx.requirements;
  if (!ctx.result.success || !isEurc(req.asset)) return null;
  const payer = ctx.result.payer?.toLowerCase() ?? null;
  return {
    t: new Date().toISOString(), currency: "EUR", asset: req.asset, network: req.network,
    amountAtomic: String(req.amount), payer, payTo: req.payTo.toLowerCase(), tx: ctx.result.transaction,
    resource: (ctx.paymentPayload as { resource?: { url?: string } }).resource?.url ?? null,
    test: req.network !== BASE_MAINNET || (payer !== null && testWallets().has(payer)),
  };
}

/** Register on the resource server: server.onAfterSettle(logEurcSettlement). */
export async function logEurcSettlement(ctx: SettleResultContext): Promise<void> {
  const rec = eurcRecordFrom(ctx);
  if (!rec) return;
  console.log(`[eurc-revenue] ${JSON.stringify(rec)}`);
  const file = process.env.EURC_REVENUE_LOG?.trim();
  if (file) fs.appendFileSync(file, JSON.stringify(rec) + "\n");
}

/** Non-test EURC totals, deduped by tx. Never mixed with USDC. */
export function countEurc(records: EurcRevenueRecord[]) {
  const seen = new Set<string>(); let atomic = 0n; const buyers = new Set<string>(); let calls = 0;
  for (const r of records) {
    if (r.test || r.currency !== "EUR" || seen.has(r.tx)) continue;
    seen.add(r.tx); atomic += BigInt(r.amountAtomic); calls++; if (r.payer) buyers.add(r.payer);
  }
  return { currency: "EUR" as const, calls, buyers: buyers.size, amountAtomic: atomic.toString(), amountEur: Number(atomic) / 1e6 };
}
