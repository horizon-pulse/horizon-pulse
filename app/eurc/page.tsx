import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_EMAIL, USDC_BASE } from "@/lib/config";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { Reveal } from "@/components/Reveal";
import { EURC_BASE_MAINNET } from "@/lib/eurc-spike";

/**
 * Pay in EURC: buyer docs. NOT LIVE. Ships only after Odin Class A and Michael's final OK
 * (and a working CDP test key for the CDP-facilitated check). Every EURC statement says "planned".
 */
const MAIL = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Pay in EURC")}`;

export const metadata: Metadata = {
  title: "Pay in EURC (planned) | Horizon Pulse",
  description: "Planned: pay Horizon Pulse routes in EURC on Base at a fixed EUR 0.01 per call, next to USDC. Not live yet.",
};

const Ico = ({ d }: { d: string }) => (
  <svg className="hp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const I = {
  coin: "M12 3a9 9 0 100 18 9 9 0 000-18zM15 9.5a3.5 3.5 0 100 5M8 11h5M8 13h5",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
};

const SNIPPET = `// Pay in EURC (planned; x402 v2). Your client must opt in to EURC.
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const EURC = "${EURC_BASE_MAINNET}"; // EURC on Base

const client = x402Client.fromConfig({
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
  spendControls: {
    // Without this entry the client only pays in default assets (USDC)
    // and rejects the EURC option.
    allowedAssets: [{ network: "eip155:8453", asset: EURC, maxAmountPerPayment: "10000" }],
  },
});
const http = new x402HTTPClient(client);
// Then the usual flow: call, read PAYMENT-REQUIRED, createPaymentPayload, retry with PAYMENT-SIGNATURE.`;

export default function EurcPage() {
  return (
    <div className="hp">
      <SiteHeader />
      <Reveal />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">Planned, not live</span>
            <h1>
              Pay in USDC today.
              <br />
              <span>EURC is planned.</span>
            </h1>
            <p className="hp-sub">
              Every route takes USDC on Base today, and USDC stays the first option. We plan to add <strong>EURC</strong>, Circle&apos;s euro
              stablecoin on Base, as a second option at a fixed <strong>€0.01 per call</strong>. It isn&apos;t live yet, so a 402 from us
              won&apos;t list EURC until it is.
            </p>
            <div className="hp-ctas">
              <Link className="hp-btn primary" href="/docs#quickstart">Pay in USDC now</Link>
              <a className="hp-btn ghost" href="#how">How EURC will work</a>
            </div>
          </div>
        </section>

        <section className="hp-section" id="how">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">How it will work</div>
              <h2>
                Same x402 flow. <span>A second asset.</span>
              </h2>
              <p className="hp-lead">
                EURC uses the same x402 <code>exact</code> payment as USDC: a signed EIP-3009 authorization that the facilitator settles
                after the route succeeds. Only the asset and the price differ.
              </p>
            </div>
            <div className="hp-grid">
              <div className="hp-tile" data-reveal>
                <Ico d={I.list} />
                <h3>USDC first</h3>
                <p>The 402 lists USDC first and EURC after it. Clients that don&apos;t opt in to EURC keep paying in USDC as they do now.</p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.coin} />
                <h3>Fixed €0.01 per call</h3>
                <p>EURC is priced in euros, not converted from the USD price: <code>10000</code> atomic EURC (6 decimals) per call.</p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.shield} />
                <h3>You opt in</h3>
                <p>x402 clients only pay in default assets unless you allow more. Add EURC to <code>spendControls.allowedAssets</code> with a cap.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="buyer">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Buyer setup</div>
              <h2>
                Opt in to EURC <span>with a cap.</span>
              </h2>
              <p className="hp-lead">
                If you leave out the opt-in, your client rejects the EURC option with <code>rejected by spendControls</code> and pays in
                USDC if it can.
              </p>
            </div>
            <div style={{ marginTop: 36 }} data-reveal>
              <div className="hp-code tall">
                <div className="hp-code-h"><span>EURC buyer (planned)</span></div>
                <pre>{SNIPPET}</pre>
              </div>
            </div>
            <div className="hp-grid two" style={{ marginTop: 16 }}>
              <div className="hp-tile" data-reveal>
                <h3>EURC</h3>
                <div className="hp-kv">
                  <span className="k">Status</span><span>Planned, not live</span>
                  <span className="k">Network</span><span>Base <code>eip155:8453</code></span>
                  <span className="k">Asset</span><code style={{ wordBreak: "break-all" }}>{EURC_BASE_MAINNET}</code>
                  <span className="k">Price</span><span>€0.01 per call (<code>10000</code> atomic)</span>
                </div>
              </div>
              <div className="hp-tile" data-reveal>
                <h3>USDC</h3>
                <div className="hp-kv">
                  <span className="k">Status</span><span>Live</span>
                  <span className="k">Network</span><span>Base <code>eip155:8453</code></span>
                  <span className="k">Asset</span><code style={{ wordBreak: "break-all" }}>{USDC_BASE}</code>
                  <span className="k">Price</span><span>Per route, see the <Link href="/docs">docs</Link></span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-cta-band" data-reveal>
          <h2>Want to pay in euros?</h2>
          <p>USDC works now. Tell us which routes you&apos;d pay for in EURC and we&apos;ll let you know when it goes live.</p>
          <div className="hp-ctas">
            <Link className="hp-btn primary" href="/docs#quickstart">Pay in USDC now</Link>
            <a className="hp-btn ghost" href={MAIL}>Get notified</a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
