import Link from "next/link";
import { DEFAULT_PAY_TO, GITHUB_REPO, USDC_BASE, BASE_CAIP2, PUBLIC_BASE_URL, CONTACT_EMAIL } from "@/lib/config";
import { catalogStats, routeName } from "@/lib/live-catalog";
import { DEMO_ROUTES } from "@/lib/demo-catalog";
import { SiteHeader } from "@/components/SiteHeader";
import { HeroTerminal } from "@/components/HeroTerminal";
import { CodeTabs } from "@/components/CodeTabs";

const X_URL = "https://x.com/HorizonPulseAPI";
const demoSet = new Set(DEMO_ROUTES.map((d) => d.route));

export default function HomePage() {
  const s = catalogStats();
  return (
    <div className="hp">
      <SiteHeader />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <div className="hp-hero-grid">
              <div>
                <span className="hp-chip">Live on Base mainnet · x402 v2</span>
                <h1>
                  Pay-per-call APIs
                  <br />
                  built for <em>AI agents</em>.
                </h1>
                <p className="hp-sub">
                  {s.routes} paid routes for market data, the web and documents. <strong>No API keys, no signup.</strong>{" "}
                  Your agent pays {s.minPrice}–{s.maxPrice} in USDC per call and gets JSON back. Real sources only, no invented metrics.
                </p>
                <div className="hp-ctas">
                  <a className="hp-btn primary" href="#try">Try a free sample</a>
                  <a className="hp-btn ghost" href="#catalog">Browse the catalog</a>
                  <a className="hp-btn ghost" href="/llms.txt">For agents: /llms.txt</a>
                </div>
                <div className="hp-trust">
                  <span>Any x402 client</span>
                  <span>USDC on Base</span>
                  <span>Coinbase CDP facilitator</span>
                  <span>Source on GitHub</span>
                </div>
              </div>
              <HeroTerminal />
            </div>

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
                <div className="d">one for every route</div>
              </div>
              <div className="hp-stat">
                <div className="k">Discovery</div>
                <div className="v">{s.endpoints}</div>
                <div className="d">GET/POST endpoints in /.well-known/x402</div>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="catalog">
          <div className="hp-wrap">
            <h2>Catalog</h2>
            <p className="hp-lead">
              Every route works the same way: <code>GET</code> → <code>402</code> → pay → JSON. Each has a free sample on a fixed input.
            </p>
            {s.byCategory.map((g) => (
              <div className="hp-group" key={g.category} style={{ ["--cat" as string]: `var(--${g.category})` }}>
                <div className="hp-group-h">
                  <i />
                  {g.label} · {g.routes.length}
                </div>
                <div className="hp-cards">
                  {g.routes.map((r) => {
                    const name = routeName(r);
                    return (
                      <div className="hp-card" key={r.path}>
                        <div className="hp-card-top">
                          <span className="hp-route">/api/{name}</span>
                          <span className="hp-method">{r.method === "GET|POST" ? "GET · POST" : "GET"}</span>
                        </div>
                        <div className="hp-blurb">{r.blurb}</div>
                        <div className="hp-card-foot">
                          <span className="hp-price">
                            {r.priceUsd} <small>USDC</small>
                          </span>
                          {demoSet.has(name) && (
                            <a className="hp-sample" href={`/api/demo/${name}`}>
                              Free sample →
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="hp-section" id="how">
          <div className="hp-wrap">
            <h2>How it works</h2>
            <p className="hp-lead">Standard x402 v2 over plain HTTP. No accounts, no keys, nothing to sign up for.</p>
            <div className="hp-steps">
              <div className="hp-step">
                <b>Call the route</b>
                <p>
                  <code>GET</code> any paid route on <code>horizonpulse.dev</code> without payment.
                </p>
              </div>
              <div className="hp-step">
                <b>Get a 402</b>
                <p>
                  The <code>PAYMENT-REQUIRED</code> header lists the exact USDC amount, network <code>{BASE_CAIP2}</code> and payTo.
                </p>
              </div>
              <div className="hp-step">
                <b>Sign and retry</b>
                <p>
                  Retry the same request with a <code>PAYMENT-SIGNATURE</code> header. The Coinbase CDP facilitator verifies and settles.
                </p>
              </div>
              <div className="hp-step">
                <b>Get JSON</b>
                <p>The JSON comes back with a settlement receipt header. Error responses (4xx/5xx) are not charged.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="try">
          <div className="hp-wrap">
            <h2>Try it free</h2>
            <p className="hp-lead">
              Every route has a free twin at <code>/api/demo/&lt;route&gt;</code>: real output on a fixed input, no payment.
            </p>
            <div className="hp-try">
              <CodeTabs />
              <div className="hp-demos">
                {DEMO_ROUTES.map((d) => (
                  <a key={d.route} href={`/api/demo/${d.route}`}>
                    <span>/api/demo/{d.route}</span>
                    <span className="hp-free">FREE</span>
                  </a>
                ))}
              </div>
            </div>
            <p className="hp-fine">
              Full working example:{" "}
              <a href={`${GITHUB_REPO}/blob/main/examples/reference-agent.mjs`} target="_blank" rel="noreferrer" style={{ color: "var(--brand)" }}>
                examples/reference-agent.mjs
              </a>
              . MCP server at <code>/mcp</code>.
            </p>
          </div>
        </section>

        <section className="hp-section" style={{ paddingTop: 16 }}>
          <div className="hp-wrap">
            <div className="hp-pay">
              <span className="k">Only pay to</span>
              <code>{DEFAULT_PAY_TO}</code>
              <span className="k">Asset</span>
              <span>
                USDC on Base <code>{USDC_BASE}</code>
              </span>
              <span className="k">Network</span>
              <span>
                Base mainnet (<code>{BASE_CAIP2}</code>) · Coinbase CDP facilitator
              </span>
              <span className="k">Host</span>
              <span>
                <code>{PUBLIC_BASE_URL}</code> · live balance on <Link href="/status" style={{ color: "var(--brand)" }}>/status</Link>
              </span>
            </div>
          </div>
        </section>
      </main>

      <footer className="hp-footer">
        <div className="hp-wrap">
          <div className="hp-foot-grid">
            <div>
              <h4>Horizon Pulse</h4>
              <p style={{ color: "var(--text-2)", margin: 0, maxWidth: 300 }}>
                Pay-per-call APIs for AI agents, settled in USDC on Base with x402.
              </p>
            </div>
            <div>
              <h4>For agents</h4>
              <a href="/llms.txt">/llms.txt</a>
              <a href="/openapi.json">/openapi.json</a>
              <a href="/.well-known/x402">/.well-known/x402</a>
              <a href="#try">Free samples</a>
            </div>
            <div>
              <h4>Project</h4>
              <a href={GITHUB_REPO} target="_blank" rel="noreferrer">GitHub</a>
              <a href={X_URL} target="_blank" rel="noreferrer">@HorizonPulseAPI on X</a>
              <Link href="/status">Status</Link>
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </div>
            <div>
              <h4>Network</h4>
              <a href="https://www.x402.org/" target="_blank" rel="noreferrer">x402 protocol</a>
              <a href="https://base.org" target="_blank" rel="noreferrer">Base</a>
              <a href={`https://basescan.org/address/${DEFAULT_PAY_TO}`} target="_blank" rel="noreferrer">payTo on Basescan</a>
            </div>
          </div>
          <p className="hp-fine">
            Unpaid requests to paid routes return HTTP 402 with <code>PAYMENT-REQUIRED</code> until a valid x402 v2 <code>PAYMENT-SIGNATURE</code> is sent. Only live routes are listed.
          </p>
        </div>
      </footer>
    </div>
  );
}
