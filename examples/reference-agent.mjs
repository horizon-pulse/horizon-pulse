#!/usr/bin/env node
/**
 * Horizon Pulse reference agent (x402 v2 / Base).
 * Default: reads the live catalog from /openapi.json at runtime, then makes an unpaid 402 discovery probe of every
 * multi-network paid route (GET, required inputs from the OpenAPI examples) and checks the Base entry against the
 * OpenAPI price. Nothing is hard-coded except the pinned payTo and Base USDC, so prices cannot go stale.
 * Premium routes (x-premium-payment-info, Base USDC only) are listed, not probed or paid here.
 * Optional paid one-route: SMOKE_PRIVATE_KEY=0x... [SMOKE_ROUTE=/api/pulse]
 * Never paste private keys into chat, commits, or screenshots.
 */
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const EXPECTED_PAY_TO = "0x5b32c973596078a967562ca652761404f19be0e9";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_URL = (process.env.SMOKE_BASE_URL?.trim() || "https://horizonpulse.dev").replace(/\/$/, "");

/** Example value for a required query parameter, from the OpenAPI document. */
function paramExample(p) {
  return p.example ?? p.schema?.example ?? p.schema?.default ?? (Array.isArray(p.schema?.enum) ? p.schema.enum[0] : undefined);
}

/** Live catalog from /openapi.json: one GET probe per paid path (every multi-network route answers GET). */
async function loadCatalog() {
  const res = await fetch(`${BASE_URL}/openapi.json`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /openapi.json -> ${res.status}`);
  const spec = await res.json();
  const routes = [];
  const premium = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (op?.["x-premium-payment-info"]) premium.push({ method: method.toUpperCase(), path, priceUsd: op["x-premium-payment-info"].priceUsd });
    }
    const op = item.get;
    const pay = op?.["x-payment-info"];
    if (!pay) continue;
    const qs = new URLSearchParams();
    for (const p of op.parameters ?? []) {
      if (p.in !== "query" || !p.required) continue;
      const v = paramExample(p);
      if (v !== undefined) qs.set(p.name, typeof v === "string" ? v : JSON.stringify(v));
    }
    const q = qs.toString();
    routes.push({ path: q ? `${path}?${q}` : path, label: path, priceUsd: pay.priceUsd, atomic: String(pay.amount) });
  }
  return { routes, premium };
}

let ROUTES = [];

function norm(a) {
  return (a || "").trim().toLowerCase();
}

function snippet(v, max = 400) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function decodeRequired(res, body) {
  const core = new x402Client();
  const http = new x402HTTPClient(core);
  return http.getPaymentRequiredResponse((n) => res.headers.get(n), body);
}

async function unpaidProbe(route) {
  const url = `${BASE_URL}${route.path}`;
  const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const label = route.label || route.path;
  if (res.status !== 402) {
    return { label, ok: false, status: res.status, error: `expected 402, got ${res.status}`, body };
  }
  let paymentRequired;
  try {
    paymentRequired = decodeRequired(res, body);
  } catch (e) {
    return { label, ok: false, status: 402, error: `decode failed: ${e?.message || e}` };
  }
  // The 402 lists one entry per network; check the Base USDC entry.
  const acc = (paymentRequired?.accepts ?? []).find((a) => String(a.network) === "eip155:8453") ?? paymentRequired?.accepts?.[0];
  if (!acc) return { label, ok: false, status: 402, error: "missing Base accepts entry" };
  const amount = String(acc.maxAmountRequired ?? acc.amount ?? acc.maxAmount ?? "");
  const payTo = norm(acc.payTo);
  const asset = norm(acc.asset);
  const network = String(acc.network || "");
  const wire = res.headers.get("PAYMENT-REQUIRED") || res.headers.get("payment-required") ? "PAYMENT-REQUIRED" : "body";
  const checks = {
    payTo: payTo === EXPECTED_PAY_TO,
    amount: amount === route.atomic,
    asset: asset === norm(USDC_BASE),
    network: network === "eip155:8453" || network === "base",
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    label,
    ok,
    status: 402,
    payTo: acc.payTo,
    amount,
    priceUsd: route.priceUsd,
    network: acc.network,
    asset: acc.asset,
    scheme: acc.scheme,
    x402Version: paymentRequired.x402Version,
    wire,
    checks,
    paymentRequired,
  };
}

async function paidOne(routePath, pk) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error("SMOKE_PRIVATE_KEY must be 0x + 64 hex chars");
  }
  const route =
    ROUTES.find((r) => (r.label || r.path.split("?")[0]) === routePath) ||
    ROUTES.find((r) => r.path === routePath) ||
    ROUTES[0];
  const url = `${BASE_URL}${route.path}`;
  const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
  console.log(`\n--- Paid single-route: ${route.label || route.path} ---`);
  console.log(`payer: ${account.address}`);
  console.log(`GET   ${url}`);

  const unpaid = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  const unpaidText = await unpaid.text();
  let unpaidBody;
  try {
    unpaidBody = JSON.parse(unpaidText);
  } catch {
    unpaidBody = unpaidText;
  }
  if (unpaid.status !== 402) throw new Error(`unpaid expected 402, got ${unpaid.status}`);

  const core = new x402Client();
  registerExactEvmScheme(core, { signer: account });
  const http = new x402HTTPClient(core);
  const paymentRequired = http.getPaymentRequiredResponse((n) => unpaid.headers.get(n), unpaidBody);
  const payload = await http.createPaymentPayload(paymentRequired);
  const headers = http.encodePaymentSignatureHeader(payload);

  const paid = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", ...headers },
  });
  const paidText = await paid.text();
  let paidBody;
  try {
    paidBody = JSON.parse(paidText);
  } catch {
    paidBody = paidText;
  }
  let settlement = null;
  try {
    settlement = http.getPaymentSettleResponse((n) => paid.headers.get(n));
  } catch { /* none */ }
  console.log(`HTTP  ${paid.status}`);
  if (settlement) console.log(`settle ${snippet(settlement, 300)}`);
  console.log(`body  ${snippet(paidBody, 600)}`);
  if (paid.status !== 200) throw new Error(`paid expected 200, got ${paid.status}`);
  console.log("PAID OK");
}

async function main() {
  console.log("=== Horizon Pulse reference agent ===");
  console.log(`host:  ${BASE_URL}`);
  console.log(`payTo: ${EXPECTED_PAY_TO} (Base; pinned, compared with every 402)`);
  console.log(`USDC:  ${USDC_BASE} · network eip155:8453`);
  const catalog = await loadCatalog();
  ROUTES = catalog.routes;
  console.log(`catalog: ${ROUTES.length} multi-network routes from ${BASE_URL}/openapi.json`);
  for (const p of catalog.premium) console.log(`premium (Base USDC only, not probed here): ${p.method} ${p.path} ${p.priceUsd}`);
  console.log(`mode:  unpaid × ${ROUTES.length}` + (process.env.SMOKE_PRIVATE_KEY ? " + paid" : " (set SMOKE_PRIVATE_KEY to pay)"));
  const results = [];
  for (const route of ROUTES) {
    process.stdout.write(`\n[probe] ${route.label || route.path} … `);
    try {
      const r = await unpaidProbe(route);
      results.push(r);
      if (r.ok) {
        console.log(`402 OK · ${r.priceUsd} (${r.amount}) · ${r.wire} · v${r.x402Version}`);
      } else {
        console.log(`FAIL · ${r.error || JSON.stringify(r.checks)}`);
      }
    } catch (e) {
      const label = route.label || route.path;
      results.push({ label, ok: false, error: e?.message || String(e) });
      console.log(`ERROR · ${e?.message || e}`);
    }
  }

  console.log("\n--- Discovery summary ---");
  console.log(
    `${"route".padEnd(24)} ${"status".padEnd(8)} ${"amount".padEnd(10)} ${"payTo".padEnd(12)} ok`,
  );
  for (const r of results) {
    const amt = r.amount ?? "-";
    const pt = r.payTo ? `${String(r.payTo).slice(0, 8)}…` : "-";
    console.log(
      `${String(r.label).padEnd(24)} ${String(r.status ?? "err").padEnd(8)} ${String(amt).padEnd(10)} ${pt.padEnd(12)} ${r.ok ? "yes" : "NO"}`,
    );
  }
  const allOk = results.every((r) => r.ok);
  console.log(allOk ? `\nDISCOVERY PASS — all ${results.length} routes return a 402 matching /openapi.json` : "\nDISCOVERY FAIL — see probes above");

  const pk = process.env.SMOKE_PRIVATE_KEY?.trim();
  if (pk) {
    const route = process.env.SMOKE_ROUTE?.trim() || "/api/pulse";
    await paidOne(route, pk);
  } else {
    console.log("\n(no SMOKE_PRIVATE_KEY — skipped paid call; discovery-only is complete)");
  }

  if (!allOk) process.exit(1);
}

main().catch((e) => {
  console.error(`\nFATAL: ${e?.message || e}`);
  process.exit(1);
});
