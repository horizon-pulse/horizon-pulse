/**
 * /api/grocery/ingredient: ingredient name (or a /api/grocery/normalize canonicalId) and/or a
 * product barcode -> nutrition per 100 g, with source attribution. NOT LAUNCHED: price unset
 * (lib/config.ts GROCERY_INGREDIENT_PRICE_USD = null).
 *
 * Sources (scope to-odin/2026-10-14-pulse-ingredient-nutrition-scope.md, Counsel review
 * to-odin/2026-10-15-counsel-nutrition-route-review.md, Odin build OK 2026-10-16 10:13 AM ET):
 * - USDA FoodData Central: bundled CC0 snapshot (Foundation + SR Legacy), lib/data/fdc-snapshot.json,
 *   built by scripts/pull-fdc.mjs. No outbound call, no key.
 * - Open Food Facts: live product read by barcode only (no OFF name search). Hard cap 12 reads/min
 *   per instance (OFF limit 15/min/IP), custom User-Agent, 429/503 -> our 503 source_throttled.
 *   Counsel fix 1 (option A): records cached unaltered, keyed by barcode, TTL <= 24 h, hard size cap
 *   OFF_CACHE_MAX_ENTRIES; no bulk, list or export endpoint; never joined into our own tables.
 * - Counsel fix 2: per-match attribution (ODbL/DbCL + product link for OFF; FDC citation with the
 *   release + "Public domain (CC0 1.0)" for USDA), exact Counsel wording.
 * - Counsel fix 3: Counsel's disclaimer verbatim in every 200; allergens null + "unknown" when OFF has
 *   none (never []); allergensSource "open_food_facts_contributors".
 * - Counsel fix 4 (option A): no retailer links. whereToBuy = OFF contributor store names + the OFF
 *   product page only. Our server never contacts any retailer site.
 * No prices, no stock, no images. Nothing about the caller is stored or logged.
 */
import FDC from "@/lib/data/fdc-snapshot.json";
import { CONTACT_EMAIL } from "@/lib/config";

export const GI_MAX_Q_CHARS = 100;
export const GI_MAX_ITEMS = 10;
export const GI_MAX_BODY_BYTES = 8_000;
export const GI_MAX_N = 5;

export const OFF_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const OFF_CACHE_MAX_ENTRIES = 2_000;
export const OFF_READS_PER_MIN = 12;
export const OFF_TIMEOUT_MS = 6_000;
export const OFF_USER_AGENT = `HorizonPulse/1.0 (${CONTACT_EMAIL})`;
const OFF_FIELDS = "code,product_name,brands,nutriments,ingredients_text,allergens_tags,labels_tags,stores";

/** Counsel 2026-10-15 §3, verbatim. In every 200. */
export const GROCERY_INGREDIENT_DISCLAIMER =
  "Indicative data only. Open Food Facts data is entered by volunteers and USDA data describes generic or reported foods; values can be wrong, missing or out of date, and recipes and labels change. Allergen and ingredient fields may be incomplete: an empty or missing allergen list does NOT mean a product is free of any allergen or trace. Always check the product's own label. Not for medical, dietary or allergy decisions. Not advice." as const;

/** Counsel 2026-10-15 §2 (docs, llms.txt and OpenAPI) + §1 option A docs line, verbatim. */
export const GROCERY_INGREDIENT_DOCS_NOTE =
  "Nutrition and product data come from Open Food Facts (https://openfoodfacts.org), made available under the ODbL (database) and DbCL (contents), and from USDA FoodData Central (fdc.nal.usda.gov, public domain/CC0). Horizon Pulse is not affiliated with or endorsed by Open Food Facts or USDA. The per-call fee is for our service; the underlying data is free from those sources." as const;
export const OFF_CACHE_DOCS_NOTE =
  "Cached Open Food Facts records are unaltered copies; full data: https://world.openfoodfacts.org/data (ODbL)." as const;

/** Counsel §2 per-match OFF wording, verbatim with the product barcode filled in. */
export function offAttribution(barcode: string): string {
  return `Contains information from Open Food Facts (https://openfoodfacts.org), which is made available here under the Open Database License (ODbL) https://opendatacommons.org/licenses/odbl/1-0/. Individual contents: Database Contents License (DbCL) https://opendatacommons.org/licenses/dbcl/1-0/. Product page: ${offProductUrl(barcode)}.`;
}
/** Counsel §2 per-match FDC wording, verbatim with the release name/year filled in. */
export function fdcAttribution(release: string): string {
  return `Source: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, ${release}. fdc.nal.usda.gov. Public domain (CC0 1.0).`;
}
export const offProductUrl = (barcode: string) => `https://world.openfoodfacts.org/product/${barcode}`;
export const fdcFoodUrl = (fdcId: number) => `https://fdc.nal.usda.gov/food-details/${fdcId}/nutrients`;

export const GROCERY_INGREDIENT_METHODOLOGY = {
  fdc: "USDA FoodData Central bundled snapshot (Foundation Foods + SR Legacy; release names and zip sha256 in fdcSnapshot). Name matching is deterministic token overlap on the food description; values are per 100 g as published. No outbound call.",
  openFoodFacts: "Open Food Facts live product read by barcode only (no name search), at most 12 reads per minute per server instance. Values per 100 g as entered by contributors; sodium converted from g to mg.",
  cache: OFF_CACHE_DOCS_NOTE + ` At most ${OFF_CACHE_MAX_ENTRIES} records, each kept at most 24 hours, keyed by barcode; there is no bulk, list or export endpoint and records are never merged into Horizon Pulse tables.`,
  allergens: "Allergens come only from Open Food Facts contributors, as listed. When Open Food Facts lists none, allergens is null and allergensStatus is \"unknown\": never an empty list.",
  whereToBuy: "Store names as listed by Open Food Facts contributors plus the Open Food Facts product page. No retailer links; Horizon Pulse never contacts retailer sites. No prices, no stock.",
  docs: GROCERY_INGREDIENT_DOCS_NOTE,
  storage: "Nothing about the caller is stored or logged.",
} as const;

// ---------- FDC snapshot ----------
type Nutrients = { energy_kcal: number | null; protein_g: number | null; fat_g: number | null; sat_fat_g: number | null; carbs_g: number | null; sugars_g: number | null; fiber_g: number | null; sodium_mg: number | null };
const NUTRIENT_KEYS = ["energy_kcal", "protein_g", "fat_g", "sat_fat_g", "carbs_g", "sugars_g", "fiber_g", "sodium_mg"] as const;
type FdcRow = [number, string, string, string | null, ...(number | null)[]];
type FdcSnap = { sources: { dataType: string; release: string; url: string; zipSha256: string; foods: number }[]; columns: string[]; count: number; foods: FdcRow[] };
const SNAP = FDC as unknown as FdcSnap;
const RELEASE_BY_TYPE = new Map(SNAP.sources.map((s) => [s.dataType, s.release]));
export const FDC_SNAPSHOT_INFO = SNAP.sources.map(({ dataType, release, url, zipSha256, foods }) => ({ dataType, release, url, zipSha256, foods }));

const SKIP_CATEGORIES = new Set(["Baby Foods", "Fast Foods", "Restaurant Foods", "Meals, Entrees, and Side Dishes", "American Indian/Alaska Native Foods"]);
const STOP = new Set(["of", "and", "or", "the", "a", "an", "with", "in", "for", "to", "fresh", "large", "small", "medium", "chopped", "diced", "minced", "sliced"]);
const singular = (w: string) => (w.length > 3 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && /(ch|sh|x|ss)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((w) => w && !STOP.has(w)).map(singular);

type Indexed = { row: FdcRow; toks: Set<string>; head: Set<string>; first: string; seg2: string[]; len: number; raw: boolean; nulls: number };
/** Form/part words that make a food a different product than a plain recipe name (penalised unless asked for). */
const FORM_WORDS = new Set(["yolk", "white", "powder", "dry", "dried", "dehydrated", "juice", "concentrate", "flake", "substitute", "imitation", "blend", "babyfood", "pastry", "toaster", "frozen", "canned", "prepared", "breaded", "fried", "roll", "buttermilk"]);
let INDEX: Indexed[] | null = null;
function index(): Indexed[] {
  if (!INDEX) {
    INDEX = SNAP.foods
      .filter((r) => !SKIP_CATEGORIES.has(r[3] ?? ""))
      .map((row) => {
        const d = row[1];
        return { row, toks: new Set(tokens(d)), head: new Set(tokens(d.split(",")[0])), first: tokens(d)[0] ?? "", seg2: tokens(d.split(",")[1] ?? ""), len: d.length, raw: /\braw\b/i.test(d), nulls: row.slice(4).filter((v) => v === null).length };
      });
  }
  return INDEX;
}

export type Match = {
  source: "usda_fdc" | "open_food_facts";
  id: string;
  name: string;
  dataType: string;
  category?: string | null;
  brands?: string | null;
  nutrientsPer100g: Nutrients;
  ingredientsText?: string | null;
  allergens?: string[] | null;
  allergensStatus?: "listed" | "unknown";
  allergensSource?: "open_food_facts_contributors";
  labels?: string[] | null;
  sourceUrl: string;
  license: string;
  attribution: string;
  matchScore?: number;
};

/** Deterministic: every query token must appear in the description; head-noun and first-word hits, raw, Foundation, more complete nutrients and shorter names rank higher. */
export function fdcSearch(q: string, n: number): Match[] {
  const qt = [...new Set(tokens(q))];
  if (!qt.length) return [];
  const scored: [number, Indexed][] = [];
  for (const it of index()) {
    if (!qt.every((t) => it.toks.has(t))) continue;
    const headHits = qt.filter((t) => it.head.has(t)).length;
    const extra = it.toks.size - qt.length;
    const score = headHits * 10 + (qt.includes(it.first) ? 6 : 0) + (it.seg2.length && it.seg2.every((t) => qt.includes(t)) ? 3 : 0) - it.nulls * 1.5 + (it.raw ? 4 : 0) + (it.row[2] === "Foundation" ? 2 : 0) - extra * 0.8 - [...it.toks].filter((t) => FORM_WORDS.has(t) && !qt.includes(t)).length * 3 - it.len / 200;
    scored.push([score, it]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].row[0] - b[1].row[0]);
  return scored.slice(0, n).map(([score, { row }]) => {
    const release = RELEASE_BY_TYPE.get(row[2]) ?? row[2];
    const nut = Object.fromEntries(NUTRIENT_KEYS.map((k, i) => [k, (row[4 + i] as number | null) ?? null])) as Nutrients;
    return {
      source: "usda_fdc",
      id: String(row[0]),
      name: row[1],
      dataType: row[2],
      category: row[3],
      nutrientsPer100g: nut,
      sourceUrl: fdcFoodUrl(row[0]),
      license: "Public domain (CC0 1.0)",
      attribution: fdcAttribution(release),
      matchScore: Math.round(score * 100) / 100,
    };
  });
}

// ---------- Open Food Facts (barcode only) ----------
/** GTIN-8/12/13/14 with a valid check digit. */
export function validBarcode(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

type OffProduct = Record<string, unknown> & { code?: string; product_name?: string; brands?: string; nutriments?: Record<string, unknown>; ingredients_text?: string; allergens_tags?: unknown; labels_tags?: unknown; stores?: string };
type CacheEntry = { at: number; product: OffProduct | null };
const CACHE = new Map<string, CacheEntry>();
let reads: number[] = [];

/** Test hook only (no route exposes the cache). */
export function _resetOffState() {
  CACHE.clear();
  reads = [];
}
export const offCacheSize = () => CACHE.size;

export class SourceError extends Error {
  constructor(public code: "source_throttled" | "source_unavailable", msg: string) {
    super(msg);
  }
}

function cacheGet(code: string, now: number): CacheEntry | undefined {
  const e = CACHE.get(code);
  if (!e) return undefined;
  if (now - e.at > OFF_CACHE_TTL_MS) {
    CACHE.delete(code);
    return undefined;
  }
  return e;
}
function cachePut(code: string, product: OffProduct | null, now: number) {
  CACHE.delete(code);
  CACHE.set(code, { at: now, product });
  while (CACHE.size > OFF_CACHE_MAX_ENTRIES) CACHE.delete(CACHE.keys().next().value as string); // oldest first
}

/** One OFF product read (cached unaltered <= 24 h). null = OFF has no such product. */
export async function offProduct(code: string, now = Date.now()): Promise<OffProduct | null> {
  const hit = cacheGet(code, now);
  if (hit) return hit.product;
  reads = reads.filter((t) => now - t < 60_000);
  if (reads.length >= OFF_READS_PER_MIN) throw new SourceError("source_throttled", "Open Food Facts read budget (12/min) used; try again in a minute");
  reads.push(now);
  let res: Response;
  try {
    res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`, {
      headers: { "User-Agent": OFF_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(OFF_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new SourceError("source_unavailable", "Open Food Facts did not answer");
  }
  if (res.status === 429 || res.status === 503) throw new SourceError("source_throttled", `Open Food Facts answered ${res.status}`);
  if (res.status === 404) {
    cachePut(code, null, now);
    return null;
  }
  if (!res.ok) throw new SourceError("source_unavailable", `Open Food Facts answered ${res.status}`);
  let j: { status?: number; product?: OffProduct };
  try {
    j = (await res.json()) as typeof j;
  } catch {
    throw new SourceError("source_unavailable", "Open Food Facts sent invalid JSON");
  }
  const product = j.status === 1 && j.product && typeof j.product === "object" ? j.product : null;
  cachePut(code, product, now);
  return product;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Math.round(Number(v) * 1000) / 1000 : null);
const tagList = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0).map((x) => x.replace(/^[a-z]{2}:/, ""));
  return out.length ? out : null; // never []
};

export function offMatch(code: string, p: OffProduct): Match {
  const m = (p.nutriments ?? {}) as Record<string, unknown>;
  const sodiumG = num(m["sodium_100g"]);
  const allergens = tagList(p.allergens_tags);
  return {
    source: "open_food_facts",
    id: code,
    name: typeof p.product_name === "string" && p.product_name.trim() ? p.product_name.trim() : "(no name listed)",
    dataType: "Open Food Facts product",
    brands: typeof p.brands === "string" && p.brands.trim() ? p.brands.trim() : null,
    nutrientsPer100g: {
      energy_kcal: num(m["energy-kcal_100g"]),
      protein_g: num(m["proteins_100g"]),
      fat_g: num(m["fat_100g"]),
      sat_fat_g: num(m["saturated-fat_100g"]),
      carbs_g: num(m["carbohydrates_100g"]),
      sugars_g: num(m["sugars_100g"]),
      fiber_g: num(m["fiber_100g"]),
      sodium_mg: sodiumG === null ? null : Math.round(sodiumG * 1000 * 1000) / 1000,
    },
    ingredientsText: typeof p.ingredients_text === "string" && p.ingredients_text.trim() ? p.ingredients_text.trim() : null,
    allergens,
    allergensStatus: allergens ? "listed" : "unknown",
    allergensSource: "open_food_facts_contributors",
    labels: tagList(p.labels_tags),
    sourceUrl: offProductUrl(code),
    license: "ODbL 1.0 (database), DbCL 1.0 (contents)",
    attribution: offAttribution(code),
  };
}

// ---------- input ----------
export type ItemQuery = { q?: string; barcode?: string };
export type IngredientInput = { items: ItemQuery[]; n: number };
type Err = { ok: false; status: number; code: string; error: string };

function parseItem(raw: unknown, where: string): ItemQuery | Err {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, status: 400, code: "invalid_item", error: `${where} must be an object with q and/or barcode` };
  const r = raw as Record<string, unknown>;
  const out: ItemQuery = {};
  if (r.q !== undefined && r.q !== null && r.q !== "") {
    if (typeof r.q !== "string" || r.q.length > GI_MAX_Q_CHARS || !tokens(r.q).length) return { ok: false, status: 400, code: "invalid_q", error: `${where}.q must be an ingredient name or canonicalId (1-${GI_MAX_Q_CHARS} chars)` };
    out.q = r.q.trim();
  }
  if (r.barcode !== undefined && r.barcode !== null && r.barcode !== "") {
    const b = String(r.barcode).trim();
    if (!validBarcode(b)) return { ok: false, status: 400, code: "invalid_barcode", error: `${where}.barcode must be a GTIN-8, UPC-A (12), EAN-13 or GTIN-14 with a valid check digit` };
    out.barcode = b;
  }
  if (!out.q && !out.barcode) return { ok: false, status: 400, code: "missing_input", error: `${where} needs q and/or barcode` };
  return out;
}

export function parseIngredientInput(raw: Record<string, unknown>): { ok: true; input: IngredientInput } | Err {
  let n = 3;
  if (raw.n !== undefined && raw.n !== null && raw.n !== "") {
    const v = typeof raw.n === "number" ? raw.n : /^[0-9]{1,2}$/.test(String(raw.n)) ? Number(raw.n) : NaN;
    if (!Number.isInteger(v) || v < 1 || v > GI_MAX_N) return { ok: false, status: 400, code: "invalid_n", error: `n must be an integer 1-${GI_MAX_N}` };
    n = v;
  }
  let list: unknown[];
  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items) || raw.items.length === 0) return { ok: false, status: 400, code: "invalid_items", error: "items must be a non-empty array" };
    if (raw.items.length > GI_MAX_ITEMS) return { ok: false, status: 400, code: "too_many_items", error: `items is limited to ${GI_MAX_ITEMS}` };
    list = raw.items;
  } else {
    list = [{ q: raw.q, barcode: raw.barcode }];
  }
  const items: ItemQuery[] = [];
  for (let i = 0; i < list.length; i++) {
    const it = parseItem(list[i], raw.items !== undefined ? `items[${i}]` : "query");
    if ("ok" in it) return it;
    items.push(it);
  }
  return { ok: true, input: { items, n } };
}

// ---------- run ----------
export type ItemResult = {
  query: ItemQuery;
  matches: Match[];
  whereToBuy: { stores: string[] | null; productPage: string | null; note: string } | null;
  unknowns: string[];
};

export async function groceryIngredient(input: IngredientInput, now = Date.now()): Promise<
  { ok: true; items: ItemResult[]; attribution: string[]; disclaimer: string; fdcSnapshot: typeof FDC_SNAPSHOT_INFO; methodology: typeof GROCERY_INGREDIENT_METHODOLOGY } | Err
> {
  const items: ItemResult[] = [];
  let sourceErr: SourceError | null = null;
  let offAttempted = 0;
  for (const q of input.items) {
    const matches: Match[] = [];
    const unknowns: string[] = [];
    let whereToBuy: ItemResult["whereToBuy"] = null;
    if (q.barcode) {
      offAttempted++;
      try {
        const p = await offProduct(q.barcode, now);
        if (p) {
          const m = offMatch(q.barcode, p);
          matches.push(m);
          const stores = typeof p.stores === "string" ? p.stores.split(",").map((s) => s.trim()).filter(Boolean) : [];
          whereToBuy = {
            stores: stores.length ? stores : null,
            productPage: offProductUrl(q.barcode),
            note: "Store names as listed by Open Food Facts contributors (may be incomplete or out of date). No retailer links, no prices, no stock.",
          };
          if (!stores.length) unknowns.push("stores: none listed on Open Food Facts");
          if (m.allergensStatus === "unknown") unknowns.push("allergens: none listed on Open Food Facts (unknown, NOT allergen-free)");
          for (const k of NUTRIENT_KEYS) if (m.nutrientsPer100g[k] === null) unknowns.push(`open_food_facts ${k}: not listed`);
        } else unknowns.push(`barcode ${q.barcode}: not found on Open Food Facts`);
      } catch (e) {
        if (!(e instanceof SourceError)) throw e;
        sourceErr = e;
        unknowns.push(`barcode ${q.barcode}: Open Food Facts ${e.code === "source_throttled" ? "throttled" : "unavailable"}`);
      }
    }
    if (q.q) {
      const f = fdcSearch(q.q, input.n);
      if (f.length) {
        matches.push(...f);
        for (const m of f) for (const k of NUTRIENT_KEYS) if (m.nutrientsPer100g[k] === null) unknowns.push(`usda_fdc ${m.id} ${k}: not published in this release`);
      }
      else unknowns.push(`q "${q.q}": no USDA FoodData Central (Foundation / SR Legacy) match`);
    }
    if (!q.barcode) unknowns.push("allergens: not provided for USDA generic foods (give a barcode for Open Food Facts contributor data)");
    items.push({ query: q, matches, whereToBuy, unknowns });
  }
  const any = items.some((i) => i.matches.length > 0);
  if (!any) {
    if (sourceErr && offAttempted > 0) {
      return { ok: false, status: sourceErr.code === "source_throttled" ? 503 : 502, code: sourceErr.code, error: sourceErr.message };
    }
    return { ok: false, status: 404, code: "no_match", error: "No match in USDA FoodData Central or Open Food Facts" };
  }
  const attribution = [...new Set(items.flatMap((i) => i.matches.map((m) => m.attribution)))];
  if (items.some((i) => i.matches.some((m) => m.source === "open_food_facts"))) attribution.push(OFF_CACHE_DOCS_NOTE);
  return { ok: true, items, attribution, disclaimer: GROCERY_INGREDIENT_DISCLAIMER, fdcSnapshot: FDC_SNAPSHOT_INFO, methodology: GROCERY_INGREDIENT_METHODOLOGY };
}
