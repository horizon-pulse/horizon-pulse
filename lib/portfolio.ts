/**
 * On-chain portfolio snapshot (Base + Ethereum) via public RPCs + CoinGecko USD marks.
 * Honest: real balanceOf / getBalance only; RPC or price failures are surfaced.
 */

import {
  createPublicClient,
  http,
  formatUnits,
  erc20Abi,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import { base, mainnet } from "viem/chains";

export const PORTFOLIO_METHODOLOGY = {
  balances:
    "Native getBalance + ERC-20 balanceOf via public JSON-RPC (no indexers). Only listed tokens; no NFTs, LP positions, or staked assets.",
  networks:
    "v1: Base (eip155:8453) and Ethereum mainnet (eip155:1). Optional BASE_RPC_URL / ETH_RPC_URL; otherwise public endpoints with failover.",
  tokens: {
    base: [
      "native ETH",
      "USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "WETH 0x4200000000000000000000000000000000000006",
      "DAI 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      "cbBTC 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf (Base BTC proxy — no BitGo WBTC contract on Base)",
    ],
    ethereum: [
      "native ETH",
      "USDC 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "WETH 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      "WBTC 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      "DAI 0x6B175474E89094C44Da98b954EedeAC495271d0F",
    ],
  },
  prices:
    "CoinGecko /simple/price USD marks (ethereum, usd-coin, weth, wrapped-bitcoin, dai, coinbase-wrapped-btc). Stables priced via CoinGecko, not hard-coded to $1.",
  riskScore:
    "0–100 (higher = riskier). riskScore = round( clamp0_100( 50*maxAssetWeight + 30*(1-stablecoinShare) + 20*maxChainWeight ) ). Empty / unpriced portfolio → null.",
  suggestions:
    "Deterministic rules only (no LLM): concentration, stablecoin share, chain concentration, dust gas buffer. Empty portfolio → fund wallet.",
} as const;

type TokenKind = "native" | "erc20";

type TokenDef = {
  symbol: string;
  kind: TokenKind;
  decimals: number;
  address?: Address;
  coingeckoId: string;
  stablecoin: boolean;
  /** Human note when symbol differs from common name (e.g. cbBTC vs WBTC) */
  note?: string;
};

export type NetworkKey = "base" | "ethereum";

const NETWORKS: Record<
  NetworkKey,
  {
    chainId: number;
    caip2: string;
    label: string;
    chain: Chain;
    rpcEnv: string;
    defaultRpcs: string[];
    tokens: TokenDef[];
  }
> = {
  base: {
    chainId: 8453,
    caip2: "eip155:8453",
    label: "Base",
    chain: base,
    rpcEnv: "BASE_RPC_URL",
    // Prefer publicnode/drpc — mainnet.base.org often rate-limits from shared egress
    defaultRpcs: [
      "https://base.publicnode.com",
      "https://base.drpc.org",
      "https://mainnet.base.org",
    ],
    tokens: [
      {
        symbol: "ETH",
        kind: "native",
        decimals: 18,
        coingeckoId: "ethereum",
        stablecoin: false,
      },
      {
        symbol: "USDC",
        kind: "erc20",
        decimals: 6,
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        coingeckoId: "usd-coin",
        stablecoin: true,
      },
      {
        symbol: "WETH",
        kind: "erc20",
        decimals: 18,
        address: "0x4200000000000000000000000000000000000006",
        coingeckoId: "weth",
        stablecoin: false,
      },
      {
        symbol: "DAI",
        kind: "erc20",
        decimals: 18,
        address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
        coingeckoId: "dai",
        stablecoin: true,
      },
      {
        symbol: "cbBTC",
        kind: "erc20",
        decimals: 8,
        address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
        coingeckoId: "coinbase-wrapped-btc",
        stablecoin: false,
        note: "Coinbase Wrapped BTC — Base has no BitGo WBTC; used as BTC exposure",
      },
    ],
  },
  ethereum: {
    chainId: 1,
    caip2: "eip155:1",
    label: "Ethereum",
    chain: mainnet,
    rpcEnv: "ETH_RPC_URL",
    defaultRpcs: [
      "https://ethereum.publicnode.com",
      "https://eth.drpc.org",
    ],
    tokens: [
      {
        symbol: "ETH",
        kind: "native",
        decimals: 18,
        coingeckoId: "ethereum",
        stablecoin: false,
      },
      {
        symbol: "USDC",
        kind: "erc20",
        decimals: 6,
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        coingeckoId: "usd-coin",
        stablecoin: true,
      },
      {
        symbol: "WETH",
        kind: "erc20",
        decimals: 18,
        address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        coingeckoId: "weth",
        stablecoin: false,
      },
      {
        symbol: "WBTC",
        kind: "erc20",
        decimals: 8,
        address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
        coingeckoId: "wrapped-bitcoin",
        stablecoin: false,
      },
      {
        symbol: "DAI",
        kind: "erc20",
        decimals: 18,
        address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        coingeckoId: "dai",
        stablecoin: true,
      },
    ],
  },
};

export type HoldingRow = {
  network: NetworkKey;
  chainId: number;
  symbol: string;
  kind: TokenKind;
  contract: string | null;
  decimals: number;
  balanceAtomic: string;
  balance: string;
  priceUsd: number | null;
  valueUsd: number | null;
  weight: number | null;
  stablecoin: boolean;
  note?: string;
  error?: string;
};

export type NetworkStatus = {
  network: NetworkKey;
  chainId: number;
  ok: boolean;
  rpc: string | null;
  error?: string;
};

export type Suggestion = {
  priority: "high" | "medium" | "low";
  code: string;
  message: string;
};

export type PortfolioResult = {
  address: `0x${string}`;
  asOf: string;
  networks: NetworkStatus[];
  holdings: HoldingRow[];
  totals: {
    valueUsd: number | null;
    stablecoinShare: number | null;
    maxAssetWeight: number | null;
    maxAssetSymbol: string | null;
    maxChainWeight: number | null;
    maxChain: NetworkKey | null;
  };
  risk: {
    score: number | null;
    band: "low" | "moderate" | "elevated" | "high" | "unknown";
    components: {
      concentration: number | null;
      nonStable: number | null;
      chainConcentration: number | null;
    };
  };
  suggestions: Suggestion[];
  methodology: typeof PORTFOLIO_METHODOLOGY;
  warnings: string[];
};

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function parseEvmAddress(
  raw: string | null | undefined,
): `0x${string}` | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!EVM_ADDRESS_RE.test(trimmed)) return null;
  return trimmed.toLowerCase() as `0x${string}`;
}

function rpcCandidates(network: NetworkKey): string[] {
  const conf = NETWORKS[network];
  const fromEnv = process.env[conf.rpcEnv]?.trim();
  const list: string[] = [];
  if (fromEnv) list.push(fromEnv);
  for (const u of conf.defaultRpcs) {
    if (!list.includes(u)) list.push(u);
  }
  return list;
}

async function withRpcFailover<T>(
  network: NetworkKey,
  run: (client: PublicClient, rpc: string) => Promise<T>,
): Promise<{ ok: true; value: T; rpc: string } | { ok: false; error: string }> {
  const conf = NETWORKS[network];
  const errors: string[] = [];
  for (const rpc of rpcCandidates(network)) {
    try {
      const client = createPublicClient({
        chain: conf.chain,
        transport: http(rpc, { timeout: 12_000 }),
      });
      const value = await run(client as PublicClient, rpc);
      return { ok: true, value, rpc };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${rpc}: ${msg.slice(0, 160)}`);
    }
  }
  return {
    ok: false,
    error: `All ${network} RPCs failed. ${errors.join(" | ")}`,
  };
}

async function fetchUsdPrices(
  ids: string[],
): Promise<{ prices: Record<string, number>; error?: string }> {
  const unique = [...new Set(ids)];
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${unique.join(",")}&vs_currencies=usd`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "horizon-pulse/1.0 (+https://github.com/horizon-pulse/horizon-pulse)",
      },
      next: { revalidate: 30 },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        prices: {},
        error: `CoinGecko ${res.status}: ${text.slice(0, 160)}`,
      };
    }
    const data = (await res.json()) as Record<string, { usd?: number }>;
    const prices: Record<string, number> = {};
    for (const id of unique) {
      const usd = data[id]?.usd;
      if (typeof usd === "number" && Number.isFinite(usd)) {
        prices[id] = usd;
      }
    }
    const missing = unique.filter((id) => prices[id] === undefined);
    return {
      prices,
      error:
        missing.length > 0
          ? `Missing CoinGecko USD for: ${missing.join(", ")}`
          : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { prices: {}, error: `CoinGecko fetch failed: ${msg}` };
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function riskBand(
  score: number | null,
): "low" | "moderate" | "elevated" | "high" | "unknown" {
  if (score === null) return "unknown";
  if (score < 30) return "low";
  if (score < 50) return "moderate";
  if (score < 70) return "elevated";
  return "high";
}

function buildSuggestions(opts: {
  totalUsd: number | null;
  stableShare: number | null;
  maxAssetWeight: number | null;
  maxAssetSymbol: string | null;
  maxChainWeight: number | null;
  maxChain: NetworkKey | null;
  holdings: HoldingRow[];
  networkOk: boolean;
}): Suggestion[] {
  const out: Suggestion[] = [];
  if (!opts.networkOk) {
    out.push({
      priority: "high",
      code: "rpc_unavailable",
      message:
        "One or more networks failed RPC reads — treat balances as incomplete; retry later or set BASE_RPC_URL / ETH_RPC_URL.",
    });
  }

  if (opts.totalUsd === null || opts.totalUsd <= 0) {
    out.push({
      priority: "medium",
      code: "empty_portfolio",
      message:
        "No priced balances among tracked tokens. Fund the wallet (or confirm the address) before rebalancing.",
    });
    return out;
  }

  if (
    opts.maxAssetWeight !== null &&
    opts.maxAssetWeight >= 0.5 &&
    opts.maxAssetSymbol
  ) {
    out.push({
      priority: "high",
      code: "concentration_high",
      message: `${opts.maxAssetSymbol} is ${(opts.maxAssetWeight * 100).toFixed(1)}% of portfolio USD. Rule: trim toward ≤40% single-asset weight (swap a slice to USDC/DAI or another asset).`,
    });
  } else if (
    opts.maxAssetWeight !== null &&
    opts.maxAssetWeight >= 0.35 &&
    opts.maxAssetSymbol
  ) {
    out.push({
      priority: "medium",
      code: "concentration_watch",
      message: `${opts.maxAssetSymbol} is ${(opts.maxAssetWeight * 100).toFixed(1)}% of portfolio. Consider capping any single asset near 30–40%.`,
    });
  }

  if (opts.stableShare !== null && opts.stableShare < 0.15) {
    out.push({
      priority: "high",
      code: "stables_low",
      message: `Stablecoins are ${(opts.stableShare * 100).toFixed(1)}% of USD value. Rule: raise USDC/DAI toward ≥20% for dry powder and lower drawdown.`,
    });
  } else if (opts.stableShare !== null && opts.stableShare > 0.85) {
    out.push({
      priority: "low",
      code: "stables_high",
      message: `Stablecoins are ${(opts.stableShare * 100).toFixed(1)}% of USD value. Rule: if seeking market exposure, allocate a defined slice (e.g. 10–30%) to ETH/WETH rather than remaining fully cash.`,
    });
  }

  if (
    opts.maxChainWeight !== null &&
    opts.maxChainWeight >= 0.85 &&
    opts.maxChain
  ) {
    out.push({
      priority: "medium",
      code: "chain_concentration",
      message: `${opts.maxChain} holds ${(opts.maxChainWeight * 100).toFixed(1)}% of USD value. Rule: keep a bridgeable buffer on the other chain (≥15%) for gas and venue diversity.`,
    });
  }

  // Gas buffer: native ETH < ~$5 equivalent while other holdings exist on that chain
  for (const net of ["base", "ethereum"] as NetworkKey[]) {
    const native = opts.holdings.find(
      (h) => h.network === net && h.symbol === "ETH" && h.kind === "native",
    );
    const otherValue = opts.holdings
      .filter((h) => h.network === net && !(h.kind === "native"))
      .reduce((s, h) => s + (h.valueUsd ?? 0), 0);
    if (
      native &&
      native.valueUsd !== null &&
      native.valueUsd < 5 &&
      otherValue > 50
    ) {
      out.push({
        priority: "medium",
        code: "gas_buffer_low",
        message: `Native ETH on ${net} is only ~$${native.valueUsd.toFixed(2)} while other ${net} holdings are ~$${otherValue.toFixed(0)}. Rule: keep a small ETH gas buffer (unwrap a bit of WETH if needed).`,
      });
    }
  }

  if (out.length === 0) {
    out.push({
      priority: "low",
      code: "balanced",
      message:
        "No hard rule breaches: concentration, stable share, and chain mix look within guidelines. Re-check after large transfers.",
    });
  }

  return out;
}

export async function buildPortfolio(
  address: `0x${string}`,
): Promise<PortfolioResult> {
  const warnings: string[] = [];
  const asOf = new Date().toISOString();
  const networkKeys = Object.keys(NETWORKS) as NetworkKey[];

  const allPriceIds = networkKeys.flatMap((n) =>
    NETWORKS[n].tokens.map((t) => t.coingeckoId),
  );
  const priceResult = await fetchUsdPrices(allPriceIds);
  if (priceResult.error) {
    warnings.push(priceResult.error);
  }

  const holdings: HoldingRow[] = [];
  const networks: NetworkStatus[] = [];

  for (const network of networkKeys) {
    const conf = NETWORKS[network];
    const read = await withRpcFailover(network, async (client) => {
      const rows: Omit<
        HoldingRow,
        "priceUsd" | "valueUsd" | "weight"
      >[] = [];

      for (const tok of conf.tokens) {
        try {
          let raw: bigint;
          if (tok.kind === "native") {
            raw = await client.getBalance({ address });
          } else {
            raw = await client.readContract({
              address: tok.address!,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [address],
            });
          }
          rows.push({
            network,
            chainId: conf.chainId,
            symbol: tok.symbol,
            kind: tok.kind,
            contract: tok.kind === "native" ? null : (tok.address as string),
            decimals: tok.decimals,
            balanceAtomic: raw.toString(),
            balance: formatUnits(raw, tok.decimals),
            stablecoin: tok.stablecoin,
            ...(tok.note ? { note: tok.note } : {}),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          rows.push({
            network,
            chainId: conf.chainId,
            symbol: tok.symbol,
            kind: tok.kind,
            contract: tok.kind === "native" ? null : (tok.address as string),
            decimals: tok.decimals,
            balanceAtomic: "0",
            balance: "0",
            stablecoin: tok.stablecoin,
            error: msg.slice(0, 200),
            ...(tok.note ? { note: tok.note } : {}),
          });
        }
      }
      return rows;
    });

    if (!read.ok) {
      networks.push({
        network,
        chainId: conf.chainId,
        ok: false,
        rpc: null,
        error: read.error,
      });
      warnings.push(`${conf.label} RPC failed: ${read.error}`);
      for (const tok of conf.tokens) {
        holdings.push({
          network,
          chainId: conf.chainId,
          symbol: tok.symbol,
          kind: tok.kind,
          contract: tok.kind === "native" ? null : (tok.address as string),
          decimals: tok.decimals,
          balanceAtomic: "0",
          balance: "0",
          priceUsd: priceResult.prices[tok.coingeckoId] ?? null,
          valueUsd: null,
          weight: null,
          stablecoin: tok.stablecoin,
          error: `network_rpc_failed`,
          ...(tok.note ? { note: tok.note } : {}),
        });
      }
      continue;
    }

    networks.push({
      network,
      chainId: conf.chainId,
      ok: true,
      rpc: read.rpc,
    });

    for (const row of read.value) {
      const tok = conf.tokens.find((t) => t.symbol === row.symbol)!;
      const priceUsd = priceResult.prices[tok.coingeckoId] ?? null;
      let valueUsd: number | null = null;
      if (priceUsd !== null && !row.error) {
        const bal = Number(row.balance);
        if (Number.isFinite(bal)) {
          valueUsd = bal * priceUsd;
        }
      }
      holdings.push({
        ...row,
        priceUsd,
        valueUsd,
        weight: null,
      });
    }
  }

  const priced = holdings.filter(
    (h) => h.valueUsd !== null && Number.isFinite(h.valueUsd!),
  );
  const totalUsd = priced.reduce((s, h) => s + (h.valueUsd as number), 0);

  let stableShare: number | null = null;
  let maxAssetWeight: number | null = null;
  let maxAssetSymbol: string | null = null;
  let maxChainWeight: number | null = null;
  let maxChain: NetworkKey | null = null;

  if (totalUsd > 0) {
    for (const h of holdings) {
      if (h.valueUsd !== null) {
        h.weight = h.valueUsd / totalUsd;
      }
    }
    const stableUsd = priced
      .filter((h) => h.stablecoin)
      .reduce((s, h) => s + (h.valueUsd as number), 0);
    stableShare = stableUsd / totalUsd;

    // Max by symbol across chains (ETH on base+eth combined, etc.)
    const bySymbol = new Map<string, number>();
    for (const h of priced) {
      bySymbol.set(
        h.symbol,
        (bySymbol.get(h.symbol) ?? 0) + (h.valueUsd as number),
      );
    }
    for (const [sym, usd] of bySymbol) {
      const w = usd / totalUsd;
      if (maxAssetWeight === null || w > maxAssetWeight) {
        maxAssetWeight = w;
        maxAssetSymbol = sym;
      }
    }

    const byChain = new Map<NetworkKey, number>();
    for (const h of priced) {
      byChain.set(
        h.network,
        (byChain.get(h.network) ?? 0) + (h.valueUsd as number),
      );
    }
    for (const [net, usd] of byChain) {
      const w = usd / totalUsd;
      if (maxChainWeight === null || w > maxChainWeight) {
        maxChainWeight = w;
        maxChain = net;
      }
    }
  }

  const concentration =
    maxAssetWeight !== null ? 50 * clamp01(maxAssetWeight) : null;
  const nonStable =
    stableShare !== null ? 30 * clamp01(1 - stableShare) : null;
  const chainConc =
    maxChainWeight !== null ? 20 * clamp01(maxChainWeight) : null;

  let score: number | null = null;
  if (
    concentration !== null &&
    nonStable !== null &&
    chainConc !== null
  ) {
    score = Math.round(
      Math.min(100, Math.max(0, concentration + nonStable + chainConc)),
    );
  }

  const networkOk = networks.every((n) => n.ok);
  const suggestions = buildSuggestions({
    totalUsd: totalUsd > 0 ? totalUsd : null,
    stableShare,
    maxAssetWeight,
    maxAssetSymbol,
    maxChainWeight,
    maxChain,
    holdings,
    networkOk,
  });

  return {
    address,
    asOf,
    networks,
    holdings,
    totals: {
      valueUsd: totalUsd > 0 ? totalUsd : totalUsd === 0 ? 0 : null,
      stablecoinShare: stableShare,
      maxAssetWeight,
      maxAssetSymbol,
      maxChainWeight,
      maxChain,
    },
    risk: {
      score,
      band: riskBand(score),
      components: {
        concentration,
        nonStable,
        chainConcentration: chainConc,
      },
    },
    suggestions,
    methodology: PORTFOLIO_METHODOLOGY,
    warnings,
  };
}
