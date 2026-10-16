/**
 * Odin 2026-10-16 (normalize Bazaar fix): every route's declared Bazaar example
 * (extensions.bazaar.info) must validate against its own declared schema
 * (extensions.bazaar.schema). /api/grocery/normalize GET declared servings /
 * targetServings as integer while the example (query strings) sent "4"/"8";
 * x402 logged "invalid bazaar extension" and CDP never indexed the route.
 */
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import * as S from "@/lib/x402-server";

type Ext = { bazaar?: { info?: unknown; schema?: Record<string, unknown> } };
const builders = Object.entries(S).filter(
  ([name, fn]) => typeof fn === "function" && /RouteConfig$/.test(name) && (fn as () => unknown).length === 0,
) as Array<[string, () => Record<string, { extensions?: Ext }>]>;

describe("Bazaar example matches the declared schema on every route key", () => {
  it("finds the route builders", () => expect(builders.length).toBeGreaterThanOrEqual(23));
  for (const [name, build] of builders) {
    it(`${name}: every bazaar info validates against its schema`, () => {
      const routes = build();
      for (const [key, cfg] of Object.entries(routes)) {
        const bz = cfg?.extensions?.bazaar;
        if (!bz?.schema) continue;
        const ajv = new Ajv2020({ strict: false, allErrors: true });
        const ok = ajv.validate(bz.schema, bz.info);
        expect({ key, errors: ok ? null : ajv.errorsText(ajv.errors) }).toEqual({ key, errors: null });
      }
    });
  }
  it("normalize GET: servings/targetServings are digit strings, POST keeps integers", () => {
    const r = S.groceryNormalizeRouteConfig() as Record<string, { extensions: Ext }>;
    const q = (r["GET /api/grocery/normalize"].extensions.bazaar!.schema as any).properties.input.properties.queryParams.properties;
    expect(q.servings).toMatchObject({ type: "string", pattern: "^[0-9]{1,3}$" });
    expect(q.targetServings).toMatchObject({ type: "string", pattern: "^[0-9]{1,3}$" });
    const b = (r["POST /api/grocery/normalize"].extensions.bazaar!.schema as any).properties.input.properties.body.properties;
    expect(b.servings.type).toBe("integer");
  });
});
