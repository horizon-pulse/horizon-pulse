import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CONTACT_EMAIL, USDC_BASE } from "@/lib/config";
import { HONESTY_LINE, REFUND_LINES, SERVICE_FEE_ADDRESS } from "@/lib/agent-promotion";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { Reveal } from "@/components/Reveal";

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

const CASE_TIMELINE: [string, ReactNode][] = [
  ["9/20", "Earliest Bazaar entries on record (oldest lastUpdated)"],
  ["9/23", "One route committed and listed in the Bazaar the same afternoon, in our own codebase"],
  ["9/28", "x402-dev PR merged; x402 List listing created; nohumans listings added"],
  ["9/30", "13 of 13 paid routes listed in the Bazaar. gold-402 PR merged"],
  ["10/2", "All resources re-registered on x402scan"],
  ["10/7", <><code key="s">skill.md</code> and <code key="a">/agents</code> deployed</>],
];

const FAQ = [
  { q: "Do you guarantee listings or rankings?", a: <>No. Each directory decides acceptance and ranking. We don&apos;t guarantee placement, ranking, traffic or revenue.</> },
  { q: "Do I need an account on each directory?", a: <>Sometimes. {HONESTY_LINE}</> },
  { q: "Which payment?", a: <>USDC on Base, to the same address and with the same &quot;email us the transaction hash&quot; flow as <a href="/listing-fix">/listing-fix</a>. No card checkout.</> },
  { q: "Is it a call?", a: <>No. Everything is written and async.</> },
  { q: "What if my route isn't payable yet?", a: <>Full x402 setup from scratch is quoted by email: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. If your route already returns a 402, <a href="/listing-fix">fix your x402 listing</a>.</> },
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
            <div data-reveal style={{ maxWidth: 720, margin: "0 0 40px" }}>
              <h3 style={{ fontSize: 15, fontWeight: 560, letterSpacing: "-.01em", margin: "0 0 12px" }}>Why discovery comes first</h3>
              <blockquote className="hp-quote">&ldquo;An agent can compare only the endpoints it can find.&rdquo;</blockquote>
              <p style={{ margin: "8px 0 0", fontSize: 14, color: "var(--text-2)" }}>
                &mdash; Coinbase Institute, &ldquo;
                <a href="https://www.coinbase.com/public-policy/advocacy/documents/machine-to-machine-payments-in-the-aifi-era" target="_blank" rel="noopener">
                  Machine-to-machine payments in the AiFi era
                </a>
                &rdquo; (Oct 7, 2026), p. 7
              </p>
              <p style={{ margin: "12px 0 0", fontSize: 14, color: "var(--text-2)" }}>
                That&apos;s the job: making sure agents can find your paid routes and read them correctly. Quoted for context only. This is
                not an endorsement of Horizon Pulse by Coinbase.
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
                  A $49 written listing review (<a href="/listing-fix">/listing-fix</a>). The $49 review credit applies to the $99 listing fix: book the fix within 14 days of delivery and the $49 counts toward the $99.
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
                Horizon Pulse: <span>our own APIs, set up the way we set up yours</span>
              </h2>
              <p className="hp-lead" style={{ maxWidth: 720 }}>
                Horizon Pulse runs a live x402 v2 service on Base mainnet: pay-per-call APIs for AI agents, paid in USDC through
                Coinbase&apos;s CDP facilitator, with 13 paid routes. Before we offered agent promotion to anyone else, we did it for
                ourselves. This page records what we set up and when. It&apos;s a delivery reference, not a revenue claim.
              </p>
            </div>
            <div className="hp-grid two">
              <div className="hp-tile" data-reveal>
                <Ico d={I.list} />
                <h3>What we set up</h3>
                <div className="hp-kv">
                  <span className="k">Coinbase x402 Bazaar</span>
                  <span>
                    All 13 paid routes were listed by 9/30. Through the Bazaar we&apos;re picked up automatically by agentic.market and
                    402index.
                  </span>
                  <span className="k">Directories</span>
                  <span>
                    We&apos;re listed on x402scan, x402 List, the x402-dev and gold-402 GitHub directories (PRs merged), and nohumans.
                  </span>
                  <span className="k">Metadata in the 402 itself</span>
                  <span>
                    Each 402 response carries <code>serviceName</code>, tags, an icon URL and an agent-style description of 416–493
                    characters, under Coinbase&apos;s 500-character limit. <code>/.well-known/x402</code> lists our resources.
                  </span>
                  <span className="k">Agent-readable files</span>
                  <span>
                    <code>skill.md</code> and an <code>/agents</code> page went live on 10/7. An MCP server answers at <code>/mcp</code>.
                  </span>
                </div>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.doc} />
                <h3>What a good Bazaar description looks like</h3>
                <p>
                  Here&apos;s the one the Bazaar lists for our <code>/api/x402-check</code> route (477 characters):
                </p>
                <blockquote className="hp-quote">
                  x402 developer tool. Use before paying an unknown x402 endpoint, or to debug your own. GET with required url (optional method GET/POST, body JSON for POST probes). Sends one unpaid request and never pays. Returns JSON: httpStatus, isX402, x402Version, decoded accepts (network, asset label, amount in USD, payTo and whether payTo is an EOA or contract), discovery metadata presence, and pass/warn/fail checks with a summary. Private targets are blocked. Errors are not charged.
                </blockquote>
                <p>
                  The pattern: what it is, when to use it, how to call it, what comes back, and the caveats. It&apos;s written so an agent
                  can choose the route and call it correctly the first time.
                </p>
              </div>
            </div>
            <table className="hp-table" data-reveal>
              <thead>
                <tr>
                  <th className="m">Date</th>
                  <th>Milestone (2026, ET)</th>
                </tr>
              </thead>
              <tbody>
                {CASE_TIMELINE.map(([d, m]) => (
                  <tr key={d}>
                    <td className="m" style={{ display: "table-cell" }}>{d}</td>
                    <td>{m}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hp-lead" style={{ maxWidth: 720, marginTop: 24 }}>
              Listings are ongoing work. Coinbase removes Bazaar resources that go 30 days without a settlement (
              <a href="https://docs.cdp.coinbase.com/x402/seller/get-discovered" target="_blank" rel="noreferrer">Get discovered ↗</a>).
              Every directory makes its own decisions, so we can&apos;t guarantee listing, ranking or traffic.
            </p>
            <p style={{ margin: "8px 0 0", fontSize: 14, color: "var(--text-2)" }}>
              Want the same setup for your API? Start at <a href="/agent-promotion/start">/agent-promotion/start</a>.
            </p>
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
