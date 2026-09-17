import Link from "next/link";
import {
  DEFAULT_PAY_TO,
  GITHUB_REPO,
  PULSE_PRICE_USD,
  SIGNALS_PRICE_USD,
  YIELD_PRICE_USD,
  PORTFOLIO_PRICE_USD,
  GAS_PRICE_USD,
  FUNDING_PRICE_USD,
  USDC_BASE,
  CDP_FACILITATOR_URL,
} from "@/lib/config";
import { fetchTreasuryUsdcBalance } from "@/lib/treasury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function StatusPage() {
  let balanceBlock: {
    ok: true;
    balanceUsdc: string;
    balanceAtomic: string;
    payTo: string;
    fetchedAt: string;
  } | {
    ok: false;
    error: string;
    payTo: string;
  };

  try {
    const bal = await fetchTreasuryUsdcBalance();
    balanceBlock = {
      ok: true,
      balanceUsdc: bal.balanceUsdc,
      balanceAtomic: bal.balanceAtomic,
      payTo: bal.payTo,
      fetchedAt: bal.fetchedAt,
    };
  } catch (err) {
    balanceBlock = {
      ok: false,
      error: err instanceof Error ? err.message : "balance fetch failed",
      payTo: DEFAULT_PAY_TO,
    };
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 20px" }}>
      <p style={{ opacity: 0.7, letterSpacing: "0.08em", fontSize: 12 }}>
        STATUS
      </p>
      <h1 style={{ fontSize: 28, margin: "8px 0 16px" }}>Horizon Pulse</h1>
      <p style={{ opacity: 0.9 }}>
        Free public dashboard. Shows the on-chain USDC balance of the x402{" "}
        <code>payTo</code> treasury on Base — not invented metrics.
      </p>

      <section
        style={{
          marginTop: 28,
          padding: 20,
          borderRadius: 12,
          background: "#121a33",
          border: "1px solid #243056",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Treasury (USDC on Base)</h2>
        {balanceBlock.ok ? (
          <>
            <p style={{ fontSize: 32, margin: "8px 0", fontWeight: 700 }}>
              {Number(balanceBlock.balanceUsdc).toLocaleString(undefined, {
                maximumFractionDigits: 6,
              })}{" "}
              <span style={{ fontSize: 16, opacity: 0.7 }}>USDC</span>
            </p>
            <p style={{ fontSize: 13, opacity: 0.75, wordBreak: "break-all" }}>
              payTo: {balanceBlock.payTo}
              <br />
              atomic: {balanceBlock.balanceAtomic}
              <br />
              asset: {USDC_BASE}
              <br />
              as of: {balanceBlock.fetchedAt} (UTC)
            </p>
          </>
        ) : (
          <>
            <p style={{ color: "#ffb4b4" }}>
              Could not load balance: {balanceBlock.error}
            </p>
            <p style={{ fontSize: 13, opacity: 0.75, wordBreak: "break-all" }}>
              Expected payTo: {balanceBlock.payTo}
            </p>
          </>
        )}
      </section>

      <section style={{ marginTop: 24, fontSize: 14 }}>
        <h2 style={{ fontSize: 16 }}>Product</h2>
        <ul style={{ paddingLeft: 18 }}>
          <li>
            <code>/api/pulse</code> — {PULSE_PRICE_USD} USDC / call — CoinGecko
            BTC/ETH/SOL + momentum
          </li>
          <li>
            <code>/api/signals</code> — {SIGNALS_PRICE_USD} USDC / call —
            RSI/MACD/Bollinger + OKX funding
          </li>
          <li>
            <code>/api/yield</code> — {YIELD_PRICE_USD} USDC / call —
            DefiLlama yields (TVL ≥ $10M, prefer stablecoin/single-asset)
          </li>
          <li>
            <code>/api/portfolio?address=0x…</code> — {PORTFOLIO_PRICE_USD} USDC
            / call — Base + Ethereum on-chain balances, rule-based risk +
            rebalance suggestions
          </li>
          <li>
            <code>/api/gas</code> — {GAS_PRICE_USD} USDC / call — Base +
            Ethereum gas (feeHistory) with timingHint + optional transfer USD
          </li>
          <li>
            <code>/api/funding</code> — {FUNDING_PRICE_USD} USDC / call — OKX
            BTC/ETH/SOL perpetual funding + rule-based crowding hint
          </li>
          <li>Network: base · Facilitator: {CDP_FACILITATOR_URL}</li>
        </ul>
      </section>

      <p style={{ marginTop: 28, display: "flex", gap: 16 }}>
        <Link href="/" style={{ color: "#8ec5ff" }}>
          Home
        </Link>
        <a
          href={GITHUB_REPO}
          style={{ color: "#8ec5ff" }}
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </p>
    </main>
  );
}
