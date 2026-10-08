/**
 * Agent skill (served at /skill.md) and shared agent-integration snippets
 * (rendered on /agents). Routes, prices and inputs are read from
 * public/openapi.json, which scripts/gen-openapi.ts generates from the live
 * route configs, so this never drifts from what the 402s charge.
 * Docs only: no payment logic.
 */
import fs from "node:fs";
import path from "node:path";
import { CONTACT_EMAIL, DEFAULT_PAY_TO, GITHUB_REPO, PUBLIC_BASE_URL, USDC_BASE } from "./config";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export type SkillRoute = {
  tool: string;
  demo: string;
  path: string;
  methods: string[];
  priceUsd: string;
  amount: string;
  summary: string;
  inputs: { name: string; required: boolean }[];
};

export function loadSkillRoutes(): SkillRoute[] {
  const spec: Json = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public", "openapi.json"), "utf8"));
  const out: SkillRoute[] = [];
  for (const [p, item] of Object.entries<Json>(spec.paths)) {
    const methods = ["get", "post"].filter((m) => item[m]?.["x-payment-info"]);
    if (!methods.length) continue;
    const op = item[methods[0]];
    const pay = op["x-payment-info"];
    const inputs = new Map<string, boolean>();
    for (const m of methods) {
      for (const prm of item[m].parameters ?? []) inputs.set(prm.name, Boolean(prm.required) || Boolean(inputs.get(prm.name)));
      const body = item[m].requestBody?.content?.["application/json"]?.schema;
      for (const k of Object.keys(body?.properties ?? {})) inputs.set(k, (body.required ?? []).includes(k) || Boolean(inputs.get(k)));
    }
    const demo = p.replace(/^\/api\//, "");
    out.push({
      tool: demo.replace(/[^a-zA-Z0-9]+/g, "_"),
      demo,
      path: p,
      methods: methods.map((m) => m.toUpperCase()),
      priceUsd: pay.priceUsd,
      amount: pay.amount,
      summary: op.summary,
      inputs: [...inputs].map(([name, required]) => ({ name, required })),
    });
  }
  return out;
}

export const MCP_INSTALL = `git clone ${GITHUB_REPO}.git
cd horizon-pulse/mcp
npm install   # installs pinned deps (@x402/core + @x402/evm 2.27.0) and builds dist/`;

export const MCP_CONFIG = `{
  "mcpServers": {
    "horizon-pulse": {
      "command": "node",
      "args": ["/absolute/path/to/horizon-pulse/mcp/dist/index.js"],
      "env": {
        "HP_PRIVATE_KEY": "0x...key of a dedicated, low-balance buyer wallet",
        "HP_MAX_USD_PER_CALL": "0.05",
        "HP_MAX_USD_TOTAL": "1"
      }
    }
  }
}`;

export const HOSTED_MCP_CONFIG = `{
  "mcpServers": {
    "horizon-pulse": { "url": "${PUBLIC_BASE_URL}/mcp" }
  }
}`;

export const PAY_STEPS = [
  { t: "Call", d: "Send the request with no payment header. Paid routes answer HTTP 402." },
  { t: "Read the challenge", d: "Base64-decode the PAYMENT-REQUIRED response header (x402 v2 JSON). The 402 body is empty JSON {}." },
  { t: "Check it", d: `Pay only if scheme is exact, network is eip155:8453 (Base), asset is USDC ${USDC_BASE}, payTo is ${DEFAULT_PAY_TO} and amount matches the listed price.` },
  { t: "Sign", d: "Sign an EIP-3009 transferWithAuthorization for that USDC amount to payTo with an x402 client library. No gas, no on-chain transaction from you." },
  { t: "Retry", d: "Send the identical request again with the PAYMENT-SIGNATURE header (x402 v2). X-PAYMENT is the legacy v1 header; do not rely on it." },
  { t: "Use the result", d: "200 returns the JSON plus a PAYMENT-RESPONSE receipt header. Settlement happens only after the route succeeds; error responses are not charged." },
];

export function buildSkillMarkdown(): string {
  const routes = loadSkillRoutes();
  const row = (r: SkillRoute) =>
    `| \`${r.tool}\` | ${r.methods.join("/")} | \`${r.path}\` | ${r.priceUsd} | ${r.amount} | ${r.inputs.length ? r.inputs.map((i) => (i.required ? `\`${i.name}\`*` : `\`${i.name}\``)).join(", ") : "none"} | ${r.summary} |`;
  const prices = routes.map((r) => Number(r.amount));
  const fmt = (a: number) => `$${a / 1e6}`;

  return `---
name: horizon-pulse
description: Call Horizon Pulse pay-per-call APIs at ${PUBLIC_BASE_URL} and pay each request in USDC on Base with x402 v2 (no signup or API key). Use when you need web search with sources, a web page as clean text, structured page fields, a page screenshot, PDF text, a proxied HTTP request, an x402 endpoint audit, or crypto data (spot prices, indicators, perp funding, gas, DeFi yields, wallet holdings).
---

# Horizon Pulse: pay-per-call APIs for agents (x402 v2, USDC on Base)

${routes.length} paid routes, ${fmt(Math.min(...prices))} to ${fmt(Math.max(...prices))} per call. Every call is paid individually with an x402 v2 \`exact\` payment in USDC on Base mainnet. No account, no API key.

- Base URL: ${PUBLIC_BASE_URL} (call and pay this host only)
- Network: Base mainnet, CAIP-2 \`eip155:8453\`
- Asset: USDC \`${USDC_BASE}\` (6 decimals; 10000 atomic = $0.01)
- payTo: \`${DEFAULT_PAY_TO}\` (the only address to pay)
- Facilitator: Coinbase CDP (verifies the payment, settles it only after the route succeeds)

## 1. Discover

- \`GET ${PUBLIC_BASE_URL}/.well-known/x402\`: x402 resource list (\`METHOD URL\` strings)
- \`GET ${PUBLIC_BASE_URL}/openapi.json\`: OpenAPI 3.1, typed inputs, response examples, per-operation \`x-payment-info\` (price, asset, network, payTo)
- \`GET ${PUBLIC_BASE_URL}/llms.txt\`: plain-text catalog and rules
- \`GET ${PUBLIC_BASE_URL}/api/demo/{route}\`: free sample of a route's real output on a fixed input (no payment)

## 2. Pick a route

\`*\` = required input. GET routes take query parameters; POST routes take a JSON body.

| Tool | Method | Path | Price (USDC) | Atomic | Inputs | What it returns |
| --- | --- | --- | --- | --- | --- | --- |
${routes.map(row).join("\n")}

Rules of thumb: research a question with sources → \`/api/search\`; read one page → \`/api/fetch\`; specific values from a page → \`/api/extract\` with \`fields\`; call any public API with your own method/headers/body → \`/api/http\`; PDF → \`/api/pdf\`; check an unknown x402 endpoint before paying it → \`/api/x402-check\`.

## 3. Pay and call (x402 v2)

1. **Call** the route with no payment header, e.g. \`GET ${PUBLIC_BASE_URL}/api/pulse\`. Expect \`HTTP 402\`.
2. **Read the challenge**: base64-decode the \`PAYMENT-REQUIRED\` response header and parse it as JSON. The 402 body is \`{}\`. Shape: \`{ x402Version: 2, resource: {url, description, ...}, accepts: [{ scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra: { name: "USD Coin", version: "2" } }] }\`.
3. **Check it before paying.** Pay only if \`scheme\` is \`exact\`, \`network\` is \`eip155:8453\`, \`asset\` is \`${USDC_BASE}\`, \`payTo\` is \`${DEFAULT_PAY_TO}\` and \`amount\` equals the atomic price in the table. If anything differs, do not pay.
4. **Sign** an EIP-3009 \`transferWithAuthorization\` for exactly \`amount\` to \`payTo\` (USDC EIP-712 domain: name "USD Coin", version "2", chainId 8453), valid for at most \`maxTimeoutSeconds\`. Use an x402 client library rather than hand-rolling it (Node: \`@x402/core\` + \`@x402/evm\`; Python: \`x402\`). The payer needs USDC on Base; no ETH or gas is needed.
5. **Retry** the identical request (same method, URL and body) with header \`PAYMENT-SIGNATURE: {base64 JSON payment payload}\`. This is the x402 v2 header; \`X-PAYMENT\` is the legacy v1 header and is not the settle path here.
6. **Use the result**: \`200\` returns the route's JSON. The \`PAYMENT-RESPONSE\` header is a base64 JSON receipt \`{ success, transaction, network, payer }\`.
7. **If you get 402 again**, decode \`PAYMENT-REQUIRED\` and read \`error\` (for example an insufficient USDC balance). Do not retry in a loop.

Optional: \`OPTIONS {route}\` returns the same challenge without charging.

### Node (official x402 client, v2)

\`\`\`js
// npm i @x402/core@2.27.0 @x402/evm@2.27.0 viem
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY); // dedicated low-balance wallet
const http = new x402HTTPClient(
  x402Client.fromConfig({
    schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
    policies: [(v, reqs) => reqs.filter((r) => r.payTo.toLowerCase() === "${DEFAULT_PAY_TO}")],
    spendControls: { maxAmountPerPayment: "$0.05" },
  }),
);

const url = "${PUBLIC_BASE_URL}/api/pulse";
const r1 = await fetch(url);                                   // 402
const challenge = http.getPaymentRequiredResponse((h) => r1.headers.get(h), await r1.json());
const payload = await http.createPaymentPayload(challenge);    // signs EIP-3009
const r2 = await fetch(url, { headers: http.encodePaymentSignatureHeader(payload) });
console.log(r2.status, await r2.json());
console.log(http.getPaymentSettleResponse((h) => r2.headers.get(h))); // receipt
\`\`\`

## 4. Or use the MCP server

**Local stdio MCP server (pays for you, with caps).** Exposes every route above as a tool (same names as the Tool column) plus free \`catalog\`, \`quote\` and \`demo\` tools. It reads the live catalog from \`/openapi.json\`, pays only \`${DEFAULT_PAY_TO}\` in Base USDC, refuses any amount above the listed price, and enforces \`HP_MAX_USD_PER_CALL\` (default $0.05) and \`HP_MAX_USD_TOTAL\` per session (default $1). Without \`HP_PRIVATE_KEY\` it only quotes and never pays.

\`\`\`sh
${MCP_INSTALL}
\`\`\`

\`\`\`json
${MCP_CONFIG}
\`\`\`

Source and full README: ${GITHUB_REPO}/tree/main/mcp

**Hosted MCP** (\`${PUBLIC_BASE_URL}/mcp\`, streamable HTTP, stateless): \`initialize\` and \`tools/list\` are free; \`tools/call\` returns the same x402 challenge as REST, so it needs an MCP client that can pay x402.

## 5. Errors and billing

- You pay only for a successful response. Errors return \`{ "ok": false, "error": "...", "code": "..." }\` and are not charged: 400 bad input, 413 too large, 415 wrong content type, 422 nothing usable, 404 no search results, 502 upstream failure, 503 provider unavailable, 504 timeout.
- Exceptions: \`/api/http\` returns upstream 4xx/5xx as data (charged); \`/api/x402-check\` bills any HTTP answer from the target.

## 6. Safety rules

- Call and pay only \`${PUBLIC_BASE_URL}\`. Never pay a \`payTo\` other than \`${DEFAULT_PAY_TO}\`.
- Use a dedicated buyer wallet holding only a small USDC balance, and a per-call cap. Never put a private key in a prompt, a tool argument, a URL or a log.
- Check the price with a free \`/api/demo/{route}\` sample or the unpaid 402 before paying; do not invent routes or prices.

Contact: ${CONTACT_EMAIL}
`;
}
