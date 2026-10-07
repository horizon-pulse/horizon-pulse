/** Count NON-TEST EURC revenue from a JSONL log (EURC_REVENUE_LOG). EUR only; never mixed with USDC. */
import fs from "node:fs";
import { countEurc, type EurcRevenueRecord } from "../lib/eurc-revenue.ts";
const file = process.argv[2] ?? process.env.EURC_REVENUE_LOG;
if (!file || !fs.existsSync(file)) { console.log(JSON.stringify({ currency: "EUR", calls: 0, buyers: 0, amountAtomic: "0", note: "no log" })); process.exit(0); }
const recs = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as EurcRevenueRecord);
console.log(JSON.stringify({ ...countEurc(recs), testRecordsExcluded: recs.filter((r) => r.test).length }));
