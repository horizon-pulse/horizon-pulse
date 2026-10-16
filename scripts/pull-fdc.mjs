#!/usr/bin/env node
/**
 * Reviewed refresh of the bundled USDA FoodData Central snapshot (/api/grocery/ingredient).
 * Source: FDC bulk downloads (public domain, CC0 1.0), Foundation Foods + SR Legacy JSON.
 * Writes lib/data/fdc-snapshot.json deterministically (same zips => same bytes): per food
 * fdcId, description, dataType, category and 8 nutrients per 100 g. Nothing else is kept.
 *
 *   node scripts/pull-fdc.mjs                  # download the pinned releases below
 *   node scripts/pull-fdc.mjs --dir <folder>   # use zips already downloaded into <folder>
 *
 * After a refresh: bump FDC_RELEASES (name + sha256) here, and the pinned snapshot sha in
 * tests/grocery-ingredient.test.ts, in one reviewed commit. Requires the `unzip` binary.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "https://fdc.nal.usda.gov/fdc-datasets/";
export const FDC_RELEASES = [
  { key: "FoundationFoods", dataType: "Foundation", release: "Foundation Foods, April 2026", file: "FoodData_Central_foundation_food_json_2026-04-30.zip", sha256: "186e988ec542e913f51ef62b86a47758e8cdd0d1dc3889e7b055581f3c09c77a" },
  { key: "SRLegacyFoods", dataType: "SR Legacy", release: "SR Legacy, April 2018", file: "FoodData_Central_sr_legacy_food_json_2018-04.zip", sha256: "0fe8ae486a2c8eb42cb96413f058deb51863a46c8fb8eeb4b1fb45006dd338ef" },
];
// Output field -> FDC nutrient numbers in priority order (first present wins). Energy in kcal only.
const NUTRIENTS = {
  energy_kcal: ["208", "958", "957"],
  protein_g: ["203"],
  fat_g: ["204"],
  sat_fat_g: ["606"],
  carbs_g: ["205", "205.2"],
  sugars_g: ["269", "269.3"],
  fiber_g: ["291"],
  sodium_mg: ["307"],
};
const UNITS = { energy_kcal: "kcal", sodium_mg: "mg" };
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = arg("--dir") ?? mkdtempSync(join(tmpdir(), "fdc-"));

const foods = [];
const sources = [];
for (const r of FDC_RELEASES) {
  const zip = join(dir, r.file);
  if (!existsSync(zip)) {
    const res = await fetch(BASE + r.file);
    if (!res.ok) throw new Error(`${r.file}: HTTP ${res.status}`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  const sha = createHash("sha256").update(readFileSync(zip)).digest("hex");
  if (sha !== r.sha256) throw new Error(`${r.file}: sha256 ${sha} != pinned ${r.sha256}`);
  const json = JSON.parse(execFileSync("unzip", ["-p", zip], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8"));
  const list = json[r.key];
  if (!Array.isArray(list)) throw new Error(`${r.file}: no ${r.key}`);
  let n = 0;
  for (const f of list) {
    if (!f || typeof f.fdcId !== "number" || typeof f.description !== "string") continue;
    const byNum = new Map();
    for (const fn of f.foodNutrients ?? []) {
      const nu = fn?.nutrient;
      if (!nu?.number || typeof fn.amount !== "number") continue;
      if (nu.number === "208" && nu.unitName !== "kcal") continue;
      if (!byNum.has(nu.number)) byNum.set(nu.number, fn.amount);
    }
    const nut = {};
    for (const [k, nums] of Object.entries(NUTRIENTS)) {
      const hit = nums.find((x) => byNum.has(x));
      nut[k] = hit === undefined ? null : Math.round(byNum.get(hit) * 1000) / 1000;
    }
    if (Object.values(nut).every((v) => v === null)) continue;
    foods.push([f.fdcId, f.description.trim(), r.dataType, f.foodCategory?.description ?? null, ...Object.keys(NUTRIENTS).map((k) => nut[k])]);
    n++;
  }
  sources.push({ dataType: r.dataType, release: r.release, url: BASE + r.file, zipSha256: sha, foods: n });
}
foods.sort((a, b) => a[0] - b[0]);
const snap = {
  source: "U.S. Department of Agriculture, Agricultural Research Service. FoodData Central (bulk download). Public domain (CC0 1.0).",
  sources,
  columns: ["fdcId", "description", "dataType", "category", ...Object.keys(NUTRIENTS)],
  units: Object.fromEntries(Object.keys(NUTRIENTS).map((k) => [k, UNITS[k] ?? "g"])),
  per: "100g",
  count: foods.length,
  foods,
};
const out = arg("--out") ?? "lib/data/fdc-snapshot.json";
const text = JSON.stringify(snap);
writeFileSync(out, text);
console.log(`${out}: ${foods.length} foods, ${text.length} bytes, sha256 ${createHash("sha256").update(text).digest("hex")}`);
