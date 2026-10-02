import Link from "next/link";
import { DEFAULT_PAY_TO, GITHUB_REPO, USDC_BASE, BASE_CAIP2 } from "@/lib/config";
import { catalogStats, routeName, LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import { DEMO_ROUTES } from "@/lib/demo-catalog";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { HeroTerminal } from "@/components/HeroTerminal";
import { Reveal } from "@/components/Reveal";
import { CopyLine } from "@/components/CopyLine";

const demoSet = new Set(DEMO_ROUTES.map((d) => d.route));
const FEATURED = ["pulse", "fetch", "extract"];
const BAZAAR_LOOKUP = `https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=${DEFAULT_PAY_TO.toLowerCase()}`;
const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty"];

const Ico = ({ d }: { d: string }) => (
  <svg className="hp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const ICONS: Record<string, string> = {
  pulse: "M3 12h4l3-7 4 14 3-7h4",
  fetch: "M4 5h16v14H4zM4 9h16M8 13h8M8 16h5",
  extract: "M4 6h7M4 12h10M4 18h6M16 5l4 4-4 4",
  call: "M5 12h14M13 6l6 6-6 6",
  402: "M12 3l9 16H3zM12 10v4M12 17h.01",
  sign: "M4 20l4-1 11-11-3-3L5 16zM14 6l3 3",
  json: "M8 4c-2 0-3 1-3 3v2c0 1-1 3-2 3 1 0 2 2 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1 1 3 2 3-1 0-2 2-2 3v2c0 2-1 3-3 3",
  wallet: "M3 7h15a2 2 0 012 2v8a2 2 0 01-2 2H3zM3 7l12-3v3M16 13h.01",
  agent: "M9 3h6M12 3v3M5 8h14v10H5zM9 12h.01M15 12h.01M9 15h6",
};

export default function HomePage() {
  const s = catalogStats();
  const featured = FEATURED.map((n) => LIVE_PAID_ROUTES.find((r) => routeName(r) === n)).filter(Boolean) as typeof LIVE_PAID_ROUTES[number][];
  return (
    <div className="hp">
      <SiteHeader />
      <Reveal />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">Live on Base · x402 v2</span>
            <h1>
              Pay-per-call APIs
              <br />
              <span>built for agents.</span>
            </h1>
            <p className="hp-sub">
              {s.routes} routes for market data, the web and documents. <strong>No API keys, no signup.</strong> Your agent pays{" "}
              {s.minPrice}–{s.maxPrice} in USDC per call and gets JSON back.
            </p>
            <div className="hp-ctas">
              <a className="hp-btn primary" href="/try">Try a free sample</a>
              <a className="hp-btn ghost" href="#catalog">See all {s.routes} routes</a>
            </div>
            <CopyLine text="curl https://horizonpulse.dev/api/demo/pulse" />
            <p className="hp-proof">
              <a href={BAZAAR_LOOKUP} target="_blank" rel="noreferrer">Listed in Coinbase&apos;s x402 Bazaar ↗</a>
              <span>·</span>
              <a href="/.well-known/x402">/.well-known/x402</a>
            </p>
            <HeroTerminal />
            <div className="hp-stats">
              <div className="hp-stat">
                <div className="k">Paid routes</div>
                <div className="v">{s.routes}</div>
                <div className="d">{s.byCategory.map((g) => `${g.routes.length} ${g.category}`).join(" · ")}</div>
              </div>
              <div className="hp-stat">
                <div className="k">Price per call</div>
                <div className="v">{s.minPrice}–{s.maxPrice}</div>
                <div className="d">USDC, exact amount in the 402</div>
              </div>
              <div className="hp-stat">
                <div className="k">Free samples</div>
                <div className="v">{DEMO_ROUTES.length}</div>
                <div className="d">a free twin for every route</div>
              </div>
              <div className="hp-stat">
                <div className="k">Discovery</div>
                <div className="v">{s.endpoints}</div>
                <div className="d">endpoints in /.well-known/x402</div>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="catalog">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Catalog</div>
              <h2>
                {WORDS[s.routes] ?? s.routes} routes. <span>One protocol.</span>
              </h2>
              <p className="hp-lead">
                Every route works the same way: request, get a 402, pay in USDC, get JSON. Each one has a free twin at{" "}
                <code>/api/demo/&lt;route&gt;</code> with real output on a fixed input.
              </p>
            </div>
            <div className="hp-label" style={{ marginTop: 8 }}>Start here</div>
            <div className="hp-grid">
              {featured.map((r) => {
                const name = routeName(r);
                return (
                  <div className="hp-tile" key={r.path} data-reveal>
                    <Ico d={ICONS[name] ?? ICONS.call} />
                    <h3>{`/api/${name}`}</h3>
                    <p>{r.blurb}</p>
                    <div className="hp-tile-foot">
                      <b>{r.priceUsd}</b>
                      <a href={`/try#${name}`}>Free sample →</a>
                    </div>
                  </div>
                );
              })}
            </div>

            <table className="hp-table" data-reveal>
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
                        <td className="b">{r.blurb}</td>
                        <td className="p">{r.priceUsd}</td>
                        <td className="s">{demoSet.has(name) && <a href={`/try#${name}`}>Sample →</a>}</td>
                      </tr>
                    );
                  }),
                ])}
              </tbody>
            </table>
          </div>
        </section>

        <section className="hp-section" id="how">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Protocol</div>
              <h2>
                Plain HTTP. <span>Standard x402 v2.</span>
              </h2>
              <p className="hp-lead">No accounts and nothing to sign up for. Any x402 v2 client can pay, and the Coinbase CDP facilitator settles on Base.</p>
            </div>
            <div className="hp-grid four">
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">01</span>
                <Ico d={ICONS.call} />
                <h3>Call the route</h3>
                <p>Send the request to any paid route on <code>horizonpulse.dev</code> without payment.</p>
              </div>
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">02</span>
                <Ico d={ICONS[402]} />
                <h3>Read the 402</h3>
                <p>
                  The <code>PAYMENT-REQUIRED</code> header gives the exact USDC amount, the network <code>{BASE_CAIP2}</code> and payTo.
                </p>
              </div>
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">03</span>
                <Ico d={ICONS.sign} />
                <h3>Sign and retry</h3>
                <p>Retry with a <code>PAYMENT-SIGNATURE</code> header. The facilitator verifies and settles.</p>
              </div>
              <div className="hp-tile" data-reveal>
                <span className="hp-step-n">04</span>
                <Ico d={ICONS.json} />
                <h3>Get JSON</h3>
                <p>JSON comes back with a settlement receipt header. Our error responses (4xx/5xx) are not charged.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="agents">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Integration</div>
              <h2>
                Everything an agent needs <span>to find and pay us.</span>
              </h2>
              <p className="hp-lead">Discovery files for machines, one working example for humans, and exactly one address to pay.</p>
            </div>
            <div className="hp-grid two">
              <div className="hp-tile" data-reveal>
                <Ico d={ICONS.agent} />
                <h3>For agents</h3>
                <div className="hp-kv">
                  <span className="k">Catalog</span>
                  <span><a href="/llms.txt"><code>/llms.txt</code></a> · <a href="/openapi.json"><code>/openapi.json</code></a></span>
                  <span className="k">x402 index</span>
                  <span><a href="/.well-known/x402"><code>/.well-known/x402</code></a></span>
                  <span className="k">MCP</span>
                  <span><code>/mcp</code>, streamable HTTP, tools/list free</span>
                  <span className="k">Example</span>
                  <span>
                    <a href={`${GITHUB_REPO}/blob/main/examples/reference-agent.mjs`} target="_blank" rel="noreferrer"><code>reference-agent.mjs</code></a> on GitHub
                  </span>
                </div>
              </div>
              <div className="hp-tile" data-reveal>
                <Ico d={ICONS.wallet} />
                <h3>Payment</h3>
                <div className="hp-kv">
                  <span className="k">Only pay to</span>
                  <code>{DEFAULT_PAY_TO}</code>
                  <span className="k">Asset</span>
                  <span>USDC <code>{USDC_BASE}</code></span>
                  <span className="k">Network</span>
                  <span>Base mainnet, Coinbase CDP facilitator</span>
                  <span className="k">Balance</span>
                  <span>Live on <Link href="/status">/status</Link></span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-cta-band" data-reveal>
          <h2>Start with a free sample.</h2>
          <p>Real output, no wallet needed. Pay only when your agent needs a live input.</p>
          <div className="hp-ctas">
            <a className="hp-btn primary" href="/try">Try it free</a>
            <a className="hp-btn ghost" href="/docs">Read the docs</a>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
