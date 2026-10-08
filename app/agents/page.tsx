import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { CopyBlock } from "@/components/CopyBlock";
import { DEMO_CAPTURED_AT, DEMO_COMMAND, DEMO_OUTPUT } from "@/lib/agent-demo";
import { CODE } from "@/lib/client-snippets";
import { DEFAULT_PAY_TO, GITHUB_REPO, PUBLIC_BASE_URL, USDC_BASE } from "@/lib/config";
import { HOSTED_MCP_CONFIG, MCP_CONFIG, MCP_INSTALL, PAY_STEPS, loadSkillRoutes } from "@/lib/agent-skill";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "For agents | Horizon Pulse",
  description:
    "How an AI agent finds, pays and calls Horizon Pulse: discovery files, the x402 v2 pay flow in USDC on Base, a skill file at /skill.md and an MCP server that pays per call with spend caps.",
  alternates: { canonical: "/agents" },
};

const routes = loadSkillRoutes();

const FLOW = `# 1. Unpaid call: HTTP 402, challenge in the PAYMENT-REQUIRED header
curl -si ${PUBLIC_BASE_URL}/api/pulse | grep -i '^payment-required' | cut -d' ' -f2 | base64 -d

# 2. Check scheme exact, network eip155:8453, USDC, payTo and amount
# 3. Sign EIP-3009 with an x402 client, retry with PAYMENT-SIGNATURE
# 4. 200 + JSON, receipt in the PAYMENT-RESPONSE header`;

export default function AgentsPage() {
  return (
    <div className="hp">
      <SiteHeader />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">For agents · x402 v2 · USDC on Base</span>
            <h1>
              Find it, pay it,
              <br />
              <span>call it.</span>
            </h1>
            <p className="hp-sub">
              {routes.length} paid routes. No signup or API key: each call is paid on its own in USDC on Base. Give your agent the skill file, or plug in the MCP
              server and set a spend cap.
            </p>
            <div className="hp-raw">
              <a className="hp-btn primary sm" href="/skill.md">skill.md, for agents</a>
              <a className="hp-btn ghost sm" href="/llms.txt">llms.txt</a>
              <a className="hp-btn ghost sm" href="/openapi.json">openapi.json</a>
              <a className="hp-btn ghost sm" href="/.well-known/x402">.well-known/x402</a>
            </div>
          </div>
        </section>

        <section className="hp-section" id="pay">
          <div className="hp-wrap">
            <div>
              <div className="hp-label">How an agent pays</div>
              <h2>
                One 402, one signature, <span>one retry.</span>
              </h2>
              <p className="hp-lead">The same flow on every route. Errors are not charged, apart from the exceptions noted on a route in the docs.</p>
            </div>
            <div className="hp-grid">
              {PAY_STEPS.map((s, i) => (
                <div className="hp-tile" key={s.t}>
                  <span className="hp-step-n">{String(i + 1).padStart(2, "0")}</span>
                  <h3>{s.t}</h3>
                  <p style={{ wordBreak: "break-word" }}>{s.d}</p>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16, display: "grid", gap: 16 }}>
              <CopyBlock title="The flow with curl" code={FLOW} />
              <CopyBlock title={CODE.node.title} code={CODE.node.code} />
            </div>
          </div>
        </section>

        <section className="hp-section" id="skill">
          <div className="hp-wrap">
            <div>
              <div className="hp-label">Skill</div>
              <h2>
                A skill file <span>your agent can follow.</span>
              </h2>
              <p className="hp-lead">
                <a href="/skill.md"><code>/skill.md</code></a> is plain markdown: when to use each route, exact prices, the pay flow step by step, error and billing rules,
                and safety checks. It is generated from <code>/openapi.json</code>, so prices match the 402s.
              </p>
            </div>
            <CopyBlock title="Load it" code={`curl ${PUBLIC_BASE_URL}/skill.md`} />
          </div>
        </section>

        <section className="hp-section" id="mcp">
          <div className="hp-wrap">
            <div>
              <div className="hp-label">MCP</div>
              <h2>
                Every route as a tool, <span>paid with a cap.</span>
              </h2>
              <p className="hp-lead">
                The local MCP server (stdio, Node) exposes each route as a tool plus free <code>catalog</code>, <code>quote</code> and <code>demo</code> tools, and pays
                the x402 challenge with the official x402 client from a wallet you configure.
              </p>
            </div>
            <div className="hp-grid two">
              <div className="hp-tile">
                <h3>Guards</h3>
                <div className="hp-kv">
                  <span className="k">Pays only</span>
                  <code>{DEFAULT_PAY_TO}</code>
                  <span className="k">Asset</span>
                  <span>USDC <code>{USDC_BASE}</code> on Base</span>
                  <span className="k">Price check</span>
                  <span>Refuses any amount above the price in <code>/openapi.json</code></span>
                  <span className="k">Caps</span>
                  <span><code>HP_MAX_USD_PER_CALL</code> (default $0.05), <code>HP_MAX_USD_TOTAL</code> per session (default $1)</span>
                  <span className="k">No key</span>
                  <span>Quote only, never pays</span>
                </div>
              </div>
              <div className="hp-tile">
                <h3>Wallet</h3>
                <p>
                  Use a dedicated buyer wallet with a small USDC balance on Base. The key stays in your MCP config on your machine; it is never sent to Horizon Pulse,
                  only the signed payment is. No ETH or gas is needed.
                </p>
                <p>
                  <a href={`${GITHUB_REPO}/tree/main/mcp`} target="_blank" rel="noreferrer">Source and README on GitHub</a>
                </p>
              </div>
            </div>
            <div style={{ marginTop: 16, display: "grid", gap: 16 }}>
              <CopyBlock title="Install" code={MCP_INSTALL} />
              <CopyBlock title="MCP client config (Claude Desktop, Cursor and other stdio clients)" code={MCP_CONFIG} />
              <CopyBlock title={`Hosted MCP at ${PUBLIC_BASE_URL}/mcp (for MCP clients that can pay x402)`} code={HOSTED_MCP_CONFIG} />
            </div>
          </div>
        </section>

        <section className="hp-section" id="demo">
          <div className="hp-wrap">
            <div>
              <div className="hp-label">Demo · dry run</div>
              <h2>
                From a domain name to a payment, <span>without paying.</span>
              </h2>
              <p className="hp-lead">
                <code>mcp/examples/demo.mjs</code> starts with only <code>horizonpulse.dev</code>, finds the routes through <code>/.well-known/x402</code>,{" "}
                <code>llms.txt</code> and <code>skill.md</code>, then drives the local MCP server: <code>catalog</code>, <code>quote</code>, then a paid tool. It runs with{" "}
                <code>HP_DRY_RUN=1</code> and no private key, so it <strong>never signs and never pays</strong>. It prints the real 402 requirements and the exact
                authorization a client would sign, with the payTo, price and cap checks.
              </p>
            </div>
            <div style={{ display: "grid", gap: 16 }}>
              <CopyBlock title="Run it yourself (dry run)" code={DEMO_COMMAND} />
              <CopyBlock title={`Captured output, ${DEMO_CAPTURED_AT.slice(0, 16).replace("T", " ")} UTC (dry run: nothing signed, nothing paid; trimmed where marked)`} code={DEMO_OUTPUT} />
            </div>
          </div>
        </section>

        <section className="hp-section" id="agent-promotion">
          <div className="hp-wrap">
            <div className="hp-label">For API owners</div>
            <h2>
              Want your own API <span>found by agents?</span>
            </h2>
            <p className="hp-lead" style={{ marginBottom: 0 }}>
              See <a href="/agent-promotion">Agent promotion →</a>
            </p>
          </div>
        </section>

        <section className="hp-section" id="routes">
          <div className="hp-wrap">
            <div>
              <div className="hp-label">Routes</div>
              <h2>
                Tools and prices, <span>straight from the API.</span>
              </h2>
              <p className="hp-lead">
                Tool names are the same in the skill file and both MCP servers. Inputs marked * are required. Full schemas and examples are in the <a href="/docs">docs</a>.
              </p>
            </div>
            <table className="hp-table" style={{ marginTop: 0 }}>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Route</th>
                  <th>Inputs</th>
                  <th style={{ textAlign: "right" }}>USDC per call</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((r) => (
                  <tr key={r.path}>
                    <td className="r">{r.tool}</td>
                    <td>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)" }}>{r.methods.join("/")}</span>{" "}
                      <code>{r.path}</code>
                      <br />
                      <span style={{ fontSize: 13 }}>{r.summary}</span>
                    </td>
                    <td className="m">{r.inputs.length ? r.inputs.map((i) => `${i.name}${i.required ? "*" : ""}`).join(", ") : "none"}</td>
                    <td className="p">{r.priceUsd}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
