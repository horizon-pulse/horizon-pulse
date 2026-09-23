import Link from "next/link";
import {
  DEFAULT_PAY_TO,
  GITHUB_REPO,
  USDC_BASE,
  BASE_CAIP2,
  PUBLIC_BASE_URL,
  PUBLIC_BASE_URL_BACKUP,
} from "@/lib/config";
import {
  CATALOG_NOTE,
  FIRST_SETTLE,
  LIVE_PAID_ROUTES,
} from "@/lib/live-catalog";
import { LiveRoutesList } from "@/components/LiveRoutesList";
import { AgentHowTo } from "@/components/AgentHowTo";

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
        Honest x402 micropayments on <strong>Base mainnet</strong> (USDC).{" "}
        {LIVE_PAID_ROUTES.length} live paid routes — six crypto frozen
        (CoinGecko prices, technical signals, OKX perpetual funding, DefiLlama
        yields, on-chain portfolio risk, Base/Ethereum gas) plus{" "}
        <code>/api/fetch</code> for public URL → clean text. No invented
        metrics. No advertised 404s.
      </p>

      <section
        style={{
          marginTop: 24,
          padding: 16,
          borderRadius: 10,
          background: "#211b12",
          border: "1px solid #6b5428",
        }}
      >
        <p style={{ margin: 0, fontSize: 14 }}>
          <strong>Payment destination notice:</strong> Only pay via{" "}
          <a href="https://horizonpulse.dev" style={{ color: "#8ec5ff" }}>
            https://horizonpulse.dev
          </a>{" "}
          to <code>0x5b32c973596078a967562ca652761404f19be0e9</code>. Ignore{" "}
          <code>horizon-pulse.vercel.app</code> and the old Safe{" "}
          <code>0xe16A1b12404cB2EbC6e783beCA6E2A9253c3dC7E</code>; they are
          stranded and abandoned.
        </p>
      </section>

      <section
        style={{
          marginTop: 32,
          padding: 20,
          borderRadius: 12,
          background: "#121a33",
          border: "1px solid #243056",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18 }}>
          Live paid catalog ({LIVE_PAID_ROUTES.length})
        </h2>
        <p style={{ fontSize: 13, opacity: 0.8, marginTop: 0 }}>
          {CATALOG_NOTE} First settle: {FIRST_SETTLE.route}{" "}
          {FIRST_SETTLE.amountUsd} — tx {FIRST_SETTLE.txTruncated}.
        </p>
        <LiveRoutesList />
      </section>

      <section
        style={{
          marginTop: 24,
          padding: 20,
          borderRadius: 12,
          background: "#121a33",
          border: "1px solid #243056",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18 }}>
          Agent how-to (x402 v2)
        </h2>
        <AgentHowTo />
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
          <strong>Network</strong>: base ({BASE_CAIP2}) ·{" "}
          <strong>Facilitator</strong>: Coinbase CDP x402
        </p>
        <p style={{ fontSize: 13, opacity: 0.75 }}>
          Free pages: <code>GET /</code> (this landing) ·{" "}
          <code>GET /status</code> (live on-chain USDC on payTo — not an old
          Safe balance).
        </p>
        <p style={{ fontSize: 13, opacity: 0.75, wordBreak: "break-all" }}>
          <strong>Host</strong>:{" "}
          <a href={PUBLIC_BASE_URL} style={{ color: "#8ec5ff" }}>
            {PUBLIC_BASE_URL}
          </a>{" "}
          (canonical) · backup{" "}
          <a href={PUBLIC_BASE_URL_BACKUP} style={{ color: "#8ec5ff" }}>
            {PUBLIC_BASE_URL_BACKUP}
          </a>
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
        Unpaid paid-routes return HTTP 402 with <code>PAYMENT-REQUIRED</code>{" "}
        until a valid x402 v2 <code>PAYMENT-SIGNATURE</code> is provided.
        Settlement uses CDP when <code>CDP_API_KEY_ID</code> /{" "}
        <code>CDP_API_KEY_SECRET</code> are set. Coming-soon routes are not
        listed.
      </p>
    </main>
  );
}
