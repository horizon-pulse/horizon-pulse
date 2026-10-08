import type { Metadata } from "next";
import { CDP_DESCRIPTION_LIMIT_DOC, HONESTY_LINE, TURNAROUND_LINE, WE_DONT } from "@/lib/agent-promotion";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { Reveal } from "@/components/Reveal";

export const metadata: Metadata = {
  title: "Agent promotion: what's delivered | Horizon Pulse",
  description:
    "What the agent promotion setup delivers: a description pack (llms.txt, skill.md, OpenAPI summary, Coinbase Bazaar description), directory submissions or ready-to-submit packs, monthly reporting, and what we don't do.",
};

const Ico = ({ d }: { d: string }) => (
  <svg className="hp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const I = {
  doc: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h5",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  chart: "M4 20V10M10 20V4M16 20v-8M22 20H2",
  clock: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2",
  no: "M12 3a9 9 0 100 18 9 9 0 000-18zM6 6l12 12",
  key: "M15 7a4 4 0 11-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0115 7z",
};

const PACK = [
  { n: "llms.txt", d: "A plain-text catalog of your routes, prices and rules for agents and LLM tools." },
  { n: "skill.md", d: "A step-by-step skill file an agent can follow to discover, pay for and call your routes." },
  { n: "OpenAPI summary", d: "Clear service and operation summaries in your OpenAPI document." },
  {
    n: "Coinbase Bazaar description",
    d: (
      <>
        Written to fit Coinbase&apos;s 500-character limit; the CDP Facilitator rejects verify and settle requests whose description
        exceeds it (
        <a href={CDP_DESCRIPTION_LIMIT_DOC} target="_blank" rel="noreferrer">CDP docs ↗</a>).
      </>
    ),
  },
];

const DIRECTORIES = [
  "Coinbase x402 Bazaar",
  "x402scan",
  "The official MCP Registry",
  "Other public MCP directories and agent-tool catalogs",
  "npm, for MCP packages",
];

export default function AgentPromotionSpecPage() {
  return (
    <div className="hp">
      <SiteHeader />
      <Reveal />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">Agent promotion · spec</span>
            <h1>
              What&apos;s delivered.
              <br />
              <span>And what isn&apos;t.</span>
            </h1>
            <p className="hp-sub">
              The setup is <strong>$149 per host</strong>, one-time; monitoring is <strong>$49/month</strong>. Intro prices. See{" "}
              <a href="/agent-promotion#pricing">pricing and terms</a>.
            </p>
            <div className="hp-ctas">
              <a className="hp-btn primary" href="/agent-promotion/start">Start the intake</a>
              <a className="hp-btn ghost" href="/agent-promotion">Back to overview</a>
            </div>
          </div>
        </section>

        <section className="hp-section" id="pack">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Description pack</div>
              <h2>
                The files agents read. <span>Written for your routes.</span>
              </h2>
            </div>
            <div className="hp-grid two">
              {PACK.map((p) => (
                <div className="hp-tile" key={p.n} data-reveal>
                  <Ico d={I.doc} />
                  <h3>{p.n}</h3>
                  <p>{p.d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="hp-section" id="directories">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Directories</div>
              <h2>
                Where agents look. <span>Submitted the honest way.</span>
              </h2>
              <p className="hp-lead">{HONESTY_LINE}</p>
            </div>
            <div className="hp-grid two">
              <div className="hp-tile" data-reveal>
                <Ico d={I.list} />
                <h3>Directories and catalogs</h3>
                <div className="hp-kv">
                  {DIRECTORIES.map((d, i) => [
                    <span className="k" key={`k${i}`}>{String(i + 1).padStart(2, "0")}</span>,
                    <span key={`v${i}`}>{d}</span>,
                  ])}
                </div>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.key} />
                <h3>Ready-to-submit packs</h3>
                <p>
                  Where a directory needs your own account or namespace proof, you get a ready-to-submit pack and submit it under your
                  account.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="reporting">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Reporting and turnaround</div>
              <h2>
                Monthly reports. <span>A target, not a guarantee.</span>
              </h2>
            </div>
            <div className="hp-grid two">
              <div className="hp-tile" data-reveal>
                <Ico d={I.chart} />
                <h3>Reporting: monthly</h3>
                <p>
                  With monitoring: directory status, calls and payers we can observe on-chain or through Bazaar data, and changes we made.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={I.clock} />
                <h3>Turnaround</h3>
                <p>{TURNAROUND_LINE}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="dont">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">What we don&apos;t do</div>
              <h2>
                No shortcuts. <span>No guarantees we can&apos;t keep.</span>
              </h2>
            </div>
            <div className="hp-grid">
              {WE_DONT.map((w) => (
                <div className="hp-tile" key={w} data-reveal>
                  <Ico d={I.no} />
                  <h3>{w}</h3>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="hp-cta-band" data-reveal>
          <h2>Ready to start?</h2>
          <p>Send the intake by email, or start with a $49 written listing review.</p>
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
