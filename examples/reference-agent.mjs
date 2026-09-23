#!/usr/bin/env node
/**
 * Horizon Pulse reference agent (x402 v2 / Base).
 * Default: unpaid 402 discovery for all eight live paid routes on horizonpulse.dev.
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
const PORTFOLIO_DEMO = "0x5b32c973596078a967562ca652761404f19be0e9";

/** Live catalog — six crypto frozen + /api/fetch + /api/http LIVE. */
const ROUTES = [
  { path: "/api/pulse", priceUsd: "$0.005", atomic: "5000" },
  { path: "/api/signals", priceUsd: "$0.015", atomic: "15000" },
  { path: "/api/yield", priceUsd: "$0.02", atomic: "20000" },
  { path: `/api/portfolio?address=${PORTFOLIO_DEMO}`, priceUsd: "$0.04", atomic: "40000", label: "/api/portfolio" },
  { path: "/api/gas", priceUsd: "$0.01", atomic: "10000" },
  { path: "/api/funding", priceUsd: "$0.01", atomic: "10000" },
  { path: "/api/fetch?url=https://example.com", priceUsd: "$0.02", atomic: "20000", label: "/api/fetch" },
  { path: "/api/http?url=https://example.com", priceUsd: "$0.01", atomic: "10000", label: "/api/http" },
];

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
  const acc = paymentRequired?.accepts?.[0];
  if (!acc) return { label, ok: false, status: 402, error: "missing accepts[0]" };
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
  console.log(`payTo: ${EXPECTED_PAY_TO} (interim Coinbase-custodial)`);
  console.log(`USDC:  ${USDC_BASE} · network eip155:8453`);
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
    `${"route".padEnd(16)} ${"status".padEnd(8)} ${"amount".padEnd(10)} ${"payTo".padEnd(12)} ok`,
  );
  for (const r of results) {
    const amt = r.amount ?? "-";
    const pt = r.payTo ? `${String(r.payTo).slice(0, 8)}…` : "-";
    console.log(
      `${String(r.label).padEnd(16)} ${String(r.status ?? "err").padEnd(8)} ${String(amt).padEnd(10)} ${pt.padEnd(12)} ${r.ok ? "yes" : "NO"}`,
    );
  }
  const allOk = results.every((r) => r.ok);
  console.log(allOk ? "\nDISCOVERY PASS — all seven routes return matching 402" : "\nDISCOVERY FAIL — see probes above");

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
