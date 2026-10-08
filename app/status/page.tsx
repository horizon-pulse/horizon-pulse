import type { Metadata } from "next";
import { DEFAULT_PAY_TO, USDC_BASE, CDP_FACILITATOR_URL, BASE_CAIP2, PUBLIC_BASE_URL } from "@/lib/config";
import { fetchTreasuryUsdcBalance } from "@/lib/treasury";
import { PAYAI_FACILITATOR_URL, SOLANA_PAYTO, USDC_SOLANA_MINT } from "@/lib/solana-config";
import { catalogStats, routeName, LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import { DEMO_ROUTES } from "@/lib/demo-catalog";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status | Horizon Pulse",
  description: "Live on-chain USDC balance of the Horizon Pulse payTo on Base, the paid route catalog, and where to pay on Base and Solana.",
};

const OLD_HOST = "horizon-pulse.vercel.app";
const OLD_SAFE = "0xe16A1b12404cB2EbC6e783beCA6E2A9253c3dC7E";
const BAZAAR_LOOKUP = `https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=${DEFAULT_PAY_TO.toLowerCase()}`;
const demoSet = new Set(DEMO_ROUTES.map((d) => d.route));

const Ico = ({ d }: { d: string }) => (
  <svg className="hp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const I = {
  wallet: "M3 7h15a2 2 0 012 2v8a2 2 0 01-2 2H3zM3 7l12-3v3M16 13h.01",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  warn: "M12 3l9 16H3zM12 10v4M12 17h.01",
};

function fmtUtc(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export default async function StatusPage() {
  const s = catalogStats();
  let bal: { ok: true; usdc: string; atomic: string; at: string } | { ok: false; error: string };
  try {
    const b = await fetchTreasuryUsdcBalance();
    bal = { ok: true, usdc: b.balanceUsdc, atomic: b.balanceAtomic, at: b.fetchedAt };
  } catch (err) {
    bal = { ok: false, error: err instanceof Error ? err.message : "balance read failed" };
  }
  const usdc = bal.ok ? Number(bal.usdc).toLocaleString("en-US", { maximumFractionDigits: 6 }) : "Unavailable";

  return (
    <div className="hp">
      <SiteHeader />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">Status</span>
            <h1>
              Live status.
              <br />
              <span>Read from the chain.</span>
            </h1>
            <p className="hp-sub">
              The Base payTo balance below is a live <code>balanceOf</code> read on Base each time this page loads. Nothing is cached or estimated.
            </p>
            <p className="hp-proof">
              <a href={`https://basescan.org/address/${DEFAULT_PAY_TO}`} target="_blank" rel="noreferrer">Base payTo on Basescan ↗</a>
              <span>·</span>
              <a href={`https://solscan.io/account/${SOLANA_PAYTO}`} target="_blank" rel="noreferrer">Solana payTo on Solscan ↗</a>
              <span>·</span>
              <a href={BAZAAR_LOOKUP} target="_blank" rel="noreferrer">Coinbase Bazaar merchant lookup ↗</a>
            </p>
            <div className="hp-stats">
              <div className="hp-stat">
                <div className="k">Base payTo balance</div>
                <div className="v">{usdc}{bal.ok && <span style={{ fontSize: 14, color: "var(--text-2)" }}> USDC</span>}</div>
                <div className="d">{bal.ok ? `Read ${fmtUtc(bal.at)}` : "RPC read failed. No cached figure is shown."}</div>
                <div className="d">Not revenue. Can include the operator&apos;s own test payments.</div>
              </div>
              <div className="hp-stat">
                <div className="k">Paid routes</div>
                <div className="v">{s.routes}</div>
                <div className="d">{s.endpoints} endpoints in /.well-known/x402</div>
              </div>
              <div className="hp-stat">
                <div className="k">Price per call</div>
                <div className="v">{s.minPrice}–{s.maxPrice}</div>
                <div className="d">USDC, exact amount in the 402</div>
              </div>
              <div className="hp-stat">
                <div className="k">Networks</div>
                <div className="v">Base + Solana</div>
                <div className="d"><code>{BASE_CAIP2}</code> · Solana mainnet</div>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="pay">
          <div className="hp-wrap">
            <div>
              <div className="hp-label">Payments</div>
              <h2>
                One address per network. <span>One host.</span>
              </h2>
              <p className="hp-lead">
                Agents should only pay through {PUBLIC_BASE_URL.replace("https://", "")}, to the payTo below for the network they pay on. Same price on Base and
                Solana.
              </p>
            </div>
            <div className="hp-grid two">
              <div className="hp-tile">
                <Ico d={I.wallet} />
                <h3>Where to pay</h3>
                <div className="hp-kv">
                  <span className="k">Base payTo</span>
                  <code>{DEFAULT_PAY_TO}</code>
                  <span className="k">Base asset</span>
                  <span>USDC <code>{USDC_BASE}</code></span>
                  <span className="k">Base facilitator</span>
                  <span>Coinbase CDP <code>{CDP_FACILITATOR_URL}</code></span>
                  {bal.ok && (
                    <>
                      <span className="k">Base atomic</span>
                      <span><code>{bal.atomic}</code></span>
                    </>
                  )}
                  <span className="k">Solana payTo</span>
                  <code>{SOLANA_PAYTO}</code>
                  <span className="k">Solana asset</span>
                  <span>USDC <code>{USDC_SOLANA_MINT}</code></span>
                  <span className="k">Solana facilitator</span>
                  <span>PayAI <code>{PAYAI_FACILITATOR_URL}</code></span>
                </div>
              </div>
              <div className="hp-tile">
                <Ico d={I.shield} />
                <h3>Custody</h3>
                <p>
                  The Base payTo is an interim Coinbase-custodial address, controlled by the operator. The Solana payTo is a separate
                  operator-controlled address; payments credit its USDC token account. Neither is a Safe or multisig. A non-custodial upgrade
                  is planned for Base. These two are the only settlement addresses for API calls.
                </p>
              </div>
            </div>
            <div className="hp-grid" style={{ gridTemplateColumns: "1fr", marginTop: 1 }}>
              <div className="hp-tile">
                <Ico d={I.warn} />
                <h3>Old host and wallet: do not use</h3>
                <p>
                  <code>{OLD_HOST}</code> and the old Safe <code style={{ wordBreak: "break-all" }}>{OLD_SAFE}</code> are no longer used. Don&apos;t
                  send payments there.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="routes">
          <div className="hp-wrap">
            <div>
              <div className="hp-label">Catalog</div>
              <h2>
                Live paid routes. <span>Nothing else listed.</span>
              </h2>
              <p className="hp-lead">Every route below is live and returns a 402 until paid. Exact prices are also in each 402 challenge.</p>
            </div>
            <table className="hp-table">
              <thead>
                <tr>
                  <th>Route</th>
                  <th className="m">Method</th>
                  <th className="b">Returns</th>
                  <th className="p">Per call</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.byCategory.map((g) => [
                  <tr className="grp" key={g.category}>
                    <td colSpan={5}>{g.label}</td>
                  </tr>,
                  ...g.routes.map((r) => {
                    const name = routeName(r);
                    return (
                      <tr key={r.path}>
                        <td className="r">{`/api/${name}`}</td>
                        <td className="m">{r.method === "GET|POST" ? "GET · POST" : "GET"}</td>
                        <td className="b">{r.docBlurb ?? r.blurb}</td>
                        <td className="p">{r.priceUsd}</td>
                        <td className="s">{demoSet.has(name) && <a href={`/try#${name}`}>Sample →</a>}</td>
                      </tr>
                    );
                  }),
                ])}
              </tbody>
            </table>
            <p className="hp-fine">{LIVE_PAID_ROUTES.length} routes from the live catalog. How agents pay is on the <a href="/#how">homepage</a>.</p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
