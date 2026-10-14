/**
 * /api/grocery/normalize: recipe ingredient lines -> a normalized, scaled
 * shopping list (name, canonical id, quantity, unit, metric value, category,
 * typical pack hint). Deterministic: no network, no third-party data, no LLM.
 * Unit factors are exact SI conversions; pack hints come from our own small
 * in-repo table (typical US pack sizes, not a retailer listing, not a price).
 * Nothing is stored or logged.
 */

export const GN_MAX_LINES = 100;
export const GN_MAX_LINE_CHARS = 200;
export const GN_MAX_TEXT_CHARS = 10_000;
export const GN_MAX_BODY_BYTES = 20_000;

export const GROCERY_NORMALIZE_METHODOLOGY = {
  parser: "Deterministic rule-based parser (quantities incl. fractions, unicode fractions and ranges; unit aliases; parenthetical pack sizes; prep notes after a comma). No network, no third-party data, no AI model.",
  units: "Volume converts to ml and mass to g with exact factors (US customary: tsp 4.92892 ml, tbsp 14.7868 ml, cup 236.588 ml, fl oz 29.5735 ml, pint 473.176 ml, quart 946.353 ml, gallon 3785.41 ml; oz 28.3495 g, lb 453.592 g). Volume is never converted to mass (no density guesses). Count units stay counts.",
  packs: "packHint is from a small Horizon Pulse table of typical US pack sizes, for planning only. It is not a retailer listing, not stock and not a price.",
  scaling: "If servings and targetServings are both given, every quantity is multiplied by targetServings / servings.",
  storage: "Nothing is stored or logged.",
} as const;

type Dim = "volume" | "mass" | "count";
type UnitDef = { unit: string; dim: Dim; toBase: number };

const U = (unit: string, dim: Dim, toBase: number): UnitDef => ({ unit, dim, toBase });
const UNITS: Record<string, UnitDef> = {};
function alias(def: UnitDef, ...names: string[]) {
  for (const n of [def.unit, ...names]) UNITS[n] = def;
}
alias(U("tsp", "volume", 4.92892), "teaspoon", "teaspoons", "tsps", "t");
alias(U("tbsp", "volume", 14.7868), "tablespoon", "tablespoons", "tbsps", "tbs", "tbl", "T");
alias(U("cup", "volume", 236.588), "cups", "c");
alias(U("fl oz", "volume", 29.5735), "fl. oz", "fl.oz", "floz", "fluid ounce", "fluid ounces");
alias(U("pint", "volume", 473.176), "pints", "pt");
alias(U("quart", "volume", 946.353), "quarts", "qt");
alias(U("gallon", "volume", 3785.41), "gallons", "gal");
alias(U("ml", "volume", 1), "milliliter", "milliliters", "millilitre", "millilitres", "mL");
alias(U("l", "volume", 1000), "liter", "liters", "litre", "litres", "L");
alias(U("oz", "mass", 28.3495), "ounce", "ounces");
alias(U("lb", "mass", 453.592), "lbs", "pound", "pounds");
alias(U("g", "mass", 1), "gram", "grams", "gr");
alias(U("kg", "mass", 1000), "kilogram", "kilograms", "kilo", "kilos");
for (const c of ["clove", "can", "package", "stick", "slice", "bunch", "head", "sprig", "pinch", "dash", "jar", "bag", "bottle", "piece", "box"]) {
  alias(U(c, "count", 1), `${c}s`, `${c}es`);
}
alias(U("package", "count", 1), "pkg", "pkgs", "packet", "packets", "pack", "packs");

const UNICODE_FRACTIONS: Record<string, number> = { "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75, "⅕": 0.2, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };

const DESCRIPTORS = new Set(["fresh", "freshly", "large", "small", "medium", "chopped", "diced", "minced", "sliced", "grated", "shredded", "softened", "melted", "unsalted", "salted", "boneless", "skinless", "finely", "roughly", "thinly", "peeled", "whole", "extra", "virgin", "packed", "light", "dark", "of", "a", "an", "the", "about", "plus", "more", "for", "serving", "cold", "warm", "room", "temperature", "optional"]);

const CATEGORIES: [string, string[]][] = [
  ["dairy_eggs", ["milk", "butter", "cheese", "cream", "yogurt", "egg", "parmesan", "mozzarella", "cheddar", "buttermilk"]],
  ["meat_seafood", ["chicken", "beef", "pork", "bacon", "sausage", "turkey", "lamb", "salmon", "shrimp", "fish", "tuna", "ham"]],
  ["produce", ["onion", "garlic", "tomato", "potato", "carrot", "celery", "lemon", "lime", "apple", "banana", "pepper bell", "bell pepper", "spinach", "lettuce", "basil", "parsley", "cilantro", "ginger", "mushroom", "zucchini", "cucumber", "avocado", "scallion", "shallot", "thyme", "rosemary", "kale", "broccoli"]],
  ["spices_seasonings", ["salt", "black pepper", "pepper", "cumin", "paprika", "oregano", "cinnamon", "nutmeg", "chili powder", "vanilla", "bay leaf", "turmeric"]],
  ["baking", ["flour", "sugar", "baking powder", "baking soda", "yeast", "cocoa", "chocolate chip", "cornstarch", "brown sugar", "honey"]],
  ["pantry", ["oil", "olive oil", "vinegar", "rice", "pasta", "spaghetti", "bean", "broth", "stock", "soy sauce", "tomato paste", "tomato sauce", "oat", "breadcrumb", "mustard", "ketchup", "mayonnaise", "lentil", "noodle"]],
  ["bakery", ["bread", "tortilla", "bun", "baguette"]],
  ["frozen", ["frozen"]],
];

/** Typical US pack sizes (Horizon Pulse table; planning only, no retailer data). base = ml, g or count. */
const PACKS: Record<string, { label: string; dim: Dim; base: number }> = {
  egg: { label: "1 dozen (12)", dim: "count", base: 12 },
  butter: { label: "1 lb (4 sticks, 454 g)", dim: "mass", base: 453.592 },
  milk: { label: "1 gallon (3.79 l)", dim: "volume", base: 3785.41 },
  "all-purpose-flour": { label: "5 lb (2.27 kg)", dim: "mass", base: 2267.96 },
  flour: { label: "5 lb (2.27 kg)", dim: "mass", base: 2267.96 },
  sugar: { label: "4 lb (1.81 kg)", dim: "mass", base: 1814.37 },
  "brown-sugar": { label: "2 lb (907 g)", dim: "mass", base: 907.185 },
  "olive-oil": { label: "500 ml bottle", dim: "volume", base: 500 },
  "heavy-cream": { label: "1 pint (473 ml)", dim: "volume", base: 473.176 },
  "chicken-broth": { label: "32 fl oz carton (946 ml)", dim: "volume", base: 946.353 },
  rice: { label: "2 lb (907 g)", dim: "mass", base: 907.185 },
  pasta: { label: "1 lb box (454 g)", dim: "mass", base: 453.592 },
  spaghetti: { label: "1 lb box (454 g)", dim: "mass", base: 453.592 },
  "ground-beef": { label: "1 lb (454 g)", dim: "mass", base: 453.592 },
  "parmesan-cheese": { label: "8 oz (227 g)", dim: "mass", base: 226.796 },
};

export type NormalizedItem = {
  raw: string;
  name: string;
  canonicalId: string;
  qty: number | null;
  qtyMax: number | null;
  unit: string | null;
  dimension: Dim | null;
  metric: { value: number; unit: "ml" | "g" } | null;
  category: string;
  optional: boolean;
  toTaste: boolean;
  prepNote: string | null;
  statedPackSize: string | null;
  packHint: { typicalPack: string; packsNeeded: number | null } | null;
  confidence: "high" | "medium" | "low";
};

export type GroceryNormalizeInput = { lines: string[]; servings: number | null; targetServings: number | null };

type ParseErr = { ok: false; status: 400; code: string; error: string };

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

function intOrNull(v: unknown, name: string): number | null | ParseErr {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v));
  if (!Number.isInteger(n) || n < 1 || n > 100) return { ok: false, status: 400, code: `invalid_${name}`, error: `${name} must be an integer from 1 to 100` };
  return n;
}

/** Validate the request (body or query) before anything else. Never charged on failure. */
export function parseGroceryInput(raw: { ingredients?: unknown; text?: unknown; servings?: unknown; targetServings?: unknown }): { ok: true; input: GroceryNormalizeInput } | ParseErr {
  let lines: string[] = [];
  if (raw.ingredients !== undefined && raw.ingredients !== null) {
    if (!Array.isArray(raw.ingredients) || raw.ingredients.some((x) => typeof x !== "string")) {
      return { ok: false, status: 400, code: "invalid_ingredients", error: "ingredients must be an array of strings" };
    }
    lines = raw.ingredients as string[];
  } else if (typeof raw.text === "string") {
    if (raw.text.length > GN_MAX_TEXT_CHARS) return { ok: false, status: 400, code: "text_too_long", error: `text is limited to ${GN_MAX_TEXT_CHARS} characters` };
    lines = raw.text.split(/\r?\n/);
  } else {
    return { ok: false, status: 400, code: "missing_ingredients", error: "Send ingredients (array of lines) or text (one ingredient per line)" };
  }
  lines = lines.map((l) => l.replace(/^\s*(?:[-*•▪◦]|\d+[.)])\s+/, "").trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: false, status: 400, code: "missing_ingredients", error: "No ingredient lines given" };
  if (lines.length > GN_MAX_LINES) return { ok: false, status: 400, code: "too_many_lines", error: `At most ${GN_MAX_LINES} ingredient lines` };
  if (lines.some((l) => l.length > GN_MAX_LINE_CHARS)) return { ok: false, status: 400, code: "line_too_long", error: `Each line is limited to ${GN_MAX_LINE_CHARS} characters` };
  const servings = intOrNull(raw.servings, "servings");
  if (servings && typeof servings === "object") return servings;
  const targetServings = intOrNull(raw.targetServings, "targetServings");
  if (targetServings && typeof targetServings === "object") return targetServings;
  if ((servings === null) !== (targetServings === null)) {
    return { ok: false, status: 400, code: "servings_pair", error: "Give both servings and targetServings to scale, or neither" };
  }
  return { ok: true, input: { lines, servings: servings as number | null, targetServings: targetServings as number | null } };
}

function parseNumber(tok: string): number | null {
  if (UNICODE_FRACTIONS[tok] !== undefined) return UNICODE_FRACTIONS[tok];
  const mixedUni = tok.match(/^(\d+)([½⅓⅔¼¾⅕⅛⅜⅝⅞])$/);
  if (mixedUni) return Number(mixedUni[1]) + UNICODE_FRACTIONS[mixedUni[2]];
  const frac = tok.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[2]) === 0 ? null : Number(frac[1]) / Number(frac[2]);
  if (/^\d+(?:\.\d+)?$/.test(tok)) return Number(tok);
  return null;
}

/** Reads a leading quantity (incl. "1 1/2", "1½", "2-3", "2 to 3"). Returns [qty, qtyMax, rest]. */
function readQuantity(s: string): [number | null, number | null, string] {
  const toks = s.replace(/([½⅓⅔¼¾⅕⅛⅜⅝⅞])/g, " $1 ").replace(/(\d)\s+([½⅓⅔¼¾⅕⅛⅜⅝⅞])/g, "$1$2").trim().split(/\s+/);
  let i = 0;
  let q: number | null = null;
  const a = toks[0] !== undefined ? parseNumber(toks[0]) : null;
  if (a === null) {
    const range = toks[0]?.match(/^(\d+(?:\.\d+)?)[-–](\d+(?:\.\d+)?)$/);
    if (range) return [Number(range[1]), Number(range[2]), toks.slice(1).join(" ")];
    return [null, null, s];
  }
  q = a;
  i = 1;
  const b = toks[1] !== undefined && /^\d+\/\d+$/.test(toks[1]) ? parseNumber(toks[1]) : null;
  if (b !== null && Number.isInteger(a)) {
    q = a + b;
    i = 2;
  }
  if ((toks[i] === "-" || toks[i] === "–" || toks[i] === "to") && toks[i + 1] !== undefined) {
    const hi = parseNumber(toks[i + 1]);
    if (hi !== null) return [q, hi, toks.slice(i + 2).join(" ")];
  }
  return [q, null, toks.slice(i).join(" ")];
}

function readUnit(s: string): [UnitDef | null, string] {
  const m = s.match(/^(fl\.?\s?oz|fluid ounces?|[A-Za-z]+)\.?(?=\s|$)\s*(.*)$/);
  if (!m) return [null, s];
  const key = m[1].replace(/\s+/g, " ");
  const def = UNITS[key] ?? UNITS[key.toLowerCase()];
  // single letters t/T/c only count as units when followed by more text
  if (!def) return [null, s];
  if (key.length === 1 && !m[2]) return [null, s];
  return [def, m[2].replace(/^of\s+/i, "")];
}

function singular(w: string): string {
  if (/(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/(oes|ches|shes|xes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && w.length > 3) return w.slice(0, -1);
  return w;
}

function canonical(name: string): string {
  const words = name.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter((w) => w && !DESCRIPTORS.has(w)).map(singular);
  return words.join("-") || "unknown";
}

function categoryOf(id: string): string {
  const spaced = ` ${id.replace(/-/g, " ")} `;
  let best: [string, number] = ["other", 0];
  for (const [cat, keys] of CATEGORIES) {
    for (const k of keys) if (spaced.includes(` ${k} `) || spaced.includes(` ${k}s `)) if (k.length > best[1]) best = [cat, k.length];
  }
  return best[0];
}

export function normalizeLine(raw: string, factor: number): NormalizedItem {
  let s = raw;
  const lower = s.toLowerCase();
  const optional = /\boptional\b/.test(lower);
  const toTaste = /\bto taste\b|\bas needed\b/.test(lower);
  s = s.replace(/\b(to taste|as needed)\b/gi, "").replace(/\(\s*optional\s*\)|,?\s*optional\b/gi, "");
  let statedPackSize: string | null = null;
  s = s.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    if (!statedPackSize && /\d/.test(inner)) statedPackSize = inner.trim();
    return " ";
  });
  const [q, qMax, rest1] = readQuantity(s.trim());
  const [unitDef, rest2] = q !== null ? readUnit(rest1.trim()) : [null, rest1];
  let name = rest2.trim();
  let prepNote: string | null = null;
  const comma = name.indexOf(",");
  if (comma > 0) {
    prepNote = name.slice(comma + 1).trim() || null;
    name = name.slice(0, comma).trim();
  }
  name = name.replace(/\s+/g, " ").replace(/[.;:]+$/, "").trim();
  const canonicalId = canonical(name);
  const qty = q === null ? null : round(q * factor);
  const qtyMax = qMax === null ? null : round(qMax * factor);
  const dim: Dim | null = unitDef ? unitDef.dim : q !== null ? "count" : null;
  const unit = unitDef ? unitDef.unit : q !== null ? "each" : null;
  const metric = unitDef && unitDef.dim !== "count" && qty !== null ? { value: round((qtyMax ?? qty) * unitDef.toBase, 1), unit: (unitDef.dim === "volume" ? "ml" : "g") as "ml" | "g" } : null;
  const base = metric ? metric.value : dim === "count" && unit === "each" ? (qtyMax ?? qty) : null;
  const p = PACKS[canonicalId];
  const packHint = p ? { typicalPack: p.label, packsNeeded: base !== null && p.dim === (metric ? (unitDef!.dim) : "count") ? Math.max(1, Math.ceil(base / p.base - 0.005) /* 0.5% tolerance for rounding */) : null } : null;
  const confidence: NormalizedItem["confidence"] = canonicalId === "unknown" ? "low" : q !== null && (unitDef || dim === "count") ? "high" : toTaste ? "high" : "medium";
  return { raw, name, canonicalId, qty, qtyMax, unit, dimension: dim, metric, category: unit === "can" || unit === "jar" ? "pantry" : categoryOf(canonicalId), optional, toTaste, prepNote, statedPackSize, packHint, confidence };
}

export type MergedLine = { canonicalId: string; unit: string | null; qty: number | null; metric: NormalizedItem["metric"]; from: number[] };

export function groceryNormalize(input: GroceryNormalizeInput):
  | { ok: true; scale: { servings: number | null; targetServings: number | null; factor: number }; items: NormalizedItem[]; shoppingList: MergedLine[]; unparsed: string[]; methodology: typeof GROCERY_NORMALIZE_METHODOLOGY }
  | { ok: false; status: 422; code: "no_ingredients_parsed"; error: string } {
  const factor = input.servings && input.targetServings ? input.targetServings / input.servings : 1;
  const items: NormalizedItem[] = [];
  const unparsed: string[] = [];
  for (const line of input.lines) {
    const it = normalizeLine(line, factor);
    if (it.canonicalId === "unknown" || /^[A-Z\s]+:?$/.test(line) || /:$/.test(line)) unparsed.push(line);
    else items.push(it);
  }
  if (items.length === 0) return { ok: false, status: 422, code: "no_ingredients_parsed", error: "No ingredient could be parsed from the input" };
  const merged = new Map<string, MergedLine>();
  items.forEach((it, idx) => {
    const key = `${it.canonicalId}|${it.dimension ?? "none"}|${it.dimension === "count" ? it.unit : ""}`;
    const m = merged.get(key);
    if (!m) {
      merged.set(key, { canonicalId: it.canonicalId, unit: it.metric ? it.metric.unit : it.unit, qty: it.metric ? it.metric.value : it.qtyMax ?? it.qty, metric: it.metric, from: [idx] });
    } else {
      const add = it.metric ? it.metric.value : it.qtyMax ?? it.qty;
      m.qty = m.qty === null || add === null ? null : round(m.qty + add, 1);
      if (m.metric && it.metric) m.metric = { value: round(m.metric.value + it.metric.value, 1), unit: m.metric.unit };
      m.from.push(idx);
    }
  });
  return { ok: true, scale: { servings: input.servings, targetServings: input.targetServings, factor: round(factor, 4) }, items, shoppingList: [...merged.values()], unparsed, methodology: GROCERY_NORMALIZE_METHODOLOGY };
}
