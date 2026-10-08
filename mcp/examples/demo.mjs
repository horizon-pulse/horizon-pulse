#!/usr/bin/env node
// Horizon Pulse agent demo: DRY RUN. It never signs and never pays.
//
// It starts from nothing but a domain name, discovers the paid routes, then
// drives the local MCP server (catalog → quote → a paid tool) with HP_DRY_RUN=1
// and no private key. It prints the real HTTP 402 requirements the API returns
// and the exact EIP-3009 authorization an x402 client WOULD sign, plus the cap
// checks. No key is loaded, nothing is signed, nothing is sent on-chain.
//
// Usage (from the repo's mcp/ folder, after `npm install`):
//   node examples/demo.mjs [domain]        # default: horizonpulse.dev
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decodePaymentRequiredHeader } from "@x402/core/http";

const DOMAIN = (process.argv[2] || "horizonpulse.dev").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const BASE = `https://${DOMAIN}`;
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
// Pins this demo checks against. The MCP server has the same pins in src/config.ts.
const PINNED_PAY_TO = "0x5b32c973596078a967562ca652761404f19be0e9";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_CAIP2 = "eip155:8453";
const CAP_PER_CALL_ATOMIC = 50_000n; // $0.05, the MCP server default (HP_MAX_USD_PER_CALL)
const SESSION_BUDGET_ATOMIC = 1_000_000n; // $1, the MCP server default (HP_MAX_USD_TOTAL)

const usd = (a) => `$${(Number(a) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00")}`;
const h = (t) => console.log(`\n=== ${t} ===`);
const check = (ok, label) => console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);

console.log("DRY RUN: this demo never signs and never pays. No private key is loaded.");
console.log(`Start: only the domain "${DOMAIN}"  (${new Date().toISOString()})`);

// 1. Discovery from the domain alone.
h("1. Discover routes from the domain");
const wk = await (await fetch(`${BASE}/.well-known/x402`)).json();
console.log(`GET ${BASE}/.well-known/x402 → ${wk.resources.length} paid operations`);
for (const r of wk.resources) console.log(`  ${r}`);
const llms = await (await fetch(`${BASE}/llms.txt`)).text();
const llmsPayTo = (llms.match(/payTo:\s*`(0x[0-9a-fA-F]{40})`/) || [])[1];
const llmsMcp = (llms.match(/POST `\/mcp`[^\n]*/) || [""])[0];
console.log(`GET ${BASE}/llms.txt → published payTo ${llmsPayTo}`);
console.log(`  ${llmsMcp.slice(0, 120)}`);
const skill = await fetch(`${BASE}/skill.md`);
const skillText = await skill.text();
console.log(`GET ${BASE}/skill.md → HTTP ${skill.status}, ${skillText.split("\n").length} lines (pay flow + safety checks)`);
check(llmsPayTo?.toLowerCase() === PINNED_PAY_TO, `llms.txt payTo equals the MCP server's hardcoded payTo ${PINNED_PAY_TO}`);

// 2. MCP server: catalog → quote → paid tool, in dry-run mode with no key.
h("2. Local MCP server (stdio), HP_DRY_RUN=1, no HP_PRIVATE_KEY");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HP_BASE_URL: BASE, HP_DRY_RUN: "1" },
  stderr: "ignore",
});
const mcp = new Client({ name: "horizon-pulse-demo", version: "0.1.0" });
await mcp.connect(transport);
const { tools } = await mcp.listTools();
console.log(`tools/list → ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

const cat = JSON.parse((await mcp.callTool({ name: "catalog", arguments: {} })).content[0].text);
console.log(`catalog → ${cat.routes.length} routes from ${cat.catalogSource}; mode: ${cat.payment.mode}; payTo ${cat.payment.expectedPayTo}; caps ${cat.payment.maxUsdPerCall}/call, ${cat.payment.sessionBudgetUsd}/session`);
for (const r of cat.routes) console.log(`  ${r.tool.padEnd(11)} ${r.method.padEnd(4)} ${r.path.padEnd(16)} ${r.priceUsd}`);

const q = JSON.parse((await mcp.callTool({ name: "quote", arguments: { route: "pulse" } })).content[0].text);
console.log(`quote pulse → HTTP ${q.status}, result "${q.result}", ${q.paymentRequired?.accepts?.[0]?.priceUsd}, wouldPayWithCurrentConfig=${q.wouldPayWithCurrentConfig}`);

const paidTool = await mcp.callTool({ name: "pulse", arguments: {} });
const metaLine = paidTool.content.map((c) => c.text || "").find((t) => t.startsWith("horizon-pulse: "));
const meta = metaLine ? JSON.parse(metaLine.slice("horizon-pulse: ".length)) : {};
console.log(`tools/call pulse → result "${meta.result}" (not paid). Server says: ${meta.message}`);
console.log(`session spend after the dry run: ${meta.session?.spentUsd} of ${meta.session?.budgetUsd}`);
await mcp.close();

// 3. The real 402 straight from the API (same request the MCP server made).
h("3. Real HTTP 402 from GET /api/pulse (unpaid)");
const r402 = await fetch(`${BASE}/api/pulse`, { headers: { accept: "application/json" } });
const prHeader = r402.headers.get("payment-required");
const pr = decodePaymentRequiredHeader(prHeader);
const a = pr.accepts[0];
console.log(`HTTP ${r402.status}; PAYMENT-REQUIRED header: ${prHeader.length} chars base64, decoded:`);
console.log(JSON.stringify({ x402Version: pr.x402Version, resource: pr.resource?.url, accepts: pr.accepts.map(({ scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra }) => ({ scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra })) }, null, 2));

// 4. Cap checks, then the exact authorization an x402 client WOULD sign.
h("4. Checks before signing");
const amount = BigInt(a.amount);
const advertised = BigInt(cat.routes.find((r) => r.tool === "pulse").amountAtomic);
check(a.scheme === "exact", `scheme "${a.scheme}" is exact`);
check(a.network === BASE_CAIP2, `network ${a.network} is Base mainnet`);
check(a.asset.toLowerCase() === USDC_BASE.toLowerCase(), `asset ${a.asset} is Base USDC`);
check(a.payTo.toLowerCase() === PINNED_PAY_TO, `payTo ${a.payTo} equals the pinned payTo`);
check(amount <= advertised, `amount ${a.amount} (${usd(amount)}) ≤ advertised price ${advertised} in /openapi.json`);
check(amount <= CAP_PER_CALL_ATOMIC, `amount ${usd(amount)} ≤ per-call cap ${usd(CAP_PER_CALL_ATOMIC)}`);
check(amount <= SESSION_BUDGET_ATOMIC, `amount ${usd(amount)} ≤ remaining session budget ${usd(SESSION_BUDGET_ATOMIC)}`);

h("5. What WOULD be signed (EIP-712 TransferWithAuthorization), NOT SIGNED");
const now = Math.floor(Date.now() / 1000);
const typedData = {
  domain: { name: a.extra?.name, version: a.extra?.version, chainId: 8453, verifyingContract: a.asset },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: {
    from: "<your buyer wallet address>",
    to: a.payTo,
    value: a.amount,
    validAfter: "0", // @x402/evm 2.27.0 v2 exact client uses 0
    validBefore: String(now + Number(a.maxTimeoutSeconds)),
    nonce: `0x${randomBytes(32).toString("hex")}`,
  },
};
console.log(JSON.stringify(typedData, null, 2));
console.log(`\nWith a key, the client would sign this, retry GET /api/pulse with a PAYMENT-SIGNATURE header, and pay ${usd(amount)} USDC on Base only if the route succeeds.`);
console.log("DRY RUN complete: nothing was signed, nothing was sent, no payment happened.");
