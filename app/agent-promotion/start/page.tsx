import type { Metadata } from "next";
import { CONTACT_EMAIL, USDC_BASE } from "@/lib/config";
import { intakeMailto, REFUND_LINES, SERVICE_FEE_ADDRESS } from "@/lib/agent-promotion";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { Reveal } from "@/components/Reveal";
import { IntakeForm } from "@/components/IntakeForm";

export const metadata: Metadata = {
  title: "Agent promotion intake | Horizon Pulse",
  description:
    "Start agent promotion for your API: send your API URL, contact email, a short description and (optionally) your number of paid routes in a prefilled email. Nothing is stored on the site.",
};

const Ico = ({ d }: { d: string }) => (
  <svg className="hp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const I = {
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  wallet: "M3 7h15a2 2 0 012 2v8a2 2 0 01-2 2H3zM3 7l12-3v3M16 13h.01",
};

const DECLINE = REFUND_LINES.find((l) => l.k === "Declined jobs")!.v;
const BLANK_MAILTO = intakeMailto({ apiUrl: "", email: "", description: "", routes: "" });

export default function AgentPromotionStartPage() {
  return (
    <div className="hp">
      <SiteHeader />
      <Reveal />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">Agent promotion · intake</span>
            <h1>
              Start with
              <br />
              <span>four fields.</span>
            </h1>
            <p className="hp-sub">
              Fill these in and your email app opens a prefilled message to <strong>{CONTACT_EMAIL}</strong>. Nothing is sent to or
              stored on this site.
            </p>
          </div>
        </section>

        <section className="hp-section" id="intake" style={{ paddingTop: 40 }}>
          <div className="hp-wrap">
            <div className="hp-grid two">
              <div className="hp-tile" data-reveal>
                <Ico d={I.mail} />
                <h3>Intake</h3>
                <IntakeForm />
                <p style={{ fontSize: 13 }}>
                  No email app? Write to <a href={BLANK_MAILTO}>{CONTACT_EMAIL}</a> with the subject{" "}
                  <code>Agent promotion intake: {"{host}"}</code> and the same four fields.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.wallet} />
                <h3>Then</h3>
                <div className="hp-kv">
                  <span className="k">Pricing</span>
                  <span>
                    $49 written review, $149 setup per host, $49/month monitoring. Intro prices. More than 25 paid routes: we quote
                    first. <a href="/agent-promotion#pricing">Details</a>
                  </span>
                  <span className="k">Payment</span>
                  <span>
                    USDC on Base <code>{USDC_BASE}</code> to <code>{SERVICE_FEE_ADDRESS}</code>, the same wallet and flow as{" "}
                    <a href="/listing-fix">/listing-fix</a>: pay from a wallet you control, then email us the transaction hash. No card
                    checkout.
                  </span>
                  <span className="k">Declined</span>
                  <span>{DECLINE}</span>
                  <span className="k">Format</span>
                  <span>Everything is written and async, by email or in your thread.</span>
                  <span className="k">Terms</span>
                  <span>
                    <a href="/agent-promotion#terms">Payment and refunds</a> · <a href="/agent-promotion/spec">What&apos;s delivered</a>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
