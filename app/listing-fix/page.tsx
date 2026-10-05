import type { Metadata } from "next";
import { CONTACT_EMAIL, DEFAULT_PAY_TO, USDC_BASE } from "@/lib/config";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { Reveal } from "@/components/Reveal";

/** Listing-fix fees go to the owner's Ledger, not the API payTo. Never counted as API revenue. */
const FEE_ADDRESS = "0x330055d2b9B509079992Bb5712f1C9DcE32eb547";
const MAIL = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Listing consult")}`;
const MAIL_FIX = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Listing fix")}`;
const TROUBLESHOOT = "https://docs.cdp.coinbase.com/x402/support/troubleshooting#my-endpoint-is-missing-from-the-bazaar";
const VALIDATOR_DOCS = "https://docs.cdp.coinbase.com/x402/bazaar";
const BAZAAR_LOOKUP = `https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=${DEFAULT_PAY_TO.toLowerCase()}`;

export const metadata: Metadata = {
  title: "Bazaar listing fix | Horizon Pulse",
  description:
    "Your x402 endpoint passes Coinbase's validator but isn't in the x402 Bazaar? A $49 listing consult, or a $99 per host hands-on fix covering every route on the host, including a supervised trigger settle per route, with a written refund rule.",
};

const Ico = ({ d }: { d: string }) => (
  <svg className="hp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const I = {
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4",
  wrench: "M14 6a4 4 0 005 5l-8 8a2 2 0 01-3-3l8-8a4 4 0 01-2-2zM15 5l4 4",
  check: "M5 12l4 4 10-10",
  scheme: "M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16",
  json: "M8 4c-2 0-3 1-3 3v2c0 1-1 3-2 3 1 0 2 2 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1 1 3 2 3-1 0-2 2-2 3v2c0 2-1 3-3 3",
  settle: "M3 7h15a2 2 0 012 2v8a2 2 0 01-2 2H3zM3 7l12-3v3M16 13h.01",
  wallet: "M3 7h15a2 2 0 012 2v8a2 2 0 01-2 2H3zM3 7l12-3v3M16 13h.01",
  refund: "M4 10h11a5 5 0 010 10H9M4 10l4-4M4 10l4 4",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 018 0v3",
};

export default function ListingFixPage() {
  return (
    <div className="hp">
      <SiteHeader />
      <Reveal />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">Bazaar listing fix</span>
            <h1>
              Your 402 works.
              <br />
              <span>Agents still can&apos;t find it.</span>
            </h1>
            <p className="hp-sub">
              If your x402 endpoint passes Coinbase&apos;s validator but still isn&apos;t in the Bazaar, the blocker is usually specific
              and checkable from outside. Book a <strong>$49 consult</strong> to find it, or have us fix it with you for{" "}
              <strong>$99 per host</strong>.
            </p>
            <div className="hp-ctas">
              <a className="hp-btn primary" href={MAIL}>Book a $49 consult</a>
              <a className="hp-btn ghost" href="#terms">See terms and refunds</a>
            </div>
            <p className="hp-proof">
              <a href={BAZAAR_LOOKUP} target="_blank" rel="noreferrer">Our own routes in Coinbase&apos;s Bazaar ↗</a>
              <span>·</span>
              <a href={TROUBLESHOOT} target="_blank" rel="noreferrer">Coinbase&apos;s troubleshooting guide ↗</a>
            </p>
          </div>
        </section>

        <section className="hp-section" id="blockers">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">What we usually find</div>
              <h2>
                Validator passes. <span>Still not listed.</span>
              </h2>
              <p className="hp-lead">
                Coinbase only lists routes that pass its validator and have settled a payment through the CDP Facilitator. A{" "}
                <code>valid: true</code> result doesn&apos;t rule out the cases below. They are the ones we check first.
              </p>
            </div>
            <div className="hp-grid">
              <div className="hp-tile" data-reveal>
                <Ico d={I.json} />
                <h3>External schema references</h3>
                <p>
                  The schema in <code>extensions.bazaar</code> uses an external <code>$ref</code> or <code>$id</code>. CDP rejects it at
                  indexing, but the public validator may not flag it. The fix is a fully inlined schema.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.search} />
                <h3>Probe gets a non-402</h3>
                <p>
                  The indexer calls your resource with the declared <code>extensions.bazaar.info.input</code>, so that call must return
                  402 with <code>PAYMENT-REQUIRED</code>. Any other status blocks indexing; in reported cases it was a 400 or 409 from
                  validation middleware running ahead of x402.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.settle} />
                <h3>Resource missing from the settle</h3>
                <p>
                  The settle payload has no <code>paymentPayload.resource</code>. Coinbase&apos;s docs say a settle needs both{" "}
                  <code>paymentPayload.resource</code> and <code>extensions.bazaar</code> to index. See{" "}
                  <a href={TROUBLESHOOT} target="_blank" rel="noreferrer">Coinbase&apos;s troubleshooting guide ↗</a>.
                </p>
              </div>
            </div>
            <div className="hp-grid" style={{ marginTop: 1 }}>
              <div className="hp-tile" data-reveal>
                <Ico d={I.scheme} />
                <h3>Resource URL scheme</h3>
                <p>
                  The 402 advertises an <code>http://</code> resource behind an HTTPS proxy, and the validator rejects it. The resource
                  has to be <code>https://</code>.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.json} />
                <h3>Bazaar metadata shape</h3>
                <p>The discovery extension is present but missing required fields, so the validator returns <code>valid: false</code>.</p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.wallet} />
                <h3>Settle timing</h3>
                <p>
                  <code>valid: true</code> doesn&apos;t index a route on its own. Indexing needs a settle through the CDP Facilitator made
                  after the metadata is final.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="how">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">How it works</div>
              <h2>
                A $49 consult. <span>A $99 fix.</span>
              </h2>
              <p className="hp-lead">
                Intro rates, paid in USDC on Base. The $99 is per host and covers every route on the host; hosts with more than 25 paid
                routes get a quote before work starts. Book the fix within 14 days of the consult call and the $49 counts toward the $99. You keep
                full control of your code, keys and wallet the whole time.
              </p>
            </div>
            <div className="hp-grid">
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">01</span>
                <Ico d={I.search} />
                <h3>Listing consult</h3>
                <p>
                  A 30-minute call. We go through as many of your host&apos;s routes as fit in the call, show what&apos;s blocking each one using Coinbase&apos;s
                  public checks, and name the exact changes to make. You make them in your own code.
                </p>
                <div className="hp-tile-foot"><b>$49</b><a href={MAIL}>Book →</a></div>
              </div>
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">02</span>
                <Ico d={I.wrench} />
                <h3>Hands-on fix</h3>
                <p>
                  The specific change for your stack, worked through with you until the validator returns <code>valid: true</code> and
                  the checks above are clear.
                </p>
                <div className="hp-tile-foot"><b>$99 per host</b><a href={MAIL_FIX}>Start →</a></div>
              </div>
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">03</span>
                <Ico d={I.check} />
                <h3>Supervised trigger settle</h3>
                <p>
                  Once the fix is live, we walk you through one CDP-facilitated settle per route you want listed, from your own wallet: a
                  mainnet settle at your route&apos;s own price, paid from your wallet to your own payTo. Those settles are yours. We
                  never hold your keys. Then we re-run the validator and CDP discovery and send you the results.
                </p>
                <div className="hp-tile-foot"><b>Included in the $99</b></div>
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
                Indexing is done by Coinbase, not us, so we can&apos;t promise a listing or a timeline. That&apos;s why the refund rule is
                written down here.
              </p>
            </div>
            <div className="hp-grid two">
              <div className="hp-tile" data-reveal>
                <Ico d={I.wallet} />
                <h3>Payment</h3>
                <div className="hp-kv">
                  <span className="k">Price</span>
                  <span>
                    $49 for a 30-minute listing consult. $99 per host for the fix, intro rate, covering every route on the host; hosts with more
                    than 25 paid routes get a quote before work starts. Book the fix within 14 days of the consult call and the $49 counts toward the $99.
                  </span>
                  <span className="k">What&apos;s free</span>
                  <span>
                    Only our first note, if we reached out to you about your host: one outside pass that names the check we saw failing. One per
                    host, and not a walkthrough. Walkthroughs, listing checks and follow-up advice are the $49 consult or the $99 fix.
                  </span>
                  <span className="k">Asset</span>
                  <span>USDC on Base <code>{USDC_BASE}</code></span>
                  <span className="k">Pay to</span>
                  <code>{FEE_ADDRESS}</code>
                  <span className="k">How</span>
                  <span>
                    Pay from a wallet you control, not straight from an exchange, then email us the transaction hash. Consults are paid before
                    the call.
                  </span>
                </div>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.refund} />
                <h3>Refunds</h3>
                <div className="hp-kv">
                  <span className="k">(a) Full refund if</span>
                  <span>
                    CDP&apos;s validator still returns <code>valid: false</code> on the fixed routes 7 days after we deliver the fix.
                  </span>
                  <span className="k">(b) Or if</span>
                  <span>
                    The validator passes, you do your own paid settle through the CDP Facilitator within 14 days of delivery, and the
                    route still isn&apos;t in CDP discovery 7 days after that settle.
                  </span>
                  <span className="k">No refund if</span>
                  <span>The fix isn&apos;t applied, no CDP settle is done, or settles go through another facilitator.</span>
                  <span className="k">How</span>
                  <span>
                    Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> with your payment tx hash (both, if a consult was credited)
                    within 30 days of payment. The full $99 is sent back manually in USDC on Base; each payment returns to its own sender (the
                    token transfer sender for that payment).
                  </span>
                  <span className="k">Per host</span>
                  <span>
                    The refund rule applies per host: a host counts as resolved when its fixed routes pass validation and appear in
                    discovery. If any fixed route still meets refund condition (a) or (b), the full $99 for that host is refunded.
                  </span>
                  <span className="k">Consult</span>
                  <span>The $49 pays for the call and isn&apos;t refunded once the call has happened. If we can&apos;t hold it, you get the $49 back in full.</span>
                </div>
              </div>
            </div>
            <div className="hp-grid" style={{ marginTop: 1 }}>
              <div className="hp-tile" data-reveal>
                <Ico d={I.lock} />
                <h3>No access needed</h3>
                <p>We never ask for API keys, deploy access, private keys or wallet control. You make every change in your own code, and every settle comes from your own wallet.</p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.search} />
                <h3>Public checks only</h3>
                <p>
                  Every result we send is reproducible with Coinbase&apos;s public tools. See their{" "}
                  <a href={VALIDATOR_DOCS} target="_blank" rel="noreferrer">Bazaar docs ↗</a>.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.check} />
                <h3>No unnecessary payments</h3>
                <p>Beyond our fee, the only payment is the trigger settle, from your wallet to your own payTo.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-cta-band" data-reveal>
          <h2>Book a listing consult.</h2>
          <p>30 minutes, $49, and it counts toward the $99 fix if you book the fix within 14 days.</p>
          <div className="hp-ctas">
            <a className="hp-btn primary" href={MAIL}>Book a $49 consult</a>
            <a className="hp-btn ghost" href={MAIL_FIX}>Start the $99 fix</a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
