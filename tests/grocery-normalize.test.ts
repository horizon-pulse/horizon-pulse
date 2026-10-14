import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { parseGroceryInput, groceryNormalize, normalizeLine, GN_MAX_LINES } from "@/lib/grocery-normalize";
import { groceryNormalizeHandler } from "@/app/api/grocery/normalize/handler";
import { ROUTE_METADATA } from "@/lib/route-metadata";

const post = (body: unknown, raw = false) =>
  new NextRequest("https://horizonpulse.dev/api/grocery/normalize", { method: "POST", body: raw ? (body as string) : JSON.stringify(body), headers: { "content-type": "application/json" } });
const get = (qs: string) => new NextRequest(`https://horizonpulse.dev/api/grocery/normalize?${qs}`);

describe("input validation (never charged: status >= 400)", () => {
  it("missing, empty, oversize and paired-servings errors are 400", () => {
    expect(parseGroceryInput({})).toMatchObject({ ok: false, status: 400, code: "missing_ingredients" });
    expect(parseGroceryInput({ ingredients: ["", "  "] })).toMatchObject({ ok: false, code: "missing_ingredients" });
    expect(parseGroceryInput({ ingredients: "flour" })).toMatchObject({ ok: false, code: "invalid_ingredients" });
    expect(parseGroceryInput({ ingredients: Array(GN_MAX_LINES + 1).fill("1 egg") })).toMatchObject({ ok: false, code: "too_many_lines" });
    expect(parseGroceryInput({ ingredients: ["x".repeat(201)] })).toMatchObject({ ok: false, code: "line_too_long" });
    expect(parseGroceryInput({ ingredients: ["1 egg"], servings: 4 })).toMatchObject({ ok: false, code: "servings_pair" });
    expect(parseGroceryInput({ ingredients: ["1 egg"], servings: 0, targetServings: 2 })).toMatchObject({ ok: false, code: "invalid_servings" });
    expect(parseGroceryInput({ text: "x".repeat(10_001) })).toMatchObject({ ok: false, code: "text_too_long" });
  });
  it("handler: bad JSON 400, empty parse 422, both charged:false", async () => {
    const a = await groceryNormalizeHandler(post("{nope", true));
    expect(a.status).toBe(400);
    expect((await a.json()).charged).toBe(false);
    const b = await groceryNormalizeHandler(post({ ingredients: ["For the sauce:", "!!!"] }));
    expect(b.status).toBe(422);
    expect(await b.json()).toMatchObject({ code: "no_ingredients_parsed", charged: false });
    const c = await groceryNormalizeHandler(post("x".repeat(20_001), true));
    expect(c.status).toBe(400);
  });
});

describe("parsing", () => {
  it("quantities, fractions, unicode, ranges, units, notes, packs", () => {
    expect(normalizeLine("2 cups all-purpose flour", 1)).toMatchObject({ canonicalId: "all-purpose-flour", qty: 2, unit: "cup", metric: { value: 473.2, unit: "ml" }, category: "baking" });
    expect(normalizeLine("1 1/2 tsp salt", 1)).toMatchObject({ qty: 1.5, unit: "tsp", category: "spices_seasonings" });
    expect(normalizeLine("1½ cups whole milk", 1)).toMatchObject({ qty: 1.5, canonicalId: "milk" });
    expect(normalizeLine("½ cup sugar", 1)).toMatchObject({ qty: 0.5, unit: "cup" });
    expect(normalizeLine("2-3 cloves garlic, minced", 1)).toMatchObject({ qty: 2, qtyMax: 3, unit: "clove", prepNote: "minced", canonicalId: "garlic" });
    expect(normalizeLine("1 (14 oz) can diced tomatoes", 1)).toMatchObject({ unit: "can", statedPackSize: "14 oz", category: "pantry" });
    expect(normalizeLine("1 lb ground beef", 1)).toMatchObject({ metric: { value: 453.6, unit: "g" }, packHint: { typicalPack: "1 lb (454 g)", packsNeeded: 1 } });
    expect(normalizeLine("Salt and pepper to taste", 1)).toMatchObject({ toTaste: true, qty: null });
    expect(normalizeLine("1/2 cup grated Parmesan cheese (optional)", 1)).toMatchObject({ optional: true, canonicalId: "parmesan-cheese" });
    expect(normalizeLine("3 large eggs", 1)).toMatchObject({ canonicalId: "egg", unit: "each", packHint: { packsNeeded: 1 } });
    expect(normalizeLine("13 eggs", 1).packHint).toMatchObject({ packsNeeded: 2 });
  });
  it("volume is never converted to mass (no density guesses)", () => {
    const f = normalizeLine("2 cups flour", 1);
    expect(f.metric?.unit).toBe("ml");
    expect(f.packHint).toMatchObject({ typicalPack: "5 lb (2.27 kg)", packsNeeded: null });
  });
  it("scales and merges duplicates by canonical id and dimension; headings go to unparsed", () => {
    const p = parseGroceryInput({ text: "For the dough:\n- 2 cups flour\n- 1 cup flour\n3 eggs\n2 tbsp butter\n1 stick butter", servings: 2, targetServings: 4 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const r = groceryNormalize(p.input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scale.factor).toBe(2);
    expect(r.unparsed).toEqual(["For the dough:"]);
    const flour = r.shoppingList.find((m) => m.canonicalId === "flour")!;
    expect(flour.from).toEqual([0, 1]);
    expect(flour.metric).toEqual({ value: 1419.6, unit: "ml" });
    expect(r.shoppingList.filter((m) => m.canonicalId === "butter")).toHaveLength(2); // volume vs stick: not merged
    expect(r.items.find((i) => i.canonicalId === "egg")!.qty).toBe(6);
  });
  it("deterministic: same input, same output (except asOf)", async () => {
    const body = { ingredients: ["2 cups flour", "3 eggs"], servings: 4, targetServings: 6 };
    const a = await (await groceryNormalizeHandler(post(body))).json();
    const b = await (await groceryNormalizeHandler(post(body))).json();
    delete a.asOf; delete b.asOf;
    expect(a).toEqual(b);
    expect(a.source).toBe("grocery-normalize");
    expect(a.priced).toMatchObject({ amountUsd: "$0.002", amountAtomic: "2000" });
  });
  it("GET form with | separated lines matches POST", async () => {
    const g = await (await groceryNormalizeHandler(get("ingredients=2%20cups%20flour%7C3%20eggs"))).json();
    const p = await (await groceryNormalizeHandler(post({ ingredients: ["2 cups flour", "3 eggs"] }))).json();
    delete g.asOf; delete p.asOf;
    expect(g).toEqual(p);
  });
  it("no outbound calls", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("network used"); }) as typeof fetch;
    try {
      const r = await groceryNormalizeHandler(post({ ingredients: ["1 lb ground beef"] }));
      expect(r.status).toBe(200);
    } finally { globalThis.fetch = orig; }
  });
  it("description makes no price, retailer or platform-compatibility claims", () => {
    const d = ROUTE_METADATA["/api/grocery/normalize"].description;
    expect(d).toMatch(/no prices/);
    expect(d).not.toMatch(/grok|kroger|walmart|instacart|amazon|\btarget\b/i);
  });
});
