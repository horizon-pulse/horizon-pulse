/**
 * INTERNAL weekly digest of /api/feedback (operator only, needs KV env). Read-only on KV; writes ONE new dated file.
 * Usage: npx tsx scripts/feedback-digest.ts --out-dir <dir> [--days 7]
 * File: <dir>/YYYY-MM-DD-feedback-digest.md (suffix -2, -3 ... if it exists; never overwrites). No ip_hash/ids/exact times.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { upstashKv, FEEDBACK_KEY_PREFIX as P } from "../lib/feedback";
import { buildFeedbackDigest, digestFileName } from "../lib/feedback-digest";

async function main() {
  const kv = upstashKv(process.env);
  if (!kv) throw new Error("KV env not set");
  const oi = process.argv.indexOf("--out-dir");
  const dir = oi > 0 ? process.argv[oi + 1] : "";
  if (!dir) throw new Error("--out-dir required");
  const di = process.argv.indexOf("--days");
  const days = di > 0 ? Math.max(1, Math.min(90, Number(process.argv[di + 1]) || 7)) : 7;
  const now = Date.now();
  const [ids] = (await kv.pipeline([["ZRANGEBYSCORE", `${P}idx`, now - days * 86_400_000, now]])) as [string[]];
  const rows = ids?.length ? await kv.pipeline(ids.map((id) => ["GET", `${P}e:${id}`])) : [];
  const parsed = rows.filter((r): r is string => typeof r === "string").map((r) => JSON.parse(r) as Record<string, unknown>);
  const votes = new Map<string, number>();
  if (ids?.length) {
    const sc = await kv.pipeline(ids.map((id) => ["ZSCORE", `${P}votes`, id]));
    ids.forEach((id, i) => sc[i] != null && votes.set(id, Number(sc[i])));
  }
  const date = new Date(now).toISOString().slice(0, 10);
  const name = digestFileName(date, (n) => existsSync(join(dir, n)));
  writeFileSync(join(dir, name), buildFeedbackDigest(parsed, { date, votes }), { flag: "wx" });
  console.log(`wrote ${name} (${parsed.length} rows)`);
}
main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
