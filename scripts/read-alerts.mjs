#!/usr/bin/env node
/**
 * Read-only view of persisted rail alerts (Odin 9:16 AM AST 2026-10-19).
 *   node scripts/read-alerts.mjs [N=20] [DAYS=7]
 * Prints the last N entries of hp:alerts:xrpl and hp:alerts:solana and the daily counters
 * hp:alerts:<rail>:count:YYYY-MM-DD for the last DAYS UTC days.
 *
 * Credentials come ONLY from env: KV_REST_API_URL + KV_REST_API_READ_ONLY_TOKEN (the read-only token, by design).
 * The token is never printed, logged or written anywhere. Only read commands are sent (LRANGE, GET; enforced below).
 * Running it requires that token to be provided to the machine running it; that is an access decision (the team's
 * standing rule is that the box does not read or use it).
 */
const READ_ONLY = new Set(["LRANGE", "GET"]);
const RAILS = ["xrpl", "solana"];

const url = (process.env.KV_REST_API_URL ?? "").trim().replace(/\/+$/, "");
const token = (process.env.KV_REST_API_READ_ONLY_TOKEN ?? "").trim();
if (!url || !token) {
  console.error("read-alerts: KV_REST_API_URL and KV_REST_API_READ_ONLY_TOKEN must both be set in the environment. Nothing read.");
  process.exit(2);
}
if (!/^https:\/\//.test(url)) {
  console.error("read-alerts: KV_REST_API_URL must be https. Nothing read.");
  process.exit(2);
}
const n = Math.max(1, Math.min(500, Number.parseInt(process.argv[2] ?? "20", 10) || 20));
const days = Math.max(1, Math.min(35, Number.parseInt(process.argv[3] ?? "7", 10) || 7));

async function run(cmds) {
  for (const c of cmds) if (!READ_ONLY.has(String(c[0]).toUpperCase())) throw new Error(`refusing non-read command ${c[0]}`);
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
  const out = await res.json();
  return out.map((x) => (x && x.error ? null : x.result));
}

const dayList = Array.from({ length: days }, (_, i) => new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
try {
  for (const rail of RAILS) {
    const cmds = [["LRANGE", `hp:alerts:${rail}`, 0, n - 1], ...dayList.map((d) => ["GET", `hp:alerts:${rail}:count:${d}`])];
    const [entries, ...counts] = await run(cmds);
    console.log(`== ${rail}: daily counts (UTC)`);
    let total = 0;
    dayList.forEach((d, i) => {
      const c = Number(counts[i] ?? 0) || 0;
      total += c;
      console.log(`  ${d}  ${c}`);
    });
    console.log(`  total ${days}d: ${total}`);
    console.log(`== ${rail}: last ${n} entries (newest first)`);
    for (const e of entries ?? []) {
      try {
        const j = JSON.parse(e);
        console.log(`  ${j.ts}  ${j.severity ?? ""}  ${j.code ?? ""}${j.route ? `  ${j.route}` : ""}${j.payer ? `  payer ${j.payer}` : ""}`);
      } catch {
        console.log("  (unparseable entry)");
      }
    }
    if (!entries?.length) console.log("  (none)");
  }
} catch (err) {
  // Never echo request details (the token is only in the Authorization header, which is never printed).
  console.error(`read-alerts: read failed: ${err instanceof Error ? err.message : "error"}`);
  process.exit(1);
}
