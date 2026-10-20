// Test: MCP initialize + tools/list are free; tools/call without payment
// returns ONLY the x402 challenge (no data), with the same accepts as REST.
// Usage: node scripts/mcp-unpaid-test.mjs http://localhost:3000
const BASE = process.argv[2] || "http://localhost:3000";
const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
let id = 0;
async function rpc(method, params) {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  return { status: r.status, json: await r.json() };
}
function restPath(route) {
  if (route === "x402_check_deep") return "x402-check/deep"; // tier nested under its parent route
  // Nested REST namespaces keep a slash (market/*, discourse/*, grocery/*, chain/*, token/*, name/*).
  // Flat tool names map underscores to hyphens (bazaar-check, tx-guard, ...).
  if (/^(market|discourse|grocery|chain|token|name)_/.test(route)) return route.replace("_", "/");
  return route.replace(/_/g, "-");
}
function restChallenge(route, q = "") {
  return fetch(`${BASE}/api/${restPath(route)}${q}`).then((r) => {
    const h = r.headers.get("payment-required");
    return { status: r.status, pr: h ? JSON.parse(Buffer.from(h, "base64").toString()) : null };
  });
}
const ARGS = {
  portfolio: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
  fetch: { url: "https://example.com" },
  http: { url: "https://example.com" },
  extract: { url: "https://example.com" },
  x402_check: { url: "https://horizonpulse.dev/api/pulse" },
  x402_check_deep: { url: "https://horizonpulse.dev/api/pulse" },
  bazaar_check: { url: "horizonpulse.dev" },
  market_search: { q: "weather forecast" },
  market_quote: { url: "https://horizonpulse.dev/api/pulse" },
  screenshot: { url: "https://example.com" },
  search: { q: "x402" },
  pdf: { url: "https://horizonpulse.dev/sample.pdf" },
  discourse_split: { q: "self-driving cars" },
  tokenized_stock: { symbol: "AAPL" },
  watch: { url: "https://example.com" },
  balance: { evm: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
  grocery_normalize: { ingredients: ["2 cups flour"] },
  grocery_ingredient: { items: [{ q: "egg" }] },
  chain_head: { network: "base" },
  token_meta: { network: "base", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  name_resolve: { name: "vitalik.eth" },
  batch: { items: [{ route: "gas" }] },
  tx_guard: { chain: "base", to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
  tx_status: { network: "base", tx: "0xe6e6ebd93db6735aad12a86a1084d5e1d6759e31fbedf7b741946f2bf410644f" },
};
const Q = { batch: "?items=%5B%7B%22route%22%3A%22gas%22%7D%5D", chain_head: "?network=base", token_meta: "?network=base&token=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name_resolve: "?name=vitalik.eth", grocery_ingredient: "?q=egg", grocery_normalize: "?ingredients=2%20cups%20flour", portfolio: "?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", fetch: "?url=https://example.com", http: "?url=https://example.com", extract: "?url=https://example.com", x402_check: "?url=https://horizonpulse.dev/api/pulse", x402_check_deep: "?url=https://horizonpulse.dev/api/pulse", bazaar_check: "?url=horizonpulse.dev", market_search: "?q=weather%20forecast", market_quote: "?url=https://horizonpulse.dev/api/pulse", screenshot: "?url=https://example.com", search: "?q=x402", pdf: "?url=https://horizonpulse.dev/sample.pdf", discourse_split: "?q=tabs%20or%20spaces" , tokenized_stock: "?symbol=AAPL", watch: "?url=https://example.com", balance: "?evm=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", tx_guard: "?chain=base&to=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", tx_status: "?network=base&tx=0xe6e6ebd93db6735aad12a86a1084d5e1d6759e31fbedf7b741946f2bf410644f" };
let fail = 0;
const ok = (c, msg) => { console.log(`${c ? "PASS" : "FAIL"} ${msg}`); if (!c) fail++; };

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
ok(init.status === 200 && init.json.result?.serverInfo?.name === "horizon-pulse", "initialize is free");
const list = await rpc("tools/list", {});
const names = (list.json.result?.tools || []).map((t) => t.name).sort();
const EXPECTED = ["balance","batch","bazaar_check","chain_head","discourse_split","extract","fetch","funding","gas","grocery_ingredient","grocery_normalize","http","market_quote","market_search","name_resolve","pdf","portfolio","pulse","screenshot","search","signals","token_meta","tokenized_stock","tx_guard","tx_status","watch","x402_check","x402_check_deep","yield"];
// FREE tools (no x402 wrapper): listed, never challenged; not part of the paid count.
const FREE = ["money_market_rates"];
// QUOTE tools (no x402 wrapper): return the premium route's unpaid 402 as data; never run or pay (lib/mcp-server VERIFIED_BRIEF_TOOL).
const QUOTE = { verified_brief_quote: { args: { q: "What is the current Base gas price?", type: "base_gas" }, rest: "/api/research/report/brief?q=What%20is%20the%20current%20Base%20gas%20price%3F&type=base_gas" } };
EXPECTED.push(...FREE, ...Object.keys(QUOTE));
const missing = EXPECTED.filter((n) => !names.includes(n)), extra = names.filter((n) => !EXPECTED.includes(n));
ok(!missing.length && !extra.length, `tools/list free, ${EXPECTED.length} tools expected (${EXPECTED.length - FREE.length - Object.keys(QUOTE).length} paid + ${Object.keys(QUOTE).length} quote + ${FREE.length} free), got ${names.length}${missing.length ? `; missing ${missing}` : ""}${extra.length ? `; not in this script (stale copy? update ARGS/Q/EXPECTED): ${extra}` : ""}`);
const schemas = Object.fromEntries((list.json.result?.tools || []).map((t) => [t.name, t.inputSchema || {}]));

for (const name of names) {
  if (FREE.includes(name)) {
    const r = await rpc("tools/call", { name, arguments: { rates: "SOFR" } });
    const text = ((r.json.result || {}).content || []).map((c) => c.text).join("");
    ok(!/"x402Version"/.test(text) && !/"accepts"/.test(text), `${name}: free tool returns no x402 challenge`);
    continue;
  }
  if (QUOTE[name]) {
    const r = await rpc("tools/call", { name, arguments: QUOTE[name].args });
    const text = ((r.json.result || {}).content || []).map((c) => c.text).join("");
    let o = {}; try { o = JSON.parse(text); } catch {}
    const a = o.payment_required?.accepts?.[0] || {};
    const rr = await fetch(`${BASE}${QUOTE[name].rest}`);
    const h = rr.headers.get("payment-required");
    const b = h ? JSON.parse(Buffer.from(h, "base64").toString()).accepts?.[0] || {} : {};
    ok(o.status === 402 && !!o.payment_required && o.body?.verification === undefined && o.body?.sources === undefined, `${name}: quote only (unpaid 402 as data, no brief content)`);
    ok(rr.status === 402 && a.amount === b.amount && a.payTo === b.payTo && a.network === b.network && a.asset === b.asset && a.scheme === b.scheme,
       `${name}: quote matches REST (amount ${a.amount}/${b.amount}, payTo ${String(a.payTo).slice(-6)}, ${a.network})`);
    continue;
  }
  const need = (schemas[name].required || []).filter((k) => !(ARGS[name] && k in ARGS[name]));
  if (need.length) { ok(false, `${name}: no test args for required ${need} (add to ARGS and Q; tool not known to this script copy)`); continue; }
  const r = await rpc("tools/call", { name, arguments: ARGS[name] || {} });
  const res = r.json.result || {};
  const text = (res.content || []).map((c) => c.text).join("");
  if (/^MCP error -32602/.test(text)) { ok(false, `${name}: input validation error, not an x402 challenge (test ARGS invalid): ${text.slice(0, 160)}`); continue; }
  const sc = res.structuredContent || {};
  const pr = sc.accepts ? sc : (() => { try { return JSON.parse(text); } catch { return {}; } })();
  const noData = !/"ok"\s*:\s*true|"asOf"|"content"\s*:|"prices"/.test(text) && res.isError === true;
  ok(noData, `${name}: unpaid call returns isError with no data`);
  const a = pr.accepts?.[0] || {};
  const rest = await restChallenge(name, Q[name] || "");
  const b = rest.pr?.accepts?.[0] || {};
  ok(rest.status === 402 && a.amount === b.amount && a.payTo === b.payTo && a.network === b.network && a.asset === b.asset && a.scheme === b.scheme,
     `${name}: MCP challenge matches REST (amount ${a.amount}/${b.amount}, payTo ${String(a.payTo).slice(-6)}, ${a.network})`);
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
process.exit(fail ? 1 : 0);
