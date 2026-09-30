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
function restChallenge(route, q = "") {
  return fetch(`${BASE}/api/${route.replace(/_/g, "-")}${q}`).then((r) => {
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
  screenshot: { url: "https://example.com" },
};
const Q = { portfolio: "?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", fetch: "?url=https://example.com", http: "?url=https://example.com", extract: "?url=https://example.com", x402_check: "?url=https://horizonpulse.dev/api/pulse", screenshot: "?url=https://example.com" };
let fail = 0;
const ok = (c, msg) => { console.log(`${c ? "PASS" : "FAIL"} ${msg}`); if (!c) fail++; };

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
ok(init.status === 200 && init.json.result?.serverInfo?.name === "horizon-pulse", "initialize is free");
const list = await rpc("tools/list", {});
const names = (list.json.result?.tools || []).map((t) => t.name).sort();
ok(JSON.stringify(names) === JSON.stringify(["extract","fetch","funding","gas","http","portfolio","pulse","screenshot","signals","x402_check","yield"]), `tools/list free, 11 tools: ${names.join(",")}`);

for (const name of names) {
  const r = await rpc("tools/call", { name, arguments: ARGS[name] || {} });
  const res = r.json.result || {};
  const text = (res.content || []).map((c) => c.text).join("");
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
