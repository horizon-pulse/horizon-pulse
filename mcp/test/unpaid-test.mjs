// Horizon Pulse MCP wrapper test. NEVER pays real money:
//  - live section: no HP_PRIVATE_KEY, so the server can only quote/refuse.
//  - mock section: a local 127.0.0.1 server stands in for horizonpulse.dev;
//    the signing check uses private key = 1 (a trivially public constant) and
//    the signed authorization goes only to that mock (nothing is broadcast).
// Usage: node test/unpaid-test.mjs [liveBaseUrl]   (default https://horizonpulse.dev; pass "skip" to skip live)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, "..", "dist", "index.js");
const LIVE = process.argv[2] || "https://horizonpulse.dev";
const PAY_TO = "0x5b32c973596078a967562ca652761404f19be0e9";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Private key = 1: a trivially public constant (address 0x7E5F…5Bdf), used only to sign against the local mock.
const TEST_KEY_ONE = "0x" + "0".repeat(63) + "1";
const EXPECTED_TOOLS = ["bazaar_check", "catalog", "demo", "extract", "fetch", "funding", "gas", "http", "pdf", "portfolio", "pulse", "quote", "screenshot", "search", "signals", "x402_check", "yield"];

let fail = 0;
const ok = (c, msg) => { console.log(`${c ? "PASS" : "FAIL"} ${msg}`); if (!c) fail++; };

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "hp-mcp-test", version: "0" });
  await client.connect(transport);
  return client;
}
const meta = (res) => {
  const line = (res.content || []).map((c) => c.text || "").find((t) => t.startsWith("horizon-pulse: "));
  return line ? JSON.parse(line.slice("horizon-pulse: ".length)) : {};
};

// ---------- live (unpaid, no key) ----------
if (LIVE !== "skip") {
  console.log(`\n# live: ${LIVE} (no key)`);
  const c = await connect({ HP_BASE_URL: LIVE });
  const { tools } = await c.listTools();
  const names = tools.map((t) => t.name).sort();
  ok(JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), `tools/list: ${names.length} tools (${names.join(",")})`);
  const pulseTool = tools.find((t) => t.name === "pulse");
  ok(/\$0\.005 USDC per call/.test(pulseTool?.description ?? ""), "pulse description carries exact price $0.005");
  ok(tools.find((t) => t.name === "portfolio")?.inputSchema?.required?.includes("address"), "portfolio requires address");
  ok(tools.find((t) => t.name === "http")?.inputSchema?.properties?.headers, "http tool uses POST body schema (headers)");

  const cat = JSON.parse((await c.callTool({ name: "catalog", arguments: {} })).content[0].text);
  ok(cat.routes.length === 14 && cat.payment.mode.startsWith("quote-only") && cat.payment.buyerWallet === null, `catalog: 14 routes, quote-only, no wallet (source ${cat.catalogSource})`);

  const r = await c.callTool({ name: "pulse", arguments: {} });
  const m = meta(r);
  const a = m.paymentRequired?.accepts?.[0] ?? {};
  ok(r.isError === true && m.result === "quote" && m.status === 402, `pulse without key: refused to pay, result=${m.result}, status=${m.status}`);
  ok(a.amount === "5000" && a.payTo?.toLowerCase() === PAY_TO && a.network === "eip155:8453" && a.asset === USDC && a.extra?.name === "USD Coin", `pulse 402 parsed: amount ${a.amount} (${a.priceUsd}), payTo …${a.payTo?.slice(-6)}, ${a.network}, USDC`);
  ok(/No HP_PRIVATE_KEY/.test(m.message), "message explains no key configured");

  const q = JSON.parse((await c.callTool({ name: "quote", arguments: { route: "fetch", args: { url: "https://example.com" } } })).content[0].text);
  ok(q.status === 402 && q.paymentRequired?.accepts?.[0]?.amount === "20000" && q.wouldPayWithCurrentConfig === false, `quote fetch: 402, amount ${q.paymentRequired?.accepts?.[0]?.amount}, wouldPay=false`);

  const ext = await c.callTool({ name: "extract", arguments: { url: "https://example.com", fields: { h: "h1" } } });
  const em = meta(ext);
  ok(em.result === "quote" && em.route === "POST /api/extract" && em.paymentRequired?.accepts?.[0]?.amount === "15000", `extract (POST) without key: quote ${em.paymentRequired?.accepts?.[0]?.priceUsd}`);

  const d = await c.callTool({ name: "demo", arguments: { route: "pulse" } });
  ok(!d.isError && /"demo":\s*true/.test(d.content[0].text), "demo pulse: free sample returned (demo: true)");
  await c.close();

  console.log(`\n# live: per-call cap 0.001 (no key)`);
  const c2 = await connect({ HP_BASE_URL: LIVE, HP_MAX_USD_PER_CALL: "0.001" });
  const m2 = meta(await c2.callTool({ name: "pulse", arguments: {} }));
  ok(m2.result === "refused" && /HP_MAX_USD_PER_CALL/.test(m2.message), `over per-call cap: ${m2.result} — ${m2.message}`);
  await c2.close();

  console.log(`\n# live: session budget 0.001 (no key)`);
  const c3 = await connect({ HP_BASE_URL: LIVE, HP_MAX_USD_TOTAL: "0.001" });
  const m3 = meta(await c3.callTool({ name: "pulse", arguments: {} }));
  ok(m3.result === "refused" && /HP_MAX_USD_TOTAL/.test(m3.message), `over session budget: ${m3.result} — ${m3.message}`);
  await c3.close();
}

// ---------- mock (local only) ----------
console.log(`\n# mock: 127.0.0.1 stand-in`);
const openapi = fs.readFileSync(path.resolve(here, "..", "..", "public", "openapi.json"), "utf8");
let mode = { payTo: PAY_TO, amount: "5000", dropPaid: false };
let lastSig = null;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/openapi.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(openapi); }
  if (u.pathname === "/api/pulse") {
    const sig = req.headers["payment-signature"];
    if (sig) {
      lastSig = decodePaymentSignatureHeader(sig);
      if (mode.dropPaid) { req.socket.destroy(); return; } // simulate a lost response after the signed payment was sent
      const receipt = encodePaymentResponseHeader({ success: true, transaction: "0xmock", network: "eip155:8453", payer: lastSig.payload?.authorization?.from });
      res.writeHead(200, { "content-type": "application/json", "PAYMENT-RESPONSE": receipt });
      return res.end(JSON.stringify({ ok: true, mock: true }));
    }
    const pr = { x402Version: 2, error: "Payment required", resource: { url: `http://127.0.0.1/api/pulse`, description: "mock", mimeType: "application/json" }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: mode.amount, asset: USDC, payTo: mode.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] };
    res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) });
    return res.end("{}");
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const MOCK = `http://127.0.0.1:${srv.address().port}`;

mode = { payTo: "0x000000000000000000000000000000000000dEaD", amount: "5000" };
let c4 = await connect({ HP_BASE_URL: MOCK, HP_PRIVATE_KEY: TEST_KEY_ONE });
let m4 = meta(await c4.callTool({ name: "pulse", arguments: {} }));
ok(m4.result === "refused" && /payTo/.test(m4.message) && lastSig === null, `wrong payTo with key: refused, nothing signed — ${m4.message}`);

mode = { payTo: PAY_TO, amount: "9000" };
m4 = meta(await c4.callTool({ name: "pulse", arguments: {} }));
ok(m4.result === "refused" && /advertised price/.test(m4.message) && lastSig === null, `amount above advertised $0.005 with key: refused, nothing signed — ${m4.message}`);

mode = { payTo: PAY_TO, amount: "5000" };
const r5 = await c4.callTool({ name: "pulse", arguments: {} });
m4 = meta(r5);
const auth = lastSig?.payload?.authorization ?? {};
ok(m4.result === "paid" && m4.status === 200 && m4.settlement?.transaction === "0xmock", `valid challenge with key (mock): signed + retried, receipt decoded (${m4.settlement?.transaction})`);
ok(lastSig?.x402Version === 2 && String(auth.to).toLowerCase() === PAY_TO && auth.value === "5000" && lastSig?.accepted?.asset === USDC, `PAYMENT-SIGNATURE is x402 v2 EIP-3009: to …${String(auth.to).slice(-6)}, value ${auth.value}`);
ok(m4.session?.spentUsd === "$0.005", `session spend tracked: ${m4.session?.spentUsd}`);
await c4.close();

console.log(`\n# mock: signed payment sent, response lost (session budget 0.008)`);
mode = { payTo: PAY_TO, amount: "5000", dropPaid: true };
lastSig = null;
const c6 = await connect({ HP_BASE_URL: MOCK, HP_PRIVATE_KEY: TEST_KEY_ONE, HP_MAX_USD_TOTAL: "0.008" });
const m6 = meta(await c6.callTool({ name: "pulse", arguments: {} }));
ok(m6.result === "error" && lastSig !== null && /may have settled/.test(m6.message), `lost response after signing: error, signature was sent — ${m6.message}`);
ok(m6.session?.spentUsd === "$0.005", `lost-response payment counted as spent, not refunded: ${m6.session?.spentUsd}`);
mode = { payTo: PAY_TO, amount: "5000", dropPaid: false };
lastSig = null;
const m6b = meta(await c6.callTool({ name: "pulse", arguments: {} }));
ok(m6b.result === "refused" && /HP_MAX_USD_TOTAL/.test(m6b.message) && lastSig === null, `next call refused by the remaining $0.003 budget, nothing signed — ${m6b.message}`);
await c6.close();

console.log(`\n# mock: HP_EXPECTED_PAY_TO is ignored (payTo is hardcoded)`);
mode = { payTo: "0x000000000000000000000000000000000000dEaD", amount: "5000", dropPaid: false };
lastSig = null;
const c7 = await connect({ HP_BASE_URL: MOCK, HP_PRIVATE_KEY: TEST_KEY_ONE, HP_EXPECTED_PAY_TO: "0x000000000000000000000000000000000000dEaD" });
const m7 = meta(await c7.callTool({ name: "pulse", arguments: {} }));
ok(m7.result === "refused" && /payTo/.test(m7.message) && lastSig === null, `HP_EXPECTED_PAY_TO=0x…dEaD has no effect: refused, nothing signed`);
await c7.close();
mode = { payTo: PAY_TO, amount: "5000", dropPaid: false };

const c5 = await connect({ HP_BASE_URL: MOCK, HP_PRIVATE_KEY: TEST_KEY_ONE, HP_DRY_RUN: "1" });
lastSig = null;
const m5 = meta(await c5.callTool({ name: "pulse", arguments: {} }));
ok(m5.result === "quote" && lastSig === null, "HP_DRY_RUN=1 with key: quote only, nothing signed");
await c5.close();
srv.close();

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
process.exit(fail ? 1 : 0);
