import Link from "next/link";
import { BASE_PAY_TO_BASENAME, CONTACT_EMAIL, GITHUB_REPO, USDC_BASE, getPayTo } from "@/lib/config";
import { SOLANA_PAYTO, USDC_SOLANA_MINT } from "@/lib/solana-config";
import { USDC_POLYGON } from "@/lib/polygon-config";
import { XRPL_PAYTO, RLUSD_MAINNET_ISSUER } from "@/lib/xrpl-config";
import { andList, catalogStats, FREE_ROUTE, orList, routeName, routePath, LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import { DEMO_ROUTES } from "@/lib/demo-catalog";
import { paymentRails } from "@/lib/payment-rails";
import { EURC_BASE } from "@/lib/eurc-config";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { HeroTerminal } from "@/components/HeroTerminal";
import { Reveal } from "@/components/Reveal";
import { CopyLine } from "@/components/CopyLine";

const demoSet = new Set(DEMO_ROUTES.map((d) => d.route));
const FEATURED = ["pulse", "fetch", "extract"];
const BAZAAR_LOOKUP = `https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=${getPayTo().toLowerCase()}`;
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

/** ISR: rebuild hourly so EURC/rail gating follows the live 402 (e.g. after the EURC rate expires). */
export const revalidate = 3600;

export default function HomePage() {
  const s = catalogStats();
  const pay = paymentRails();
  const payTo = getPayTo();
  const featured = FEATURED.map((n) => LIVE_PAID_ROUTES.find((r) => routeName(r) === n)).filter(Boolean) as typeof LIVE_PAID_ROUTES[number][];
  return (
    <div className="hp">
      <SiteHeader />
      <Reveal />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">Live on Base + Solana + Polygon + XRP Ledger · x402 v2</span>
            <h1>
              Pay-per-call APIs
              <br />
              <span>built for agents.</span>
            </h1>
            <p className="hp-sub">
              {s.paidRoutes} paid services for market data, onchain checks, the web and documents. <strong>No API keys, no signup.</strong> Your agent pays{" "}
              {s.minPrice}–{s.maxPrice} per call in USDC on Base, Solana or Polygon, {pay.eurc ? "EURC on Base, " : ""}or RLUSD on the XRP Ledger, and gets JSON back.
              {s.premium.length === 1 ? <> Plus a {s.premium[0].priceUsd} <a href={s.premium[0].contract ?? "#catalog"}>{s.premium[0].label}</a> ({s.premium[0].rail}). EURC is offered only when it is listed in the 402 response.</> : null}
              {s.premium.length > 1 ? (
                <>
                  {" "}Plus {s.premium.length === 2 ? "two" : s.premium.length} premium checks on Base, in USDC or EURC:{" "}
                  {s.premium.map((x, i) => (
                    <span key={x.id}>
                      {i ? (i === s.premium.length - 1 ? " and " : ", ") : ""}a <strong>{x.priceUsd} {x.label}</strong>
                    </span>
                  ))}
                  . EURC is offered only when it is listed in the 402 response.
                </>
              ) : null}
            </p>
            <div className="hp-ctas">
              <a className="hp-btn primary" href="/try">Try a free sample</a>
              <a className="hp-btn ghost" href="#catalog">See all {s.paidRoutes} paid services</a>
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
                <div className="v">{s.paidRoutes}</div>
                <div className="d">{[...s.bySiteGroup.map((g) => `${g.short} ${g.routes.length}`), ...(s.premium.length === 1 ? [`${s.premium[0].label} 1`] : s.premium.length ? [`premium ${s.premium.length}`] : [])].join(" · ")}</div>
              </div>
              <div className="hp-stat">
                <div className="k">Price per call</div>
                <div className="v">{s.minPrice}–{s.maxPrice}</div>
                <div className="d">USDC, exact amount in the 402{s.premium.length > 1 ? ` · premium ${andList(s.premiumPrices)}` : ""}</div>
              </div>
              <div className="hp-stat">
                <div className="k">Free samples</div>
                <div className="v">{s.freeSamples}</div>
                <div className="d">{s.freeSamples} of {s.paidRoutes} paid routes have a free demo twin{s.noSample.length ? ` (none for ${orList(s.noSample)})` : ""}</div>
              </div>
              <div className="hp-stat">
                <div className="k">Discovery</div>
                <div className="v">{s.paidRoutes}</div>
                <div className="d">URLs in /.well-known/x402 · {s.postAccepting} {s.premium.some((x) => x.method === "POST") ? "accept" : "also accept"} POST</div>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="pay">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Payment options</div>
              <h2>
                Open to every agent. <span>Pay per call via x402.</span>
              </h2>
              <p className="hp-lead">No accounts and no API keys. Pick any option listed in the 402 response, which gives the exact amount for each.</p>
            </div>
            <ul className="hp-rails" data-reveal>
              {pay.rails.map((r) => (
                <li className="hp-rail" key={r.asset}>
                  <h3>{r.asset}</h3>
                  <p>{r.chains.join(", ")}</p>
                </li>
              ))}
            </ul>
            {s.premium.length ? (
              <p className="hp-rail-note" data-reveal>
                {s.premium.map((x, i) => (
                  <span key={x.id}>{i ? (i === s.premium.length - 1 ? " and the " : ", the ") : "The "}{x.priceUsd} {x.label}</span>
                ))}{" "}
                {s.premium.length > 1 ? "accept" : "accepts"} {pay.premiumAssets.join(" or ")} on Base only.
              </p>
            ) : null}
          </div>
        </section>

        <section className="hp-section" id="catalog">
          <div className="hp-wrap">
            <div data-reveal>
              <div className="hp-label">Catalog</div>
              <h2>
                {WORDS[s.paidRoutes] ?? s.paidRoutes} routes. <span>One protocol.</span>
              </h2>
              <p className="hp-lead">
                Every route works the same way: request, get a 402, pay per call, get JSON. {s.freeSamples} of {s.paidRoutes} have a free twin at{" "}
                <code>/api/demo/&lt;route&gt;</code> that runs the route on a fixed input (discourse/split: a stored recording, not re-run).
              </p>
            </div>
            <div className="hp-label" style={{ marginTop: 8 }}>Start here</div>
            <div className="hp-grid">
              {featured.map((r) => {
                const name = routeName(r);
                return (
                  <div className="hp-tile" key={r.path} data-reveal>
                    <Ico d={ICONS[name] ?? ICONS.call} />
                    <h3>{routePath(r)}</h3>
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
                {s.bySiteGroup.map((g) => [
                  <tr className="grp" key={g.category}>
                    <td colSpan={5}>{g.label}</td>
                  </tr>,
                  ...g.routes.map((r) => {
                    const name = routeName(r);
                    return (
                      <tr key={r.path}>
                        <td className="r">{routePath(r)}</td>
                        <td className="m">{r.method === "GET|POST" ? "GET · POST" : "GET"}</td>
                        <td className="b">{r.blurb}</td>
                        <td className="p">{r.priceUsd}</td>
                        <td className="s">{demoSet.has(name) && <a href={`/try#${name}`}>Sample →</a>}</td>
                      </tr>
                    );
                  }),
                ])}
                {s.premium.length ? (
                  <tr className="grp" key="premium">
                    <td colSpan={5}>{s.premium.length > 1 ? "Premium" : "Verified brief"} ({s.premium[0].rail})</td>
                  </tr>
                ) : null}
                {s.premium.map((x) => (
                  <tr key={x.path}>
                    <td className="r">{x.path}</td>
                    <td className="m">{x.method}</td>
                    <td className="b">
                      {x.summary} {x.contract ? <><a href={x.contract}>Contract</a> · </> : null}<a href={x.terms}>Terms</a>
                    </td>
                    <td className="p">{x.priceUsd}</td>
                    <td className="s">{x.demo ? <a href={x.demo}>Sample →</a> : null}</td>
                  </tr>
                ))}
                <tr className="grp" key="free">
                  <td colSpan={5}>Free</td>
                </tr>
                <tr key={FREE_ROUTE.path}>
                  <td className="r">{FREE_ROUTE.path}</td>
                  <td className="m">{FREE_ROUTE.method}</td>
                  <td className="b">{FREE_ROUTE.blurb}</td>
                  <td className="p">no payment</td>
                  <td className="s" />
                </tr>
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
              <p className="hp-lead">No accounts and nothing to sign up for. Any x402 v2 client can pay with any option listed in the 402 response, which gives the exact amount for each: the Coinbase CDP facilitator settles on Base, PayAI on Solana, and XRP Ledger payments are verified on the validated ledger.</p>
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
                  The <code>PAYMENT-REQUIRED</code> header lists one option per network (Base, Solana, Polygon, XRP Ledger), each with the exact amount ({pay.eurc ? "USDC, EURC on Base, or RLUSD on the XRP Ledger" : "USDC, or RLUSD on the XRP Ledger"}) and payTo.
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
              <p className="hp-lead">Discovery files for machines, one working example for humans, and exactly one address to pay on each network.</p>
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
                  <span className="k">Base: pay to</span>
                  <code>{payTo}</code>
                  <span className="k">Base name</span>
                  <span><code>{BASE_PAY_TO_BASENAME}</code>, the Basename for this address</span>
                  <span className="k">Base asset</span>
                  <span>USDC <code>{USDC_BASE}</code></span>
                  {pay.eurc ? (
                    <>
                      <span className="k">Base asset (EURC)</span>
                      <span>EURC <code>{EURC_BASE}</code></span>
                    </>
                  ) : null}
                  {pay.solana ? (
                    <>
                      <span className="k">Solana: pay to</span>
                      <code>{SOLANA_PAYTO}</code>
                      <span className="k">Solana asset</span>
                      <span>USDC <code>{USDC_SOLANA_MINT}</code></span>
                    </>
                  ) : null}
                  {pay.polygon ? (
                    <>
                      <span className="k">Polygon: pay to</span>
                      <code>{payTo}</code>
                      <span className="k">Polygon asset</span>
                      <span>native USDC <code>{USDC_POLYGON}</code> (same address as Base)</span>
                    </>
                  ) : null}
                  {pay.xrpl ? (
                    <>
                      <span className="k">XRP Ledger: pay to</span>
                      <code>{XRPL_PAYTO}</code>
                      <span className="k">XRP Ledger asset</span>
                      <span>RLUSD, issuer <code>{RLUSD_MAINNET_ISSUER}</code></span>
                    </>
                  ) : null}
                  <span className="k">Settlement</span>
                  <span>x402 <code>exact</code>, same price on all four. Coinbase CDP facilitator on Base and Polygon, PayAI on Solana; XRP Ledger payments are verified by us on the validated ledger</span>
                  <span className="k">Balance</span>
                  <span>Base payTo live on <Link href="/status">/status</Link></span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="hp-section" id="services">
          <div className="hp-wrap">
            <div className="hp-label" data-reveal>Services for API owners</div>
            <div className="hp-grid two">
              <a className="hp-tile" href="/listing-fix" style={{ textDecoration: "none" }} data-reveal>
                <h3>Fix your x402 listing</h3>
                <div className="hp-tile-foot"><span>/listing-fix</span><span>→</span></div>
              </a>
              <a className="hp-tile" href="/agent-promotion" style={{ textDecoration: "none" }} data-reveal>
                <h3>Agent promotion: get your API found and used by agents</h3>
                <div className="hp-tile-foot"><span>/agent-promotion</span><span>→</span></div>
              </a>
            </div>
            <p className="hp-lead" style={{ marginTop: 16 }}>
              Full x402 setup from scratch is quoted by email: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
            </p>
          </div>
        </section>

        <section className="hp-cta-band" data-reveal>
          <h2>Start with a free sample.</h2>
          <p>Fixed-input samples, no wallet needed. Pay only when your agent needs its own input.</p>
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
