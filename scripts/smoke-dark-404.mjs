#!/usr/bin/env node
/**
 * Dark-route 404 smoke (Odin 10:31 AM ET 10/18). Read-only; sends no payment.
 * Usage: node scripts/smoke-dark-404.mjs [base=https://horizonpulse.dev]
 *
 * For every dark URL x every method, compares status + headers with a fresh random UNKNOWN path
 * under the same prefix (/api/... for API routes, /... for pages, so the same next.config header
 * rules apply). Volatile headers (date, ids, cache state, etag, last-modified, age, timing) are
 * ignored; everything else must match exactly, including absence of Allow / x-matched-path leaks.
 * Body: compared by length and sha256 except on OPTIONS/HEAD. Exit 1 on any difference.
 */
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.argv[2] || "https://horizonpulse.dev").replace(/\/$/, "");
const DARK = ["/api/audit/security", "/api/package/check", "/api/package/check?tier=deep", "/api/injection/scan", "/web-checks", "/web-checks/opt-out?domain=example.com"];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const VOLATILE = new Set(["date", "age", "etag", "last-modified", "x-vercel-id", "x-vercel-cache", "server-timing", "connection", "keep-alive", "transfer-encoding", "alt-svc", "cf-ray", "report-to", "nel", "x-nextjs-stale-time", "x-nextjs-prerender", "x-nextjs-cache"]);

const unknownFor = (u) => {
  const r = randomBytes(6).toString("hex");
  return u.startsWith("/api/") ? `/api/zz-unknown-${r}` : `/zz-unknown-${r}`;
};
async function hit(method, path) {
  const init = { method, redirect: "manual", headers: { "user-agent": "HorizonPulse-dark404-smoke/1.0", accept: "*/*" } };
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    init.body = "{}";
    init.headers["content-type"] = "application/json";
  }
  const res = await fetch(BASE + path, init);
  const body = Buffer.from(await res.arrayBuffer());
  const headers = {};
  for (const [k, v] of res.headers) if (!VOLATILE.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  return { status: res.status, headers, len: body.length, sha: createHash("sha256").update(body).digest("hex").slice(0, 16) };
}

let fails = 0, checks = 0;
for (const u of DARK) {
  for (const m of METHODS) {
    checks++;
    const [d, k] = await Promise.all([hit(m, u), hit(m, unknownFor(u))]);
    const diffs = [];
    if (d.status !== k.status) diffs.push(`status ${d.status} vs unknown ${k.status}`);
    for (const h of new Set([...Object.keys(d.headers), ...Object.keys(k.headers)])) if (d.headers[h] !== k.headers[h]) diffs.push(`${h}: ${JSON.stringify(d.headers[h] ?? null)} vs unknown ${JSON.stringify(k.headers[h] ?? null)}`);
    if (m !== "OPTIONS" && m !== "HEAD" && (d.len !== k.len || d.sha !== k.sha)) diffs.push(`body ${d.len}B/${d.sha} vs unknown ${k.len}B/${k.sha}`);
    if (diffs.length) fails++;
    console.log(`${diffs.length ? "DIFF" : "same"} ${m.padEnd(7)} ${u} -> ${d.status}${diffs.length ? "\n    " + diffs.join("\n    ") : ""}`);
  }
}
console.log(`dark-404 smoke: ${checks - fails}/${checks} identical to an unknown path (${BASE})`);
process.exit(fails ? 1 : 0);
