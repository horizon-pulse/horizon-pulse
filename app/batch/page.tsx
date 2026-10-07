import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_EMAIL, DEFAULT_PAY_TO, USDC_BASE } from "@/lib/config";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { Reveal } from "@/components/Reveal";

/**
 * Batch rails page. SHIPS ONLY WITH THE RAIL GO-LIVE (Odin Class A). Until then nothing here is live:
 * every batch statement is labeled "at go-live". No batch prices, deposit sizes or availability are stated.
 */
const SPEC = "https://docs.x402.org/schemes/batch-settlement";
const CDP_NETWORKS = "https://docs.cdp.coinbase.com/x402/network-support";
const PAYAI_BATCH = "https://docs.payai.network/x402/servers/batch-settlement";
const MAIL = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Batch pay")}`;

export const metadata: Metadata = {
  title: "Batch pay (coming at go-live) | Horizon Pulse",
  description:
    "Per-call x402 on Base is live today. Coming at go-live: batch pay on Base and Solana. Deposit once into a channel, pay each call with an off-chain voucher, settle in batches, and get unused balance refunded.",
};

const Ico = ({ d }: { d: string }) => (
  <svg className="hp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const I = {
  wallet: "M3 7h15a2 2 0 012 2v8a2 2 0 01-2 2H3zM3 7l12-3v3M16 13h.01",
  voucher: "M4 6h16v4a2 2 0 000 4v4H4v-4a2 2 0 000-4zM10 6v12",
  settle: "M4 12l5 5L20 6",
  refund: "M4 10h11a5 5 0 010 10H9M4 10l4-4M4 10l4 4",
  sync: "M4 4v6h6M20 20v-6h-6M5 15a7 7 0 0012 3M19 9A7 7 0 007 6",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 018 0v3",
};

const BUYER = `// Batch pay buyer, at go-live (sketch; x402 v2, @x402/evm batch-settlement client)
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";

// 1. The signer must be able to read the chain (channel balance) to recover state.
const signer = toClientEvmSigner(account, publicClient);
const batch = new BatchSettlementEvmScheme(signer, { storage /* durable */ });
const client = new x402Client().register("eip155:8453", batch);
const http = new x402HTTPClient(client);

// 2. After EVERY paid response, feed the receipt back so the next voucher is current.
await client.handlePaymentResponse({ paymentPayload, requirements, settleResponse });

// 3. On a 402 with a cumulative-amount mismatch, resync and retry once.
if (await batch.processCorrectivePaymentRequired(paymentRequired)) { /* retry */ }`;

export default function BatchPage() {
  return (
    <div className="hp">
      <SiteHeader />
      <Reveal />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">Coming at go-live</span>
            <h1>
              Pay per call today.
              <br />
              <span>Batch pay is coming.</span>
            </h1>
            <p className="hp-sub">
              Every route takes a per-call x402 payment in USDC on Base today, and that stays the default. At go-live, routes that agents
              poll often will also accept <strong>batch pay</strong>: deposit once, pay each call with an off-chain voucher, and we settle
              in batches. Nothing on this page is live yet.
            </p>
            <div className="hp-ctas">
              <Link className="hp-btn primary" href="/docs#quickstart">Pay per call now</Link>
              <a className="hp-btn ghost" href="#how">How batch pay works</a>
            </div>
            <p className="hp-proof">
              <a href={SPEC} target="_blank" rel="noreferrer">x402 batch-settlement spec ↗</a>
              <span>·</span>
              <a href={CDP_NETWORKS} target="_blank" rel="noreferrer">Coinbase network support ↗</a>
            </p>
          </div>
        </section>

        <section className="hp-section" id="networks">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Supported networks</div>
              <h2>
                Base per-call first. <span>Batch next to it.</span>
              </h2>
              <p className="hp-lead">
                Every 402 lists per-call on Base first. Batch options, once live, are listed after it, so existing clients keep working
                unchanged and pick per-call by default.
              </p>
            </div>
            <table className="hp-table" data-reveal>
              <thead>
                <tr><th>Option</th><th>Network</th><th>Scheme</th><th>Facilitator</th><th className="p">Status</th></tr>
              </thead>
              <tbody>
                <tr><td className="r">1 · Per-call</td><td>Base <code>eip155:8453</code></td><td className="m">exact</td><td>Coinbase CDP</td><td className="p">Live</td></tr>
                <tr><td className="r">2 · Batch</td><td>Base <code>eip155:8453</code></td><td className="m">batch-settlement</td><td>Coinbase CDP</td><td className="p">At go-live</td></tr>
                <tr><td className="r">3 · Batch</td><td>Solana mainnet</td><td className="m">batch-settlement</td><td>PayAI</td><td className="p">At go-live</td></tr>
              </tbody>
            </table>
            <p className="hp-fine" style={{ marginTop: 16 }}>
              Bazaar discovery and our refund rules run on the Coinbase CDP side. Solana batch uses PayAI&apos;s facilitator, which
              runs it as a{" "}
              <a href={PAYAI_BATCH} target="_blank" rel="noreferrer">public preview ↗</a> with its own channel limits.
            </p>
          </div>
        </section>

        <section className="hp-section" id="how">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">How batch pay works</div>
              <h2>
                Deposit once. <span>Pay every call off-chain.</span>
              </h2>
              <p className="hp-lead">
                Batch pay is the x402 <code>batch-settlement</code> scheme. Instead of one on-chain payment per call, you fund a payment
                channel once and sign a cumulative voucher for each call.
              </p>
            </div>
            <div className="hp-grid">
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">01</span>
                <Ico d={I.wallet} />
                <h3>Deposit into a channel</h3>
                <p>Your first batch call opens a channel with a USDC deposit held in escrow on-chain. Your client chooses the deposit size.</p>
              </div>
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">02</span>
                <Ico d={I.voucher} />
                <h3>Off-chain vouchers</h3>
                <p>Each call carries a signed voucher for the new running total. We check it on the spot, so calls don&apos;t wait for a block.</p>
              </div>
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">03</span>
                <Ico d={I.settle} />
                <h3>We settle in batches</h3>
                <p>We claim the vouchers and settle them on-chain in batches. Only what you were charged moves out of the channel.</p>
              </div>
            </div>
            <div className="hp-grid two" style={{ marginTop: 1 }}>
              <div className="hp-tile" data-reveal>
                <Ico d={I.refund} />
                <h3>Unused balance comes back</h3>
                <p>
                  Whatever you deposited and didn&apos;t spend is refunded to you from the channel. Idle channels are refunded, and you can
                  also start a withdrawal yourself; it completes after the channel&apos;s withdrawal delay.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.eye} />
                <h3>Every charge is checkable</h3>
                <p>
                  Each paid response returns the charged amount and the channel&apos;s running total in <code>PAYMENT-RESPONSE</code>.
                  Deposits, claims, settles and refunds are ordinary on-chain transactions.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="buyer">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Buyer requirements</div>
              <h2>
                Three things your client <span>must do.</span>
              </h2>
              <p className="hp-lead">We found these in a Base Sepolia test run. Skip one and your next voucher is rejected with a 402.</p>
            </div>
            <div className="hp-grid">
              <div className="hp-tile" data-reveal>
                <Ico d={I.sync} />
                <h3>Feed every receipt back</h3>
                <p>
                  Pass each paid response to your client (<code>handlePaymentResponse</code>). If you don&apos;t, the next voucher has a
                  stale total and is rejected as <code>cumulative_amount_mismatch</code>.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.eye} />
                <h3>Use a signer that reads the chain</h3>
                <p>
                  Recovering channel state reads the channel balance on-chain. On EVM, wrap your account with{" "}
                  <code>toClientEvmSigner(account, publicClient)</code>.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.lock} />
                <h3>Keep channel state durable</h3>
                <p>
                  Store channel records somewhere that survives restarts, and treat the channel authorization like a secret. On a
                  corrective 402, resync once and retry.
                </p>
              </div>
            </div>
            <div style={{ marginTop: 16 }} data-reveal>
              <div className="hp-code tall">
                <div className="hp-code-h"><span>Buyer sketch (at go-live)</span></div>
                <pre>{BUYER}</pre>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="pricing">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Pricing</div>
              <h2>
                Per-call prices are live. <span>Batch prices come at go-live.</span>
              </h2>
              <p className="hp-lead">
                Today&apos;s per-call prices are in the <Link href="/docs">docs</Link>, the 402 challenge and{" "}
                <a href="/.well-known/x402">.well-known/x402</a>. We&apos;ll publish batch prices, the routes that take batch pay and the
                channel terms on the day batch goes live, in the same three places. Until then the 402 offers per-call only.
              </p>
            </div>
            <div className="hp-grid two">
              <div className="hp-tile" data-reveal>
                <Ico d={I.wallet} />
                <h3>Per-call on Base</h3>
                <div className="hp-kv">
                  <span className="k">Status</span><span>Live</span>
                  <span className="k">Asset</span><span>USDC on Base <code>{USDC_BASE}</code></span>
                  <span className="k">Pay to</span><code style={{ wordBreak: "break-all" }}>{DEFAULT_PAY_TO}</code>
                </div>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.voucher} />
                <h3>Batch on Base and Solana</h3>
                <div className="hp-kv">
                  <span className="k">Status</span><span>Coming at go-live</span>
                  <span className="k">Prices</span><span>Published at go-live</span>
                  <span className="k">Pay to</span><span>Published at go-live, in every 402</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-cta-band" data-reveal>
          <h2>Polling a route all day?</h2>
          <p>Per-call works now. Tell us which route you call most and we&apos;ll let you know when batch pay goes live.</p>
          <div className="hp-ctas">
            <Link className="hp-btn primary" href="/docs#quickstart">Pay per call now</Link>
            <a className="hp-btn ghost" href={MAIL}>Get notified</a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
