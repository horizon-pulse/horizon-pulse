#!/usr/bin/env node
/**
 * Post-deploy smoke (Odin 11:44 (e)): the XRPL replay store must answer a trivial EVAL, or the rail fails closed.
 * The probe runs server-side (it needs the store credentials); this script only reads the non-secret result from
 * /status: <meta name="hp-xrpl-replay-eval" content="ok|unavailable|not_applicable">. Needs no secrets, sends none.
 *
 *   node scripts/smoke-xrpl-replay-eval.mjs [baseUrl]   (default https://horizonpulse.dev)
 *   SMOKE_XRPL_EVAL_ALLOW_NA=1 accepts "not_applicable" (preview/testnet without a shared store).
 * Reads /status 3 times; every read must pass. Exit 0 = ok; 1 = any unavailable / missing / not_applicable; 2 = fetch error.
 */
const base = (process.argv[2] || process.env.SMOKE_BASE_URL || "https://horizonpulse.dev").replace(/\/+$/, "");
const reads = 3;
const allowNa = process.env.SMOKE_XRPL_EVAL_ALLOW_NA === "1";
const seen = [];
for (let i = 0; i < reads; i++) {
  let html;
  try {
    const res = await fetch(`${base}/status`, { headers: { accept: "text/html", "cache-control": "no-cache" }, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error(`smoke-xrpl-replay-eval: fetch ${base}/status failed: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  const m = /<meta[^>]*name="hp-xrpl-replay-eval"[^>]*content="([a-z_]+)"/.exec(html) || /<meta[^>]*content="([a-z_]+)"[^>]*name="hp-xrpl-replay-eval"/.exec(html);
  seen.push(m ? m[1] : "missing");
  if (i < reads - 1) await new Promise((r) => setTimeout(r, 1000));
}
// Every read must pass (several instances may answer; never pass on "one of them was ok").
const pass = seen.every((v) => v === "ok" || (allowNa && v === "not_applicable"));
console[pass ? "log" : "error"](`smoke-xrpl-replay-eval: ${pass ? "PASS" : "FAIL"} [${seen.join(", ")}] ${base}/status${pass ? "" : " — XRPL rail fails closed (no XRPL in the 402) where unavailable"}`);
process.exit(pass ? 0 : 1);
