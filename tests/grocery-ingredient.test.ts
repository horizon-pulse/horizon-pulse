/**
 * /api/grocery/ingredient (NOT LAUNCHED, price unset). Odin build OK 2026-10-16 10:13 AM ET;
 * Counsel fixes 1-4 from to-odin/2026-10-15-counsel-nutrition-route-review.md.
 * No network: Open Food Facts is a stubbed fetch over one real fixture record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { NextRequest } from "next/server";
import * as GI from "@/lib/grocery-ingredient";
import { GROCERY_INGREDIENT_PRICE_ATOMIC, GROCERY_INGREDIENT_PRICE_USD } from "@/lib/config";
import { groceryIngredientRoutesFor } from "@/lib/x402-server";
import { groceryIngredientHandler } from "@/app/api/grocery/ingredient/handler";

const NUTELLA = JSON.parse(readFileSync("tests/fixtures/off/3017624010701.json", "utf8"));
const COUNSEL_DISCLAIMER =
  "Indicative data only. Open Food Facts data is entered by volunteers and USDA data describes generic or reported foods; values can be wrong, missing or out of date, and recipes and labels change. Allergen and ingredient fields may be incomplete: an empty or missing allergen list does NOT mean a product is free of any allergen or trace. Always check the product's own label. Not for medical, dietary or allergy decisions. Not advice.";
const COUNSEL_OFF = (b: string) =>
  `Contains information from Open Food Facts (https://openfoodfacts.org), which is made available here under the Open Database License (ODbL) https://opendatacommons.org/licenses/odbl/1-0/. Individual contents: Database Contents License (DbCL) https://opendatacommons.org/licenses/dbcl/1-0/. Product page: https://world.openfoodfacts.org/product/${b}.`;
const COUNSEL_FDC = (r: string) => `Source: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, ${r}. fdc.nal.usda.gov. Public domain (CC0 1.0).`;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;
const offOk = (product: unknown) => new Response(JSON.stringify({ status: 1, product }), { status: 200, headers: { "content-type": "application/json" } });
const get = (qs: string) => groceryIngredientHandler(new NextRequest(`http://localhost/api/grocery/ingredient?${qs}`));
const post = (body: unknown) => groceryIngredientHandler(new NextRequest("http://localhost/api/grocery/ingredient", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

/** Every string value and every key, recursively. */
function walk(x: unknown, f: (k: string | null, v: unknown) => void, k: string | null = null) {
  f(k, x);
  if (Array.isArray(x)) x.forEach((v) => walk(v, f, null));
  else if (x && typeof x === "object") for (const [kk, v] of Object.entries(x)) walk(v, f, kk);
}

beforeEach(() => {
  GI._resetOffState();
  fetchMock = vi.fn<FetchFn>(async () => offOk(NUTELLA.product));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("price and launch state", () => {
  it("price is UNSET (placeholder null) on this branch", () => {
    expect(GROCERY_INGREDIENT_PRICE_USD).toBeNull();
    expect(GROCERY_INGREDIENT_PRICE_ATOMIC).toBeNull();
  });
  it("route answers 503 not_launched on GET/POST/OPTIONS, never runs the handler, never emits a 402", async () => {
    const mod = await import("@/app/api/grocery/ingredient/route");
    expect(Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(["GET", "OPTIONS", "POST"]);
    for (const res of [
      await mod.GET(new NextRequest("http://localhost/api/grocery/ingredient?q=egg")),
      await mod.POST(new NextRequest("http://localhost/api/grocery/ingredient", { method: "POST", body: "{}" })),
      await mod.OPTIONS(),
    ]) {
      expect(res.status).toBe(503);
      expect(res.headers.get("payment-required")).toBeNull();
      expect((await res.json()).code).toBe("not_launched");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("route config refuses to build without an explicit price", () => {
    expect(() => groceryIngredientRoutesFor("" as string)).toThrow(/explicit USD price/);
  });
  it("Bazaar examples validate against their declared schemas (GET strings, POST integer n) with a test price", () => {
    const r = groceryIngredientRoutesFor("$0.005") as Record<string, { extensions?: { bazaar?: { info: unknown; schema: object } } }>;
    expect(Object.keys(r).sort()).toEqual(["/api/grocery/ingredient", "GET /api/grocery/ingredient", "POST /api/grocery/ingredient"].sort());
    for (const key of ["GET /api/grocery/ingredient", "POST /api/grocery/ingredient"]) {
      const bz = r[key].extensions!.bazaar!;
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      expect({ key, errors: ajv.validate(bz.schema, bz.info) ? null : ajv.errorsText(ajv.errors) }).toEqual({ key, errors: null });
    }
  });
});

describe("USDA FDC snapshot", () => {
  it("bundled snapshot is pinned (sha256) and built from the pinned releases", () => {
    const text = readFileSync("lib/data/fdc-snapshot.json", "utf8");
    expect(createHash("sha256").update(text).digest("hex")).toBe("7c982220a1abe9e31f473f233ef8e8c4f6c08091b54bc4d7f5f371ec1cb66957");
    expect(GI.FDC_SNAPSHOT_INFO.map((s) => s.release)).toEqual(["Foundation Foods, April 2026", "SR Legacy, April 2018"]);
    expect(GI.FDC_SNAPSHOT_INFO.map((s) => s.foods)).toEqual([363, 7793]);
  });
  it.each([
    ["all-purpose-flour", /^Flour, wheat, all-purpose/],
    ["egg", /^Egg, whole, raw/],
    ["olive oil", /^Oil, olive/],
    ["whole milk", /^Milk, whole/],
    ["garlic", /^Garlic, raw/],
    ["baking soda", /baking soda/],
  ])("q=%s top match", (q, re) => {
    expect(GI.fdcSearch(q, 1)[0]?.name).toMatch(re);
  });
  it("FDC match carries the Counsel citation with the release and CC0, and a fdc.nal.usda.gov link", async () => {
    const j = await (await get("q=egg&n=1")).json();
    const m = j.items[0].matches[0];
    expect(m.source).toBe("usda_fdc");
    expect(m.attribution).toBe(COUNSEL_FDC("SR Legacy, April 2018"));
    expect(m.license).toBe("Public domain (CC0 1.0)");
    expect(m.sourceUrl).toBe(`https://fdc.nal.usda.gov/food-details/${m.id}/nutrients`);
    expect(j.attribution).toEqual([COUNSEL_FDC("SR Legacy, April 2018")]);
    expect(fetchMock).not.toHaveBeenCalled(); // q only: no outbound call
  });
});

describe("Open Food Facts by barcode (Counsel fixes 1-4)", () => {
  it("OFF match: Counsel ODbL/DbCL notice + product link, allergens listed, stores text only, sodium g->mg", async () => {
    const res = await get("barcode=3017624010701");
    expect(res.status).toBe(200);
    const j = await res.json();
    const it0 = j.items[0];
    const m = it0.matches[0];
    expect(m.source).toBe("open_food_facts");
    expect(m.attribution).toBe(COUNSEL_OFF("3017624010701"));
    expect(m.sourceUrl).toBe("https://world.openfoodfacts.org/product/3017624010701");
    expect(m.allergens).toEqual(["nuts"]);
    expect(m.allergensStatus).toBe("listed");
    expect(m.allergensSource).toBe("open_food_facts_contributors");
    expect(m.nutrientsPer100g).toMatchObject({ energy_kcal: 539, sodium_mg: 43 });
    expect(it0.whereToBuy).toEqual({ stores: ["Sainsbury's", "Tesco"], productPage: "https://world.openfoodfacts.org/product/3017624010701", note: expect.stringMatching(/No retailer links/) });
    expect(j.attribution).toContain(COUNSEL_OFF("3017624010701"));
    expect(j.attribution).toContain("Cached Open Food Facts records are unaltered copies; full data: https://world.openfoodfacts.org/data (ODbL).");
    expect(j.disclaimer).toBe(COUNSEL_DISCLAIMER);
  });
  it.each([
    ["empty list", { ...NUTELLA.product, allergens_tags: [] }],
    ["missing field", (({ allergens_tags: _a, ...rest }) => rest)(NUTELLA.product)],
    ["non-array", { ...NUTELLA.product, allergens_tags: "nuts" }],
  ])("allergens %s -> null + unknown, never []", async (_l, product) => {
    fetchMock.mockImplementation(async () => offOk(product));
    const j = await (await get("barcode=3017624010701")).json();
    const m = j.items[0].matches[0];
    expect(m.allergens).toBeNull();
    expect(m.allergensStatus).toBe("unknown");
    expect(j.items[0].unknowns.join(" ")).toMatch(/NOT allergen-free/);
    walk(j, (k, v) => { if (k === "allergens") expect(v).not.toEqual([]); });
  });
  it("no retailer links: every URL in a response is OFF, ODbL/DbCL or FDC; no price/stock fields", async () => {
    const j = await (await post({ items: [{ barcode: "3017624010701" }, { q: "butter" }] })).json();
    const urls: string[] = [];
    walk(j, (k, v) => {
      if (typeof v === "string") urls.push(...(v.match(/https?:\/\/[^\s)"]+/g) ?? []));
      if (k && k !== "priced") expect(k.toLowerCase()).not.toMatch(/price|stock|affiliate|retailer/); // priced = our own fee block
    });
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(new URL(u).hostname).toMatch(/^(world\.)?openfoodfacts\.org$|^opendatacommons\.org$|^fdc\.nal\.usda\.gov$/);
  });
  it("OFF request: barcode-only product URL, our User-Agent, no other host ever fetched", async () => {
    await get("barcode=3017624010701&q=hazelnut");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\/3017624010701\.json\?fields=/);
    expect((init!.headers as Record<string, string>)["User-Agent"]).toBe(GI.OFF_USER_AGENT);
    expect(GI.OFF_USER_AGENT).toMatch(/^HorizonPulse\/1\.0 \(.+@.+\)$/);
  });
  it("cache: unaltered record reused within 24 h (one fetch), refetched after 24 h", async () => {
    const t0 = Date.parse("2026-10-16T12:00:00Z");
    const a = await GI.offProduct("3017624010701", t0);
    const b = await GI.offProduct("3017624010701", t0 + 23 * 3600_000);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await GI.offProduct("3017624010701", t0 + 24 * 3600_000 + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("cache: hard size cap, oldest evicted first", async () => {
    expect(GI.OFF_CACHE_MAX_ENTRIES).toBe(2000);
    let t = Date.parse("2026-10-16T12:00:00Z");
    for (let i = 0; i < GI.OFF_CACHE_MAX_ENTRIES + 5; i++) {
      t += 6_000; // stay under 12 reads/min
      await GI.offProduct(String(10000000 + i), t);
    }
    expect(GI.offCacheSize()).toBe(GI.OFF_CACHE_MAX_ENTRIES);
  });
  it("cache is not exposed: the module exports no list/dump/export function", () => {
    expect(Object.keys(GI).filter((k) => /dump|export|list|all|bulk/i.test(k))).toEqual([]);
  });
  it("rate limit: 13th uncached read within a minute -> 503 source_throttled, not charged", async () => {
    const t = Date.now();
    for (let i = 0; i < 12; i++) await GI.offProduct(String(20000000 + i), t);
    const res = await get("barcode=96385074");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "source_throttled", charged: false });
  });
  it.each([
    ["429", async () => new Response("", { status: 429 }), 503, "source_throttled"],
    ["503", async () => new Response("", { status: 503 }), 503, "source_throttled"],
    ["500", async () => new Response("", { status: 500 }), 502, "source_unavailable"],
    ["network error", async () => { throw new TypeError("fetch failed"); }, 502, "source_unavailable"],
    ["not found", async () => new Response(JSON.stringify({ status: 0 }), { status: 200 }), 404, "no_match"],
  ])("OFF %s with no other match -> mapped status/code, not charged", async (_l, impl, status, code) => {
    fetchMock.mockImplementation(impl as FetchFn);
    const res = await get("barcode=3017624010701");
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code, charged: false });
  });
  it("OFF down but USDA matched -> 200 with the OFF failure in unknowns", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    const res = await post({ items: [{ barcode: "3017624010701" }, { q: "garlic" }] });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.items[0].unknowns.join(" ")).toMatch(/throttled/);
    expect(j.items[1].matches[0].source).toBe("usda_fdc");
  });
});

describe("input validation (400, not charged)", () => {
  it.each([
    ["", "missing_input"],
    ["q=", "missing_input"],
    ["barcode=3017624010702", "invalid_barcode"], // bad check digit
    ["barcode=12345", "invalid_barcode"],
    ["q=egg&n=6", "invalid_n"],
    ["q=egg&n=x", "invalid_n"],
    [`q=${"a".repeat(101)}`, "invalid_q"],
  ])("GET %s -> %s", async (qs, code) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code, charged: false });
  });
  it("POST: items limits and JSON errors", async () => {
    expect((await (await post({ items: [] })).json()).code).toBe("invalid_items");
    expect((await (await post({ items: Array.from({ length: 11 }, () => ({ q: "egg" })) })).json()).code).toBe("too_many_items");
    expect((await (await post({ items: ["egg"] })).json()).code).toBe("invalid_item");
    const res = await groceryIngredientHandler(new NextRequest("http://localhost/api/grocery/ingredient", { method: "POST", body: "{", headers: { "content-type": "application/json" } }));
    expect((await res.json()).code).toBe("invalid_json");
  });
  it("no match anywhere -> 404 no_match, not charged", async () => {
    const res = await get("q=zzqxv");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "no_match", charged: false });
  });
  it("barcode check digit validator", () => {
    expect(GI.validBarcode("3017624010701")).toBe(true);
    expect(GI.validBarcode("96385074")).toBe(true);
    expect(GI.validBarcode("036000291452")).toBe(true);
    expect(GI.validBarcode("036000291453")).toBe(false);
  });
});
