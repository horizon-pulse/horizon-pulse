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
