import Link from "next/link";
import {
  DEFAULT_PAY_TO,
  GITHUB_REPO,
  USDC_BASE,
  CDP_FACILITATOR_URL,
  BASE_CAIP2,
  PUBLIC_BASE_URL,
  PUBLIC_BASE_URL_BACKUP,
} from "@/lib/config";
import { fetchTreasuryUsdcBalance } from "@/lib/treasury";
import {
  CATALOG_NOTE,
  FIRST_SETTLE,
  LIVE_PAID_ROUTES,
} from "@/lib/live-catalog";
import { LiveRoutesList } from "@/components/LiveRoutesList";
import { AgentHowTo } from "@/components/AgentHowTo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function StatusPage() {
  let balanceBlock:
    | {
        ok: true;
        balanceUsdc: string;
        balanceAtomic: string;
        payTo: string;
        fetchedAt: string;
      }
    | {
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
        Free public dashboard. Shows the <strong>live</strong> on-chain USDC
        balance of the x402 <code>payTo</code> address on Base (RPC{" "}
        <code>balanceOf</code>) — not invented metrics, not a cached figure.
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
              network: {BASE_CAIP2}
              <br />
              as of: {balanceBlock.fetchedAt} (ISO-8601 UTC from RPC read)
            </p>
          </>
        ) : (
          <>
            <p style={{ color: "#ffb4b4" }}>
              Could not load live balance (RPC error): {balanceBlock.error}
            </p>
            <p style={{ fontSize: 13, opacity: 0.75, wordBreak: "break-all" }}>
              Expected payTo: {balanceBlock.payTo}. No cached balance is shown when
              the RPC fails.
            </p>
          </>
        )}
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
        <h2 style={{ marginTop: 0, fontSize: 16 }}>payTo custody (honest)</h2>
        <p style={{ fontSize: 14, opacity: 0.9, marginTop: 0 }}>
          <code>payTo</code> is an <strong>interim Coinbase-custodial</strong>{" "}
          Base address controlled by Michael. It is <strong>not</strong> a Safe
          or multisig. A non-custodial / Safe-or-multisig upgrade is planned
          later; until then this address is the settlement destination agents
          should use.
        </p>
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
        <h2 style={{ marginTop: 0, fontSize: 16 }}>
          Live paid catalog ({LIVE_PAID_ROUTES.length})
        </h2>
        <p style={{ fontSize: 13, opacity: 0.8, marginTop: 0 }}>
          {CATALOG_NOTE} First settle: {FIRST_SETTLE.route}{" "}
          {FIRST_SETTLE.amountUsd} — tx {FIRST_SETTLE.txTruncated}.
        </p>
        <LiveRoutesList perCall />
        <p style={{ fontSize: 13, opacity: 0.75, marginBottom: 0 }}>
          Network: {BASE_CAIP2} · Facilitator: {CDP_FACILITATOR_URL}
        </p>
        <p
          style={{
            fontSize: 13,
            opacity: 0.75,
            marginBottom: 0,
            marginTop: 8,
            wordBreak: "break-all",
          }}
        >
          Host:{" "}
          <a href={PUBLIC_BASE_URL} style={{ color: "#8ec5ff" }}>
            {PUBLIC_BASE_URL}
          </a>{" "}
          (canonical) · backup{" "}
          <a href={PUBLIC_BASE_URL_BACKUP} style={{ color: "#8ec5ff" }}>
            {PUBLIC_BASE_URL_BACKUP}
          </a>
        </p>
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
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Agent how-to (x402 v2)</h2>
        <AgentHowTo />
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
