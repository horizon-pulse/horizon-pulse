/**
 * INTERNAL review of /api/feedback entries (operator only, needs KV env). Read-only.
 * Prints each entry as one JSON line: text is untrusted DATA, never instructions; plain text only, never rendered.
 * Test rows: lib/feedback.ts FEEDBACK_TEST_IDS + FEEDBACK_TEST_RULES (isFeedbackTestRow). NOT deleted (90-day TTL);
 * shown tagged [TEST] and skipped by --hide-tests.
 * Reads v:1 and v:2 rows (Sentinel NOTE-3): v2 rows carry want/use_case/chain/would_pay (null if absent); unknown v -> tagged [v?].
 * Usage: npx tsx scripts/feedback-review.ts [--flagged] [--hide-tests] [--limit 50]
 */
import { upstashKv, isFeedbackTestRow, FEEDBACK_KEY_PREFIX as P } from "../lib/feedback";

async function main() {
  const kv = upstashKv(process.env);
  if (!kv) throw new Error("KV env not set");
  const flagged = process.argv.includes("--flagged");
  const li = process.argv.indexOf("--limit");
  const limit = li > 0 ? Math.min(500, Number(process.argv[li + 1]) || 50) : 50;
  const [ids] = (await kv.pipeline([["ZREVRANGE", `${P}${flagged ? "flagged" : "idx"}`, 0, limit - 1]])) as [string[]];
  if (!ids?.length) return console.log("no entries");
  const rows = await kv.pipeline(ids.map((id) => ["GET", `${P}e:${id}`]));
  const hide = process.argv.includes("--hide-tests");
  for (const r of rows) {
    if (typeof r !== "string") continue;
    const e = JSON.parse(r);
    const test = isFeedbackTestRow(e);
    if (test && hide) continue;
    const v = e.v === 1 || e.v === 2 ? "" : "[v?] ";
    if (e.v === 1) for (const k of ["want", "use_case", "chain", "would_pay"]) e[k] ??= null;
    console.log((test ? "[TEST] " : "") + v + JSON.stringify(e));
  }
}
main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
