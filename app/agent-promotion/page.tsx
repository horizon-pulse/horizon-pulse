import type { Metadata } from "next";
import { CONTACT_EMAIL, DEFAULT_PAY_TO, USDC_BASE } from "@/lib/config";
import { HONESTY_LINE, REFUND_LINES, SERVICE_FEE_ADDRESS } from "@/lib/agent-promotion";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { Reveal } from "@/components/Reveal";

const BAZAAR_LOOKUP = `https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=${DEFAULT_PAY_TO.toLowerCase()}`;

export const metadata: Metadata = {
  title: "Agent promotion | Horizon Pulse",
  description:
    "Get your API found and used by AI agents: a description pack (llms.txt, skill.md, OpenAPI summary, Coinbase Bazaar description), directory submissions or ready-to-submit packs, and a monthly agent-traffic report. Intro prices, paid in USDC on Base.",
};

const Ico = ({ d }: { d: string }) => (
  <svg className="hp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const I = {
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4",
  doc: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h5",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  chart: "M4 20V10M10 20V4M16 20v-8M22 20H2",
  wallet: "M3 7h15a2 2 0 012 2v8a2 2 0 01-2 2H3zM3 7l12-3v3M16 13h.01",
  refund: "M4 10h11a5 5 0 010 10H9M4 10l4-4M4 10l4 4",
  quote: "M7 7h4v4H7zM13 7h4v4h-4zM7 11c0 3-1 5-3 6M13 11c0 3-1 5-3 6",
};

const FAQ = [
  { q: "Do you guarantee listings or rankings?", a: <>No. Each directory decides acceptance and ranking. We don&apos;t guarantee placement, ranking, traffic or revenue.</> },
  { q: "Do I need an account on each directory?", a: <>Sometimes. {HONESTY_LINE}</> },
  { q: "Which payment?", a: <>USDC on Base, to the same address and with the same &quot;email us the transaction hash&quot; flow as <a href="/listing-fix">/listing-fix</a>. No card checkout.</> },
  { q: "Is it a call?", a: <>No. Everything is written and async, by email or in your thread.</> },
  { q: "What if my route isn't payable yet?", a: <>Start with <a href="/listing-fix">/listing-fix</a>.</> },
  { q: "What's in the monthly report?", a: <>Directory status, calls and payers we can observe on-chain or through Bazaar data, and changes we made.</> },
];

export default function AgentPromotionPage() {
  return (
    <div className="hp">
      <SiteHeader />
      <Reveal />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">Agent promotion</span>
            <h1>
              Get your API found
              <br />
              <span>and used by AI agents.</span>
            </h1>
            <p className="hp-sub">
              We write the files agents read, submit or prepare your directory listings, and with monitoring, report monthly. Start with a{" "}
              <strong>$49 written review</strong>; setup is <strong>$149 per host</strong>, monitoring <strong>$49/month</strong>.
              Intro prices.
            </p>
            <div className="hp-ctas">
              <a className="hp-btn primary" href="/agent-promotion/start">Start the intake</a>
              <a className="hp-btn ghost" href="/agent-promotion/spec">See what&apos;s delivered</a>
            </div>
            <p className="hp-proof">
              <a href="#pricing">Pricing</a>
              <span>·</span>
              <a href="#terms">Payment and refunds</a>
              <span>·</span>
              <a href="#faq">FAQ</a>
            </p>
          </div>
        </section>

        <section className="hp-section" id="how">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">How it works</div>
              <h2>
                Review. Setup. Listings. <span>Monthly report.</span>
              </h2>
              <p className="hp-lead">
                Everything is written and async, by email or in your thread. You keep full control of your code, keys and wallet.
              </p>
            </div>
            <div className="hp-grid four">
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">01</span>
                <Ico d={I.search} />
                <h3>Review</h3>
                <p>
                  Start with a <a href="/listing-fix">$49 written listing review</a> of your host, delivered by email or in your thread.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">02</span>
                <Ico d={I.doc} />
                <h3>Setup</h3>
                <p>
                  The description pack (llms.txt, skill.md, an OpenAPI summary and a Coinbase Bazaar description) and the Bazaar listing
                  work for your existing routes.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">03</span>
                <Ico d={I.list} />
                <h3>Listings</h3>
                <p>
                  Directory submissions where a directory allows third-party submissions, and ready-to-submit packs where it needs your
                  own account.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">04</span>
                <Ico d={I.chart} />
                <h3>Monthly report</h3>
                <p>With monitoring: listing checks, re-optimization and a monthly agent-traffic report.</p>
              </div>
            </div>
            <p className="hp-proof" style={{ marginTop: 20 }}>
              <a href="/agent-promotion/spec">Full delivery spec →</a>
            </p>
          </div>
        </section>

        <section className="hp-section" id="pricing">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Pricing</div>
              <h2>
                Intro prices. <span>Paid in USDC on Base.</span>
              </h2>
              <p className="hp-lead">These are intro prices for a new service and may change.</p>
            </div>
            <div className="hp-grid four">
              <div className="hp-tile" data-reveal>
                <Ico d={I.search} />
                <h3>Start with a review</h3>
                <p>
                  A $49 written listing review (<a href="/listing-fix">/listing-fix</a>), credited as on that page.
                </p>
                <div className="hp-tile-foot"><b>$49</b><a href="/listing-fix">Details →</a></div>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.doc} />
                <h3>Setup</h3>
                <p>
                  One-time, per host. The description pack, the Bazaar listing work for your existing routes (covers what the $99 fix
                  covers), directory submissions or ready-to-submit packs, and a listing report.
                </p>
                <div className="hp-tile-foot"><b>$149 per host</b><a href="/agent-promotion/start">Start →</a></div>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.chart} />
                <h3>Monitoring</h3>
                <p>
                  Listing checks, re-optimization and a monthly agent-traffic report. Cancel anytime; paid upfront each month.
                </p>
                <div className="hp-tile-foot"><b>$49/month</b></div>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.quote} />
                <h3>More than 25 paid routes</h3>
                <p>We quote first, before any work starts.</p>
                <div className="hp-tile-foot"><b>Quote</b><a href="/agent-promotion/start">Ask →</a></div>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="terms">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Terms</div>
              <h2>
                Clear terms. <span>A written refund rule.</span>
              </h2>
              <p className="hp-lead">
                Directories decide their own listings, so we can&apos;t promise placement or ranking. That&apos;s why the refund rule is
                written down here.
              </p>
            </div>
            <div className="hp-grid two">
              <div className="hp-tile" data-reveal>
                <Ico d={I.wallet} />
                <h3>Payment</h3>
                <div className="hp-kv">
                  <span className="k">Price</span>
                  <span>$49 written review, $149 setup per host (one-time), $49/month monitoring. Intro prices. More than 25 paid routes: we quote first.</span>
                  <span className="k">Asset</span>
                  <span>USDC on Base <code>{USDC_BASE}</code></span>
                  <span className="k">Pay to</span>
                  <code>{SERVICE_FEE_ADDRESS}</code>
                  <span className="k">How</span>
                  <span>
                    Same wallet and flow as <a href="/listing-fix">/listing-fix</a>: pay from a wallet you control, not straight from an
                    exchange, then email us the transaction hash at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. Monitoring is
                    paid upfront each month. No card checkout.
                  </span>
                </div>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.refund} />
                <h3>Refunds</h3>
                <div className="hp-kv">
                  {REFUND_LINES.map((l) => [
                    <span className="k" key={`${l.k}-k`}>{l.k}</span>,
                    <span key={`${l.k}-v`}>{l.v}</span>,
                  ])}
                  <span className="k">Review</span>
                  <span>
                    The $49 review follows the <a href="/listing-fix#terms">/listing-fix terms</a>.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="faq">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">FAQ</div>
              <h2>
                Questions. <span>Straight answers.</span>
              </h2>
            </div>
            <div className="hp-grid two">
              {FAQ.map((f) => (
                <div className="hp-tile" key={f.q} data-reveal>
                  <h3>{f.q}</h3>
                  <p>{f.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="hp-section" id="case-study">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Case study</div>
              <h2>
                Case study: Horizon Pulse <span>(coming soon)</span>
              </h2>
              <p className="hp-lead">
                Horizon Pulse is our own pay-per-call API.{" "}
                <a href={BAZAAR_LOOKUP} target="_blank" rel="noreferrer">See our routes in Coinbase&apos;s x402 Bazaar ↗</a>
              </p>
            </div>
          </div>
        </section>

        <section className="hp-cta-band" data-reveal>
          <h2>Get your API found by agents.</h2>
          <p>The intake is a prefilled email. The site stores nothing.</p>
          <div className="hp-ctas">
            <a className="hp-btn primary" href="/agent-promotion/start">Start the intake</a>
            <a className="hp-btn ghost" href="/listing-fix">Start with a $49 written review</a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
