/**
 * DefiLlama yields — fetch, filter, and transparently rank pools.
 * Source: https://yields.llama.fi/pools (real data only).
 */

const DEFILLAMA_YIELDS_URL = "https://yields.llama.fi/pools";

/** Minimum TVL hard filter */
export const MIN_TVL_USD = 10_000_000;

/** Default number of pools returned after ranking */
export const DEFAULT_TOP_N = 25;

export type DefiLlamaRawPool = {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apyBase: number | null;
  apyReward: number | null;
  apy: number | null;
  rewardTokens: string[] | null;
  pool: string;
  apyPct1D: number | null;
  apyPct7D: number | null;
  apyPct30D: number | null;
  stablecoin: boolean;
  ilRisk: string;
  exposure: string;
  poolMeta: string | null;
  outlier: boolean;
  apyMean30d: number | null;
  mu?: number | null;
  sigma?: number | null;
};

export type RankedYieldPool = {
  rank: number;
  poolId: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number | null;
  stablecoin: boolean;
  exposure: string;
  ilRisk: string;
  poolMeta: string | null;
  /** 2 = stablecoin+single, 1 = stablecoin OR single, 0 = neither (excluded from preferred set) */
  preferenceTier: 0 | 1 | 2;
  preferenceReason: string;
};

export const YIELD_METHODOLOGY = {
  source: "DefiLlama public yields API (https://yields.llama.fi/pools)",
  filters: [
    `Hard filter: tvlUsd >= $${(MIN_TVL_USD / 1e6).toFixed(0)}M`,
    "Hard filter: finite apy (number) and not flagged outlier",
    "Preference universe: stablecoin === true OR exposure === 'single' (multi-asset non-stables excluded)",
  ],
  ranking: [
    "preferenceTier DESC: 2 = stablecoin AND single-asset; 1 = stablecoin XOR single-asset",
    "Then apy DESC (reported DefiLlama total APY)",
    "Then tvlUsd DESC as tie-breaker",
  ],
  note: "All figures are passthrough from DefiLlama at fetch time — Horizon Pulse does not invent yields.",
} as const;

type PoolsResponse = {
  status?: string;
  data?: DefiLlamaRawPool[];
};

async function fetchRawPools(): Promise<DefiLlamaRawPool[]> {
  const res = await fetch(DEFILLAMA_YIELDS_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "horizon-pulse/1.0 (+https://github.com/horizon-pulse/horizon-pulse)",
    },
    // Fresh enough for paid calls; avoid stale multi-hour cache
    next: { revalidate: 60 },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `DefiLlama yields ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as PoolsResponse | DefiLlamaRawPool[];
  const pools = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(pools) || pools.length === 0) {
    throw new Error("DefiLlama yields returned empty pool list");
  }
  return pools;
}

function preferenceTier(p: DefiLlamaRawPool): 0 | 1 | 2 {
  const stable = Boolean(p.stablecoin);
  const single = (p.exposure || "").toLowerCase() === "single";
  if (stable && single) return 2;
  if (stable || single) return 1;
  return 0;
}

function preferenceReason(tier: 0 | 1 | 2, p: DefiLlamaRawPool): string {
  if (tier === 2) return "stablecoin + single-asset";
  if (tier === 1) {
    if (p.stablecoin) return "stablecoin";
    return "single-asset";
  }
  return "unpreferred";
}

/**
 * Fetch DefiLlama pools, apply TVL + preference filters, rank transparently.
 */
export async function fetchRankedYields(
  topN: number = DEFAULT_TOP_N,
): Promise<{
  pools: RankedYieldPool[];
  scanned: number;
  afterTvlFilter: number;
  afterPreferenceFilter: number;
  methodology: typeof YIELD_METHODOLOGY;
}> {
  const raw = await fetchRawPools();
  const scanned = raw.length;

  const afterTvl = raw.filter((p) => {
    if (typeof p.tvlUsd !== "number" || !(p.tvlUsd >= MIN_TVL_USD)) return false;
    if (typeof p.apy !== "number" || !Number.isFinite(p.apy)) return false;
    if (p.outlier === true) return false;
    return true;
  });

  // Prefer stablecoin / single-asset — keep only the preferred universe
  const preferred = afterTvl.filter((p) => preferenceTier(p) > 0);

  preferred.sort((a, b) => {
    const ta = preferenceTier(a);
    const tb = preferenceTier(b);
    if (tb !== ta) return tb - ta;
    if (b.apy !== a.apy) return (b.apy as number) - (a.apy as number);
    return b.tvlUsd - a.tvlUsd;
  });

  const sliced = preferred.slice(0, Math.max(1, topN));
  const pools: RankedYieldPool[] = sliced.map((p, i) => {
    const tier = preferenceTier(p);
    return {
      rank: i + 1,
      poolId: p.pool,
      chain: p.chain,
      project: p.project,
      symbol: p.symbol,
      tvlUsd: p.tvlUsd,
      apy: p.apy as number,
      apyBase: typeof p.apyBase === "number" ? p.apyBase : null,
      apyReward: typeof p.apyReward === "number" ? p.apyReward : null,
      apyMean30d: typeof p.apyMean30d === "number" ? p.apyMean30d : null,
      stablecoin: Boolean(p.stablecoin),
      exposure: p.exposure,
      ilRisk: p.ilRisk,
      poolMeta: p.poolMeta,
      preferenceTier: tier,
      preferenceReason: preferenceReason(tier, p),
    };
  });

  return {
    pools,
    scanned,
    afterTvlFilter: afterTvl.length,
    afterPreferenceFilter: preferred.length,
    methodology: YIELD_METHODOLOGY,
  };
}
