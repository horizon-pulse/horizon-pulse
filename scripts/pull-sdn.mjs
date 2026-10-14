#!/usr/bin/env node
/**
 * Weekly reviewed refresh of the bundled OFAC SDN crypto-address snapshot (tx-guard).
 * Pulls the official SDN CSV, extracts every "Digital Currency Address - <CUR> <addr>" from the
 * remarks field, and writes lib/data/ofac-sdn-crypto-<YYYY-MM-DD>.json deterministically
 * (same CSV + same headers => same bytes). Also prints the current scamsniffer/scam-database head
 * so SCAM_LIST_COMMIT can be bumped in the same reviewed commit.
 *
 *   node scripts/pull-sdn.mjs                       # live pull
 *   node scripts/pull-sdn.mjs --csv SDN.CSV --last-modified "<RFC1123>" --date "<RFC1123>" [--out file]
 *
 * After a refresh: update the import in lib/tx-guard.ts and the pinned sha in tests/tx-guard.test.ts.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const URL_SDN = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const iso = (s) => new Date(s).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes). */
function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f.replace(/\r$/, "")); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

let bytes, lastModified, date;
if (arg("--csv")) {
  bytes = readFileSync(arg("--csv")); lastModified = arg("--last-modified"); date = arg("--date");
} else {
  const res = await fetch(URL_SDN);
  if (!res.ok) throw new Error(`SDN HTTP ${res.status}`);
  bytes = Buffer.from(await res.arrayBuffer());
  lastModified = res.headers.get("last-modified"); date = res.headers.get("date");
}
if (!lastModified || !date) throw new Error("need Last-Modified and Date");
const text = new TextDecoder("latin1").decode(bytes);
const entries = [];
for (const r of parseCsv(text)) {
  if (r.length < 12) continue;
  for (const m of r[11].matchAll(/Digital Currency Address - ([A-Z0-9]+) ([^;\s]+)/g)) {
    entries.push({ currency: m[1], address: m[2].replace(/\.+$/, ""), sdnEntNum: parseInt(r[0], 10), sdnName: r[1].trim() });
  }
}
const snap = {
  source: "U.S. Treasury OFAC Specially Designated Nationals (SDN) list, CSV export; 'Digital Currency Address' entries from the remarks field",
  sourceUrl: URL_SDN,
  publisherLastModified: iso(lastModified),
  pulledAt: iso(date),
  sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  count: entries.length,
  entries,
};
const out = arg("--out") ?? `lib/data/ofac-sdn-crypto-${iso(date).slice(0, 10)}.json`;
const json = JSON.stringify(snap, null, 1);
writeFileSync(out, json);
console.log(`${out}: ${entries.length} entries, sha256 ${createHash("sha256").update(json).digest("hex")}`);
try {
  const h = await (await fetch("https://api.github.com/repos/scamsniffer/scam-database/commits/main")).json();
  console.log(`scamsniffer/scam-database main head: ${h.sha} (${h.commit?.committer?.date})`);
} catch { console.log("scamsniffer head: not fetched"); }
