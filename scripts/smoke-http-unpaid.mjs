#!/usr/bin/env node
/**
 * Unpaid smoke for GET|POST /api/http — expects HTTP 402 + amount 10000.
 * Does NOT spend USDC. No private key required.
 *
 *   node scripts/smoke-http-unpaid.mjs
 *   SMOKE_BASE_URL=https://horizonpulse.dev node scripts/smoke-http-unpaid.mjs
 */
const EXPECTED_PAY_TO = "0x5b32c973596078a967562ca652761404f19be0e9";
const EXPECTED_ATOMIC = "10000";
const BASE_URL = (
  process.env.SMOKE_BASE_URL?.trim() || "https://horizonpulse.dev"
).replace(/\/$/, "");

async function probe(method, url, init = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(init.headers || {}) },
    body: init.body,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const amount =
    body?.accepts?.[0]?.amount ??
    body?.accepts?.[0]?.maxAmountRequired ??
    null;
  const payTo = (body?.accepts?.[0]?.payTo || "").toLowerCase();
  const hasPR =
    Boolean(res.headers.get("PAYMENT-REQUIRED") || res.headers.get("payment-required"));
  return { status: res.status, amount, payTo, hasPR, body };
}

function assert402(label, r) {
  const ok =
    r.status === 402 &&
    String(r.amount) === EXPECTED_ATOMIC &&
    r.payTo === EXPECTED_PAY_TO &&
    r.hasPR;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${label}: status=${r.status} amount=${r.amount} payTo=${r.payTo} PAYMENT-REQUIRED=${r.hasPR}`,
  );
  if (!ok) {
    console.error(JSON.stringify(r.body, null, 2)?.slice?.(0, 800) ?? r.body);
    process.exitCode = 1;
  }
}

const getUrl = `${BASE_URL}/api/http?url=${encodeURIComponent("https://example.com")}`;
const postUrl = `${BASE_URL}/api/http`;

const getRes = await probe("GET", getUrl);
assert402("GET /api/http?url=…", getRes);

const postRes = await probe("POST", postUrl, {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com", method: "GET" }),
});
assert402("POST /api/http", postRes);

if (!process.exitCode) {
  console.log("\nUnpaid /api/http smoke OK (no USDC spent).");
}
