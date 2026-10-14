#!/usr/bin/env node
/** prebuild: fail the build when the bundled SDN snapshot is older than 30 days (tx-guard, Sentinel HIGH-2). */
import { readdirSync, readFileSync } from "node:fs";
const files = readdirSync("lib/data").filter((f) => /^ofac-sdn-crypto-.*\.json$/.test(f)).sort();
if (!files.length) { console.error("check-sdn-age: no SDN snapshot"); process.exit(1); }
const snap = JSON.parse(readFileSync(`lib/data/${files.at(-1)}`, "utf8"));
const days = Math.floor((Date.now() - Date.parse(snap.publisherLastModified)) / 86_400_000);
if (days > 30) { console.error(`check-sdn-age: SDN snapshot is ${days} days old (> 30). Run node scripts/pull-sdn.mjs and commit the reviewed refresh.`); process.exit(1); }
console.log(`check-sdn-age: SDN snapshot ${files.at(-1)} is ${days} days old (ok)`);
