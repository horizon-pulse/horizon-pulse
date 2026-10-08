#!/usr/bin/env node
/**
 * NO-MONEY smoke test for the Solana rail branch (read-only; no wallet, no
 * keys, no payment). Hits a locally running `next start` build and records,
 * for every paid route x {GET json, GET browser, POST json (http/extract),
 * OPTIONS}, the status and the decoded PAYMENT-REQUIRED accepts.
 *
 *   node scripts/smoke-solana-rail.mjs <baseUrl> <out.json>
 */
import { writeFileSync } from "node:fs";

const [, , BASE = "http://127.0.0.1:3461", OUT = "smoke-solana.json"] = process.argv;
const ROUTES = ["pulse", "signals", "yield", "portfolio", "gas", "funding", "fetch", "http", "extract", "x402-check", "screenshot", "search", "pdf"];
const POST = new Set(["http", "extract"]);

const decode = (h) => (h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null);

async function hit(route, method, kind) {
  const headers =
    kind === "browser"
      ? { accept: "text/html,application/xhtml+xml", "sec-fetch-mode": "navigate" }
      : { accept: "application/json" };
  const res = await fetch(`${BASE}/api/${route}`, { method, headers, redirect: "manual" });
  const raw = res.headers.get("payment-required");
  const pr = decode(raw);
  const body = await res.text();
  return {
    key: `${method} /api/${route}${method === "OPTIONS" ? "" : ` ${kind}`}`,
    status: res.status,
    contentType: res.headers.get("content-type"),
    paymentRequiredHeader: raw,
    accepts: pr?.accepts ?? null,
    bodyAcceptsMatchesHeader: body.startsWith('{"x402Version"') ? JSON.stringify(JSON.parse(body).accepts) === JSON.stringify(pr?.accepts) : null,
    bodyKind: body.startsWith("<!doctype") ? "html" : body.startsWith('{"x402Version"') ? "PaymentRequired" : body.slice(0, 20),
  };
}

const results = [];
for (const r of ROUTES) {
  results.push(await hit(r, "GET", "json"));
  results.push(await hit(r, "GET", "browser"));
  if (POST.has(r)) results.push(await hit(r, "POST", "json"));
  results.push(await hit(r, "OPTIONS", "json"));
}
writeFileSync(OUT, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 1) + "\n");
for (const x of results) {
  const a = (x.accepts ?? []).map((e) => `${e.network}:${e.amount}->${e.payTo}`).join(" | ");
  console.log(`${x.status} ${x.key.padEnd(34)} ${a}`);
}
