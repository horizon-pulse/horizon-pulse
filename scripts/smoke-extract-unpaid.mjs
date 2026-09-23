#!/usr/bin/env node
/**
 * Unpaid smoke for GET|POST /api/extract — expects HTTP 402 + amount 15000.
 * Does NOT spend USDC. No private key required.
 *
 *   node scripts/smoke-extract-unpaid.mjs
 *   SMOKE_BASE_URL=https://horizonpulse.dev node scripts/smoke-extract-unpaid.mjs
 *   SMOKE_BASE_URL=http://127.0.0.1:3000 node scripts/smoke-extract-unpaid.mjs
 */
const EXPECTED_PAY_TO = "0x5b32c973596078a967562ca652761404f19be0e9";
const EXPECTED_ATOMIC = "15000";
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
  const hasPR = Boolean(
    res.headers.get("PAYMENT-REQUIRED") || res.headers.get("payment-required"),
  );
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

const getUrl = `${BASE_URL}/api/extract?url=${encodeURIComponent("https://example.com")}`;
const postUrl = `${BASE_URL}/api/extract`;

const getRes = await probe("GET", getUrl);
assert402("GET /api/extract?url=…", getRes);

const postRes = await probe("POST", postUrl, {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    html: "<html><head><title>T</title></head><body><h1>Hi</h1></body></html>",
  }),
});
assert402("POST /api/extract", postRes);

if (!process.exitCode) {
  console.log("\nUnpaid /api/extract smoke OK (no USDC spent).");
}
