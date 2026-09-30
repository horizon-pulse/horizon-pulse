import { NextRequest, NextResponse } from "next/server";
import {
  buildPortfolio,
  parseEvmAddress,
  PORTFOLIO_METHODOLOGY,
} from "@/lib/portfolio";
import {
  PORTFOLIO_PRICE_ATOMIC,
  PORTFOLIO_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";
import { isMissing, NULL_BY_DESIGN, upstreamUnavailable } from "@/lib/upstream-guard";

export const paymentOpts = {
  maxAmountRequired: PORTFOLIO_PRICE_ATOMIC,
  resource: "/api/portfolio",
  description:
    "On-chain portfolio (?address=0x...) Base+Ethereum: balances, risk score, rebalance suggestions",
} as const;

export async function portfolioHandler(req: NextRequest): Promise<NextResponse> {
  const address = parseEvmAddress(req.nextUrl.searchParams.get("address"));
  if (!address) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Query param address is required and must be a 0x-prefixed 40-hex EVM address (e.g. ?address=0xabc...)",
        methodology: PORTFOLIO_METHODOLOGY,
      },
      { status: 400 },
    );
  }

  try {
    const result = await buildPortfolio(address);
    const anyNetworkOk = result.networks.some((n) => n.ok);
    const status = anyNetworkOk ? 200 : 502;
    if (anyNetworkOk) {
      const missing = [
        ...new Set(
          result.holdings
            .filter(
              (h) =>
                !NULL_BY_DESIGN.has(h.symbol) &&
                // A zero balance contributes $0 regardless of price; RPC-failed rows are already flagged.
                h.balanceAtomic !== "0" &&
                !("error" in h && h.error) &&
                isMissing(h.priceUsd),
            )
            .map((h) => h.symbol),
        ),
      ];
      if (missing.length > 0) {
        return upstreamUnavailable("/api/portfolio", missing, {
          methodology: PORTFOLIO_METHODOLOGY,
        });
      }
    }

    return NextResponse.json(
      {
        ok: anyNetworkOk,
        source: ["rpc", ...(result.priceSources ?? [])].join("+"),
        priced: {
          amountUsd: PORTFOLIO_PRICE_USD,
          amountAtomic: PORTFOLIO_PRICE_ATOMIC,
          asset: USDC_BASE,
          network: "base",
          payTo: getPayTo(),
        },
        ...result,
      },
      { status },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "portfolio failed";
    return NextResponse.json(
      {
        ok: false,
        error: message,
        methodology: PORTFOLIO_METHODOLOGY,
      },
      { status: 502 },
    );
  }
}
