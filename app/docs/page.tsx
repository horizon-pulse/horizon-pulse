import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { CopyBlock } from "@/components/CopyBlock";
import { CODE } from "@/lib/client-snippets";
import { BASE_PAY_TO_BASENAME } from "@/lib/config";
import { SOLANA_MAINNET_CAIP2, SOLANA_PAYTO } from "@/lib/solana-config";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "API docs | Horizon Pulse",
  description: "Every Horizon Pulse route with its price, inputs, response example and a copyable x402 flow, rendered from /openapi.json.",
  alternates: { canonical: "/docs" },
};

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const spec: Json = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public", "openapi.json"), "utf8"));
const BASE = spec.servers[0].url as string;

type Op = { id: string; method: string; path: string; op: Json };
const ops: Op[] = [];
for (const [p, item] of Object.entries<Json>(spec.paths))
  for (const [m, op] of Object.entries<Json>(item)) ops.push({ id: op.operationId, method: m.toUpperCase(), path: p, op });
const groups = (spec.tags as { name: string; description: string }[]).map((t) => ({ ...t, ops: ops.filter((o) => o.op.tags[0] === t.name) }));

const typeOf = (s: Json): string => {
  if (!s) return "any";
  if (s.enum) return s.enum.join(" | ");
  const t = [s.type].flat().filter(Boolean).join(" | ") || "any";
  const range = s.minimum !== undefined || s.maximum !== undefined ? ` ${s.minimum ?? ""}–${s.maximum ?? ""}` : "";
  return t + range;
};

function trim(v: Json, depth = 0): Json {
  if (typeof v === "string") return v.length > 140 ? v.slice(0, 140) + "…" : v;
  if (Array.isArray(v)) return v.slice(0, 2).map((x) => trim(x, depth + 1)).concat(v.length > 2 ? [`… ${v.length - 2} more`] : []);
  if (v && typeof v === "object") {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) out[k] = depth > 3 ? "…" : trim(x, depth + 1);
    return out;
  }
  return v;
}

function curlFor(o: Op): string {
  if (o.method === "POST") {
    const body = JSON.stringify(o.op.requestBody?.content?.["application/json"]?.example ?? {});
    return `curl -i -X POST ${BASE}${o.path} \\\n  -H 'content-type: application/json' \\\n  -d '${body}'`;
  }
  const qs = (o.op.parameters ?? [])
    .filter((p: Json) => p.example !== undefined)
    .map((p: Json) => `${p.name}=${encodeURIComponent(String(p.example))}`)
    .join("&");
  return `curl -i '${BASE}${o.path}${qs ? `?${qs}` : ""}'`;
}

function Params({ o }: { o: Op }) {
  const rows: { name: string; required: boolean; type: string; desc: string }[] = [];
  for (const p of o.op.parameters ?? []) rows.push({ name: p.name, required: !!p.required, type: typeOf(p.schema), desc: p.description });
  const body = o.op.requestBody?.content?.["application/json"]?.schema;
  if (body) for (const [k, s] of Object.entries<Json>(body.properties ?? {})) rows.push({ name: k, required: (body.required ?? []).includes(k), type: typeOf(s), desc: s.description ?? "" });
  if (!rows.length) return <p style={{ margin: 0, color: "var(--text-2)", fontSize: 14 }}>No inputs. Call it as is.</p>;
  return (
    <table className="hp-params">
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td className="n">{r.name}{r.required && <i title="required">*</i>}</td>
            <td className="t">{r.type}</td>
            <td>{r.desc}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Operation({ o }: { o: Op }) {
  const pay = o.op["x-payment-info"];
  const example = o.op.responses["200"]?.content?.["application/json"]?.example;
  const desc = String(o.op.description).split("\n\n")[0];
  const errs = Object.entries<Json>(o.op.responses).filter(([c]) => c !== "200" && c !== "402");
  return (
    <article className="hp-op" id={o.id}>
      <div className="hp-op-h">
        <span className={`hp-meth ${o.method === "POST" ? "post" : ""}`}>{o.method}</span>
        <h3>{o.path}</h3>
        <span className="price">{pay.priceUsd}<small>USDC per call · {pay.amount} atomic</small></span>
      </div>
      <div className="hp-op-b">
        <p>{desc}</p>
        <div>
          <h5>Inputs</h5>
          <Params o={o} />
        </div>
        <div className="hp-op-cols">
          <CopyBlock title="Unpaid call (returns 402 with the price)" code={curlFor(o)} />
          {example ? (
            <div className="hp-code tall">
              <div className="hp-code-h"><span>200 response example (trimmed)</span></div>
              <pre>{JSON.stringify(trim(example), null, 2)}</pre>
            </div>
          ) : null}
        </div>
        {errs.length > 0 && (
          <div>
            <h5>Errors</h5>
            <div className="hp-errs">
              {errs.map(([c, r]) => (
                <span key={c}><b>{c}</b>{String(r.description).replace(/\.$/, "")}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

const FLOW = `# 1. Free sample of the real output, no payment
curl ${BASE}/api/demo/pulse

# 2. Unpaid call: HTTP 402 with the price in PAYMENT-REQUIRED (base64 JSON)
curl -si ${BASE}/api/pulse | grep -i '^payment-required' | cut -d' ' -f2 | base64 -d

# 3. Pay: an x402 client signs a USDC payment on Base or Solana (same price)
#    and retries with PAYMENT-SIGNATURE. You get 200 plus a PAYMENT-RESPONSE receipt.`;

export default function DocsPage() {
  const s = { ops: ops.length, routes: Object.keys(spec.paths).length };
  return (
    <div className="hp">
      <SiteHeader />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">API docs · OpenAPI {spec.openapi}</span>
            <h1>
              Every route.
              <br />
              <span>One payment flow.</span>
            </h1>
            <p className="hp-sub">
              {s.routes} paid routes and {s.ops} operations, paid per call in USDC on Base or Solana with x402. No signup or API key. This page is
              rendered from <code>/openapi.json</code>, so prices and inputs always match what the API charges.
            </p>
            <div className="hp-raw">
              <a className="hp-btn ghost sm" href="/openapi.json">OpenAPI, for agents (JSON)</a>
              <a className="hp-btn ghost sm" href="/.well-known/x402">x402 discovery, for agents (JSON)</a>
              <a className="hp-btn ghost sm" href="/llms.txt">llms.txt, for agents (text)</a>
              <a className="hp-btn ghost sm" href="/skill.md">skill.md, for agents (markdown)</a>
              <a className="hp-btn ghost sm" href="/agents">Agent guide + MCP</a>
            </div>
            <div className="hp-docs-index">
              {groups.map((g) => (
                <div key={g.name}>
                  <h4>{g.name}</h4>
                  {g.ops.map((o) => (
                    <a key={o.id} href={`#${o.id}`}>
                      {o.method === "POST" ? `POST ${o.path.slice(4)}` : o.path.slice(4)}
                      <span>{o.op["x-payment-info"].priceUsd}</span>
                    </a>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="hp-section" id="quickstart">
          <div className="hp-wrap">
            <div>
              <div className="hp-label">Quickstart</div>
              <h2>
                Call, see the price, <span>pay, retry.</span>
              </h2>
              <p className="hp-lead">
                You only pay for a successful response. Errors are not charged, apart from the exceptions noted on a route.
              </p>
            </div>
            <div style={{ marginTop: 36, display: "grid", gap: 16 }}>
              <CopyBlock title="The 402 flow with curl" code={FLOW} />
              <CopyBlock title={CODE.node.title} code={CODE.node.code} />
            </div>
            <div className="hp-grid" style={{ marginTop: 16 }}>
              <div className="hp-tile">
                <h3>Networks</h3>
                <p>
                  USDC with the x402 v2 <code>exact</code> scheme, same price on both: Base mainnet <code>eip155:8453</code> or Solana mainnet{" "}
                  <code style={{ wordBreak: "break-all" }}>{SOLANA_MAINNET_CAIP2}</code>.
                </p>
              </div>
              <div className="hp-tile">
                <h3>payTo</h3>
                <p style={{ wordBreak: "break-all" }}>Base <code>{ops[0].op["x-payment-info"].payTo}</code> (<code>{BASE_PAY_TO_BASENAME}</code>)</p>
                <p style={{ wordBreak: "break-all" }}>Solana <code>{SOLANA_PAYTO}</code></p>
              </div>
              <div className="hp-tile">
                <h3>Facilitator</h3>
                <p>Coinbase CDP on Base, PayAI on Solana. Each verifies the payment first and settles it only after the route succeeds.</p>
              </div>
            </div>
          </div>
        </section>

        {groups.map((g) => (
          <section className="hp-section" key={g.name} id={g.name.toLowerCase().replace(/\s+/g, "-")}>
            <div className="hp-wrap">
              <div>
                <div className="hp-label">Reference</div>
                <h2>{g.name}</h2>
                <p className="hp-lead">{g.description}</p>
              </div>
              {g.ops.map((o) => (
                <Operation key={o.id} o={o} />
              ))}
            </div>
          </section>
        ))}
      </main>
      <SiteFooter />
    </div>
  );
}
