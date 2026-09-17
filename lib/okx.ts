/**
 * OKX public funding rates.
 * Prefer OKX over Binance/Bybit — those are often geo-blocked on Vercel egress.
 */

const OKX_BASE = "https://www.okx.com/api/v5";

const INST_MAP = {
  BTC: "BTC-USDT-SWAP",
  ETH: "ETH-USDT-SWAP",
  SOL: "SOL-USDT-SWAP",
} as const;

export type OkxSymbol = keyof typeof INST_MAP;

export type FundingSnapshot = {
  symbol: OkxSymbol;
  instId: string;
  fundingRate: number;
  nextFundingRate: number | null;
  fundingTime: string | null;
};

export async function fetchFundingRate(
  symbol: OkxSymbol,
): Promise<FundingSnapshot> {
  const instId = INST_MAP[symbol];
  const url = `${OKX_BASE}/public/funding-rate?instId=${instId}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "horizon-pulse/1.0",
    },
    next: { revalidate: 60 },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OKX ${res.status} funding ${instId}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    code?: string;
    data?: Array<{
      fundingRate?: string;
      nextFundingRate?: string;
      fundingTime?: string;
    }>;
    msg?: string;
  };
  if (body.code !== "0" || !body.data?.[0]) {
    throw new Error(
      `OKX funding error for ${instId}: ${body.msg ?? JSON.stringify(body)}`,
    );
  }
  const row = body.data[0];
  const fundingRate = Number(row.fundingRate);
  if (!Number.isFinite(fundingRate)) {
    throw new Error(`Invalid funding rate for ${instId}`);
  }
  return {
    symbol,
    instId,
    fundingRate,
    nextFundingRate:
      row.nextFundingRate != null && Number.isFinite(Number(row.nextFundingRate))
        ? Number(row.nextFundingRate)
        : null,
    fundingTime: row.fundingTime ?? null,
  };
}

export async function fetchAllFunding(
  symbols: OkxSymbol[] = ["BTC", "ETH", "SOL"],
): Promise<FundingSnapshot[]> {
  return Promise.all(symbols.map(fetchFundingRate));
}

/**
 * Simple rule-based crowding hint from funding sign + magnitude.
 * Not a prediction — transparent thresholds only.
 *
 * |fundingRate| thresholds (per 8h settlement style rates as returned by OKX):
 *   < 0.00005 (~0.005%) → neutral / quiet
 *   < 0.0003  (~0.03%)  → mild
 *   < 0.001   (~0.1%)   → elevated
 *   >= 0.001            → extreme
 * Sign: positive → longs paying (crowded long); negative → shorts paying (crowded short).
 */
export type CrowdingLevel = "quiet" | "mild" | "elevated" | "extreme";
export type CrowdingSide = "neutral" | "longs" | "shorts";

export type CrowdingHint = {
  side: CrowdingSide;
  level: CrowdingLevel;
  absRate: number;
  rule: string;
};

export function crowdingHintFromFunding(fundingRate: number): CrowdingHint {
  const absRate = Math.abs(fundingRate);
  let level: CrowdingLevel;
  if (absRate < 0.00005) level = "quiet";
  else if (absRate < 0.0003) level = "mild";
  else if (absRate < 0.001) level = "elevated";
  else level = "extreme";

  let side: CrowdingSide = "neutral";
  if (level !== "quiet") {
    side = fundingRate > 0 ? "longs" : "shorts";
  }

  const rule =
    level === "quiet"
      ? "|rate|<0.00005 → quiet/neutral"
      : fundingRate > 0
        ? `rate>0 & |rate| ${level} → crowded longs (longs pay shorts)`
        : `rate<0 & |rate| ${level} → crowded shorts (shorts pay longs)`;

  return { side, level, absRate, rule };
}

export const FUNDING_METHODOLOGY = {
  source: "OKX public /api/v5/public/funding-rate (BTC/ETH/SOL-USDT-SWAP)",
  venue: "okx",
  note: "Real OKX data only — not Binance/Bybit (often geo-blocked on Vercel egress).",
  crowding:
    "Optional rule-based hint from funding sign + |rate| thresholds (quiet/mild/elevated/extreme). Not a forecast.",
  thresholds: {
    quiet: "|rate| < 0.00005",
    mild: "0.00005 <= |rate| < 0.0003",
    elevated: "0.0003 <= |rate| < 0.001",
    extreme: "|rate| >= 0.001",
    side: "positive → longs; negative → shorts; quiet → neutral",
  },
} as const;

