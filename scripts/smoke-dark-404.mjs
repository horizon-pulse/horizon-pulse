#!/usr/bin/env node
/**
 * Dark-route 404 smoke (Odin 10:31 + C4 10:44 AM ET 10/18). Read-only; sends no real payment.
 * Usage: node scripts/smoke-dark-404.mjs [base=https://horizonpulse.dev]
 *
 * Every dark URL x path variant (plain, case e.g. /Api/Package/Check, upper e.g. /API/PACKAGE/CHECK, percent-encoded e.g. /api/%70ackage/check, %2F) x header set (plain; RSC:1 +
 * Next-Router-State-Tree + Next-Router-Prefetch; junk X-PAYMENT + PAYMENT-SIGNATURE) x 7 methods,
 * each compared with a fresh random UNKNOWN path of the same shape and prefix, given the SAME
 * variant and headers. Volatile headers (date, ids, cache state, etag, last-modified, age, timing)
 * are ignored; everything else must match, including absence of Allow / x-matched-path /
 * x-nextjs-rewritten-* leaks and cache-control. Body: length + sha256 (not for HEAD/OPTIONS).
 * Prints a per-variant tally; exit 1 on any difference.
 * v1.2: a request that fails with a connect timeout / ECONNRESET is retried (max 3 retries, 0.5/1/2 s backoff).
 * v1.2.1: the unknown twin itself must answer 404 for every method except OPTIONS (a twin that is not a 404 makes
 *   the comparison meaningless). OPTIONS on any unknown path is answered 204 by the framework; it is still compared.
 */
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.argv[2] || "https://horizonpulse.dev").replace(/\/$/, "");
const DARK = ["/api/audit/security", "/api/package/check", "/api/package/check?tier=deep", "/api/injection/scan", "/api/trade-gate", "/api/aave-equities/collateral-data", "/api/cash-benchmark", "/web-checks", "/web-checks/opt-out?domain=example.com"];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const HEADER_SETS = {
  plain: {},
  rsc: { RSC: "1", "Next-Router-State-Tree": "%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D", "Next-Router-Prefetch": "1" },
  payment: { "X-PAYMENT": "eyJqdW5rIjp0cnVlfQ==", "PAYMENT-SIGNATURE": "eyJqdW5rIjp0cnVlfQ==" },
};
const VOLATILE = new Set(["date", "age", "etag", "last-modified", "x-vercel-id", "x-vercel-cache", "server-timing", "connection", "keep-alive", "transfer-encoding", "alt-svc", "cf-ray", "report-to", "nel", "x-nextjs-stale-time", "x-nextjs-prerender", "x-nextjs-cache"]);

/** Same-shape unknown twin: same prefix and segment count, random letters in the path segments after the first. */
function unknownTwin(u) {
  const [p, q] = u.split("?");
  const segs = p.split("/").filter(Boolean);
  const r = () => "zz" + randomBytes(4).toString("hex").replace(/\d/g, (d) => "abcdefghij"[d]);
  const twin = segs.length === 1 ? [r()] : [segs[0], ...segs.slice(1).map(r)];
  return "/" + twin.join("/") + (q ? `?${q}` : "");
}
/** Path variants applied identically to the dark URL and its unknown twin. */
const VARIANTS = {
  plain: (p) => p,
  case: (p) => p.split("/").map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s)).join("/"),
  upper: (p) => p.replace(/^[^?]*/, (x) => x.toUpperCase()),
  pct: (p) => p.split("/").map((s, i) => (i >= 1 && s ? "%" + s.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0") + s.slice(1) : s)).join("/"),
  pct2f: (p) => (p.split("/").filter(Boolean).length >= 2 ? p.replace(/\/([^/]*)$/, "%2F$1") : null),
};
const withVariant = (u, v) => {
  const [p, q] = u.split("?");
  const pv = VARIANTS[v](p);
  return pv === null ? null : pv + (q ? `?${q}` : "");
};

/** Connect timeout / connection reset only (v1.2); any other network error still fails the run. */
const RETRYABLE = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNRESET"]);

async function hit(method, path, extra) {
  const init = { method, redirect: "manual", headers: { "user-agent": "HorizonPulse-dark404-smoke/1.2.1", accept: "*/*", ...extra } };
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    init.body = "{}";
    init.headers["content-type"] = "application/json";
  }
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(BASE + path, init);
      break;
    } catch (e) {
      const code = e?.cause?.code ?? e?.code;
      if (attempt >= 3 || !RETRYABLE.has(code)) throw e;
      console.error(`network retry ${attempt + 1}/3 ${method} ${path}: ${code}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  const body = Buffer.from(await res.arrayBuffer());
  const headers = {};
  for (const [k, v] of res.headers) if (!VOLATILE.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  return { status: res.status, headers, len: body.length, sha: createHash("sha256").update(body).digest("hex").slice(0, 16) };
}

const tally = {};
let fails = 0, checks = 0;
for (const u of DARK) {
  for (const v of Object.keys(VARIANTS)) {
    const du = withVariant(u, v);
    if (du === null) continue;
    for (const [hs, extra] of Object.entries(HEADER_SETS)) {
      const key = `${v}+${hs}`;
      tally[key] ??= { same: 0, total: 0 };
      for (const m of METHODS) {
        checks++;
        tally[key].total++;
        const ku = withVariant(unknownTwin(u), v);
        const [d, k] = await Promise.all([hit(m, du, extra), hit(m, ku, extra)]);
        const diffs = [];
        if (m !== "OPTIONS" && k.status !== 404) diffs.push(`unknown twin answered ${k.status}, expected 404`);
        if (d.status !== k.status) diffs.push(`status ${d.status} vs unknown ${k.status}`);
        for (const h of new Set([...Object.keys(d.headers), ...Object.keys(k.headers)])) if (d.headers[h] !== k.headers[h]) diffs.push(`${h}: ${JSON.stringify(d.headers[h] ?? null)} vs unknown ${JSON.stringify(k.headers[h] ?? null)}`);
        if (m !== "OPTIONS" && m !== "HEAD" && (d.len !== k.len || d.sha !== k.sha)) diffs.push(`body ${d.len}B/${d.sha} vs unknown ${k.len}B/${k.sha}`);
        if (diffs.length) {
          fails++;
          console.log(`DIFF [${key}] ${m.padEnd(7)} ${du} (twin ${ku}) -> ${d.status}\n    ${diffs.join("\n    ")}`);
        } else tally[key].same++;
      }
    }
  }
}
for (const [k, t] of Object.entries(tally)) console.log(`variant ${k.padEnd(14)} ${t.same}/${t.total}`);
console.log(`dark-404 smoke: ${checks - fails}/${checks} identical to an unknown path (${BASE})`);
process.exit(fails ? 1 : 0);
