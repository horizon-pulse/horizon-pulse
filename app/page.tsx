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
} from "@/lib/config";

export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 20px" }}>
      <p style={{ opacity: 0.7, letterSpacing: "0.08em", fontSize: 12 }}>
        HORIZON PULSE
      </p>
      <h1 style={{ fontSize: 36, margin: "8px 0 16px", fontWeight: 700 }}>
        Pay-per-call crypto data for AI agents
      </h1>
      <p style={{ opacity: 0.9, fontSize: 18 }}>
        Honest x402 micropayments on{" "}
        <strong>Base mainnet</strong> (USDC). Agents discover endpoints, pay
        exactly once per call, and receive live CoinGecko prices, technical
        signals, live OKX perpetual funding (not Binance/Bybit), DefiLlama yield
        rankings, on-chain portfolio risk snapshots, and live Base/Ethereum gas.
      </p>

      <section
        style={{
          marginTop: 32,
          padding: 20,
          borderRadius: 12,
          background: "#121a33",
          border: "1px solid #243056",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Endpoints</h2>
        <ul style={{ paddingLeft: 18, marginBottom: 0 }}>
          <li>
            <code>GET /api/pulse</code> — {PULSE_PRICE_USD} USDC (5000 atomic) —
            BTC/ETH/SOL spot + momentum
          </li>
          <li>
            <code>GET /api/signals</code> — {SIGNALS_PRICE_USD} USDC (15000
            atomic) — RSI/MACD/Bollinger + OKX funding
          </li>
          <li>
            <code>GET /api/yield</code> — {YIELD_PRICE_USD} USDC (20000 atomic)
            — DefiLlama yields (TVL ≥ $10M, prefer stablecoin/single-asset)
          </li>
          <li>
            <code>GET /api/portfolio?address=0x…</code> — {PORTFOLIO_PRICE_USD}{" "}
            USDC (40000 atomic) — Base + Ethereum balances, risk score,
            rebalance suggestions
          </li>
          <li>
            <code>GET /api/gas</code> — {GAS_PRICE_USD} USDC (10000 atomic) —
            Base + Ethereum baseFee / priority / suggested maxFee + timingHint
          </li>
          <li>
            <code>GET /api/funding</code> — {FUNDING_PRICE_USD} USDC (10000
            atomic) — OKX BTC/ETH/SOL perpetual funding + crowding hint
          </li>
          <li>
            <code>GET /status</code> — free public treasury dashboard
          </li>
        </ul>
      </section>

      <section style={{ marginTop: 24, fontSize: 14, opacity: 0.85 }}>
        <p>
          <strong>payTo</strong>:{" "}
          <code style={{ wordBreak: "break-all" }}>{DEFAULT_PAY_TO}</code>
        </p>
        <p>
          <strong>USDC (Base)</strong>:{" "}
          <code style={{ wordBreak: "break-all" }}>{USDC_BASE}</code>
        </p>
        <p>
          <strong>Network</strong>: base (eip155:8453) ·{" "}
          <strong>Facilitator</strong>: Coinbase CDP x402
        </p>
      </section>

      <p style={{ marginTop: 32, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Link
          href="/status"
          style={{
            color: "#8ec5ff",
            textDecoration: "underline",
          }}
        >
          Open /status
        </Link>
        <a
          href={GITHUB_REPO}
          style={{ color: "#8ec5ff", textDecoration: "underline" }}
          rel="noreferrer"
          target="_blank"
        >
          GitHub
        </a>
      </p>

      <p style={{ marginTop: 40, fontSize: 13, opacity: 0.55 }}>
        No fake metrics. Paid routes return HTTP 402 with payment requirements
        until a valid x402 payment signature is provided. Settlement uses CDP
        when <code>CDP_API_KEY_ID</code> / <code>CDP_API_KEY_SECRET</code> are
        set.
      </p>
    </main>
  );
}
