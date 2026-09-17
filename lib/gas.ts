/**
 * Live EIP-1559 gas snapshot for Base + Ethereum via public JSON-RPC.
 * Honest: real eth_feeHistory / eth_gasPrice only — no predictions or invented fees.
 */

import {
  createPublicClient,
  http,
  formatGwei,
  formatEther,
  type Chain,
  type PublicClient,
} from "viem";
import { base, mainnet } from "viem/chains";
import { fetchSpotPrices } from "./coingecko";

/** Simple ETH transfer gas limit (no calldata). */
export const SIMPLE_TRANSFER_GAS = 21_000n;

/** Blocks sampled for feeHistory + timingHint. */
export const FEE_HISTORY_BLOCKS = 20;

/** Reward percentiles requested from eth_feeHistory. */
export const REWARD_PERCENTILES = [10, 50, 90] as const;

export const GAS_METHODOLOGY = {
  sources:
    "JSON-RPC eth_feeHistory (preferred) with rewardPercentiles [10,50,90] over the last 20 blocks; falls back to eth_gasPrice if feeHistory is unavailable. Optional ETH/USD from CoinGecko /simple/price for transfer cost estimate.",
  networks:
    "Base (eip155:8453) and Ethereum mainnet (eip155:1). Optional BASE_RPC_URL / ETH_RPC_URL; otherwise public endpoints with failover (same defaults as /api/portfolio).",
  fields: {
    baseFeeGwei:
      "Latest baseFeePerGas from feeHistory (last element of the returned baseFee array, which includes the next-block base fee).",
    priorityFeeGwei:
      "Median (p50) of per-block reward[1] from feeHistory across the window. If feeHistory lacks rewards, omitted.",
    suggestedMaxFeeGwei:
      "2 * baseFee + priorityFee (common wallet heuristic for inclusion). If only eth_gasPrice is available, that value is used as suggestedMaxFee and labeled gasPrice fallback.",
    simpleTransfer:
      "Cost = suggestedMaxFee * 21000 gas. ETH amount via formatEther; USD = ETH * CoinGecko ethereum USD when price fetch succeeds.",
  },
  timingHint:
    "Within the same feeHistory baseFee sample (excluding the pending next-block fee when length > blockCount): compute the percentile rank of the current (latest confirmed) baseFee among those samples. cheap = rank < 33rd percentile; expensive = rank > 67th; otherwise normal. If only a single sample or gasPrice fallback, timingHint is normal with note. Not a forecast — descriptive of the recent window only.",
  honesty:
    "No fake predictions, no smoothed invented curves. RPC or CoinGecko failures are surfaced per network / in warnings.",
} as const;

export type TimingHint = "cheap" | "normal" | "expensive";

export type NetworkGasKey = "base" | "ethereum";

export type NetworkGasSnapshot = {
  network: NetworkGasKey;
  chainId: number;
  caip2: string;
  ok: boolean;
  rpc: string | null;
  source: "eth_feeHistory" | "eth_gasPrice" | null;
  baseFeeGwei: string | null;
  priorityFeeGwei: string | null;
  /** p10 / p50 / p90 priority fees in gwei when available */
  priorityFeePercentilesGwei: {
    p10: string;
    p50: string;
    p90: string;
  } | null;
  suggestedMaxFeeGwei: string | null;
  timingHint: TimingHint | null;
  timingDetail: {
    sampleSize: number;
    currentBaseFeeGwei: string | null;
    percentileRank: number | null;
    rule: string;
  } | null;
  simpleTransfer: {
    gasLimit: number;
    costWei: string | null;
    costEth: string | null;
    costUsd: number | null;
  } | null;
  error?: string;
};

export type GasResult = {
  asOf: string;
  ethUsd: number | null;
  networks: NetworkGasSnapshot[];
  warnings: string[];
  methodology: typeof GAS_METHODOLOGY;
};

type NetDef = {
  key: NetworkGasKey;
  chainId: number;
  caip2: string;
  chain: Chain;
  rpcEnv: string;
  defaultRpcs: string[];
};

const NETWORKS: NetDef[] = [
  {
    key: "base",
    chainId: 8453,
    caip2: "eip155:8453",
    chain: base,
    rpcEnv: "BASE_RPC_URL",
    defaultRpcs: [
      "https://base.publicnode.com",
      "https://base.drpc.org",
      "https://mainnet.base.org",
    ],
  },
  {
    key: "ethereum",
    chainId: 1,
    caip2: "eip155:1",
    chain: mainnet,
    rpcEnv: "ETH_RPC_URL",
    defaultRpcs: [
      "https://ethereum.publicnode.com",
      "https://eth.drpc.org",
    ],
  },
];

function rpcCandidates(def: NetDef): string[] {
  const fromEnv = process.env[def.rpcEnv]?.trim();
  if (fromEnv) return [fromEnv, ...def.defaultRpcs.filter((u) => u !== fromEnv)];
  return [...def.defaultRpcs];
}

function gweiStr(wei: bigint): string {
  // Trim trailing zeros for readability while staying decimal
  const s = formatGwei(wei);
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "") || "0";
}

function percentileRank(sortedAsc: bigint[], value: bigint): number {
  if (sortedAsc.length === 0) return 50;
  let below = 0;
  let equal = 0;
  for (const v of sortedAsc) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  // Mid-rank for ties
  return ((below + equal / 2) / sortedAsc.length) * 100;
}

function timingFromRank(rank: number): TimingHint {
  if (rank < 33) return "cheap";
  if (rank > 67) return "expensive";
  return "normal";
}

function medianBigint(values: bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

async function withRpcFailover<T>(
  def: NetDef,
  fn: (client: PublicClient, rpc: string) => Promise<T>,
): Promise<{ ok: true; value: T; rpc: string } | { ok: false; error: string }> {
  const errors: string[] = [];
  for (const rpc of rpcCandidates(def)) {
    try {
      const client = createPublicClient({
        chain: def.chain,
        transport: http(rpc, { timeout: 12_000 }),
      });
      const value = await fn(client as PublicClient, rpc);
      return { ok: true, value, rpc };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${rpc}: ${msg.slice(0, 160)}`);
    }
  }
  return { ok: false, error: errors.join(" | ") || "all RPCs failed" };
}

type FeeHistoryCore = {
  source: "eth_feeHistory";
  baseFeeWei: bigint;
  /** Confirmed-block base fees used for timing (excludes pending next when possible) */
  sampleBaseFees: bigint[];
  priorityP10: bigint | null;
  priorityP50: bigint | null;
  priorityP90: bigint | null;
};

type GasPriceCore = {
  source: "eth_gasPrice";
  gasPriceWei: bigint;
};

async function fetchFeeCore(
  client: PublicClient,
): Promise<FeeHistoryCore | GasPriceCore> {
  try {
    const history = await client.getFeeHistory({
      blockCount: FEE_HISTORY_BLOCKS,
      rewardPercentiles: [...REWARD_PERCENTILES],
    });

    const baseFees = history.baseFeePerGas ?? [];
    if (baseFees.length === 0) {
      throw new Error("eth_feeHistory returned empty baseFeePerGas");
    }

    // feeHistory returns blockCount+1 base fees (includes next block)
    const baseFeeWei = baseFees[baseFees.length - 1]!;
    const sampleBaseFees =
      baseFees.length > FEE_HISTORY_BLOCKS
        ? baseFees.slice(0, -1)
        : [...baseFees];

    const rewards = history.reward ?? [];
    const p10s: bigint[] = [];
    const p50s: bigint[] = [];
    const p90s: bigint[] = [];
    for (const row of rewards) {
      if (!row || row.length < 3) continue;
      if (typeof row[0] === "bigint") p10s.push(row[0]);
      if (typeof row[1] === "bigint") p50s.push(row[1]);
      if (typeof row[2] === "bigint") p90s.push(row[2]);
    }

    return {
      source: "eth_feeHistory",
      baseFeeWei,
      sampleBaseFees,
      priorityP10: medianBigint(p10s),
      priorityP50: medianBigint(p50s),
      priorityP90: medianBigint(p90s),
    };
  } catch {
    const gasPriceWei = await client.getGasPrice();
    return { source: "eth_gasPrice", gasPriceWei };
  }
}

function buildSnapshot(
  def: NetDef,
  rpc: string,
  core: FeeHistoryCore | GasPriceCore,
  ethUsd: number | null,
): NetworkGasSnapshot {
  if (core.source === "eth_gasPrice") {
    const suggested = core.gasPriceWei;
    const costWei = suggested * SIMPLE_TRANSFER_GAS;
    const costEth = formatEther(costWei);
    const costUsd =
      ethUsd != null && Number.isFinite(ethUsd)
        ? Number(costEth) * ethUsd
        : null;
    return {
      network: def.key,
      chainId: def.chainId,
      caip2: def.caip2,
      ok: true,
      rpc,
      source: "eth_gasPrice",
      baseFeeGwei: null,
      priorityFeeGwei: null,
      priorityFeePercentilesGwei: null,
      suggestedMaxFeeGwei: gweiStr(suggested),
      timingHint: "normal",
      timingDetail: {
        sampleSize: 1,
        currentBaseFeeGwei: null,
        percentileRank: null,
        rule: "gasPrice fallback — insufficient history for cheap/expensive; reported as normal",
      },
      simpleTransfer: {
        gasLimit: Number(SIMPLE_TRANSFER_GAS),
        costWei: costWei.toString(),
        costEth,
        costUsd:
          costUsd != null && Number.isFinite(costUsd)
            ? Number(costUsd.toFixed(6))
            : null,
      },
    };
  }

  const priority = core.priorityP50 ?? 0n;
  const suggestedMax = core.baseFeeWei * 2n + priority;

  // Percentile rank of latest *confirmed* base fee in the sample window
  const confirmed =
    core.sampleBaseFees.length > 0
      ? core.sampleBaseFees[core.sampleBaseFees.length - 1]!
      : core.baseFeeWei;
  const sorted = [...core.sampleBaseFees].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  let hint: TimingHint = "normal";
  let rank: number | null = null;
  let rule =
    "insufficient sample — default normal (need >= 3 baseFee samples)";
  if (sorted.length >= 3) {
    rank = percentileRank(sorted, confirmed);
    hint = timingFromRank(rank);
    rule =
      "cheap if percentileRank < 33; expensive if > 67; else normal (rank of latest confirmed baseFee in last 20 blocks)";
  }

  const costWei = suggestedMax * SIMPLE_TRANSFER_GAS;
  const costEth = formatEther(costWei);
  const costUsd =
    ethUsd != null && Number.isFinite(ethUsd)
      ? Number(costEth) * ethUsd
      : null;

  return {
    network: def.key,
    chainId: def.chainId,
    caip2: def.caip2,
    ok: true,
    rpc,
    source: "eth_feeHistory",
    baseFeeGwei: gweiStr(core.baseFeeWei),
    priorityFeeGwei: core.priorityP50 != null ? gweiStr(core.priorityP50) : null,
    priorityFeePercentilesGwei:
      core.priorityP10 != null &&
      core.priorityP50 != null &&
      core.priorityP90 != null
        ? {
            p10: gweiStr(core.priorityP10),
            p50: gweiStr(core.priorityP50),
            p90: gweiStr(core.priorityP90),
          }
        : null,
    suggestedMaxFeeGwei: gweiStr(suggestedMax),
    timingHint: hint,
    timingDetail: {
      sampleSize: sorted.length,
      currentBaseFeeGwei: gweiStr(confirmed),
      percentileRank: rank != null ? Number(rank.toFixed(1)) : null,
      rule,
    },
    simpleTransfer: {
      gasLimit: Number(SIMPLE_TRANSFER_GAS),
      costWei: costWei.toString(),
      costEth,
      costUsd:
        costUsd != null && Number.isFinite(costUsd)
          ? Number(costUsd.toFixed(6))
          : null,
    },
  };
}

export async function fetchGasSnapshot(): Promise<GasResult> {
  const warnings: string[] = [];
  let ethUsd: number | null = null;

  try {
    const spots = await fetchSpotPrices(["ETH"]);
    ethUsd = spots[0]?.priceUsd ?? null;
    if (ethUsd == null) warnings.push("CoinGecko ETH USD price missing");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`CoinGecko ETH USD unavailable: ${msg.slice(0, 160)}`);
  }

  const networks: NetworkGasSnapshot[] = [];

  await Promise.all(
    NETWORKS.map(async (def) => {
      const result = await withRpcFailover(def, async (client) =>
        fetchFeeCore(client),
      );
      if (!result.ok) {
        networks.push({
          network: def.key,
          chainId: def.chainId,
          caip2: def.caip2,
          ok: false,
          rpc: null,
          source: null,
          baseFeeGwei: null,
          priorityFeeGwei: null,
          priorityFeePercentilesGwei: null,
          suggestedMaxFeeGwei: null,
          timingHint: null,
          timingDetail: null,
          simpleTransfer: null,
          error: result.error,
        });
        warnings.push(`${def.key}: ${result.error}`);
        return;
      }
      networks.push(
        buildSnapshot(def, result.rpc, result.value, ethUsd),
      );
    }),
  );

  // Stable order: base, ethereum
  networks.sort((a, b) => {
    const order = { base: 0, ethereum: 1 };
    return order[a.network] - order[b.network];
  });

  return {
    asOf: new Date().toISOString(),
    ethUsd,
    networks,
    warnings,
    methodology: GAS_METHODOLOGY,
  };
}
