/** Counsel condition (a11b42f): every published "Supported:" list equals lib/market-symbols.ts exactly. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MARKET_SYMBOL_LIST, SYMBOL_PARAM_DESCRIPTION } from "@/lib/market-symbols";
import { pulseRouteConfig, signalsRouteConfig, fundingRouteConfig } from "@/lib/x402-server";

const list = (text: string): string[] => {
  const m = text.match(/Supported: ([A-Z0-9, ]+?)(?: \(|\.)/);
  if (!m) throw new Error(`no Supported: list in ${text.slice(0, 80)}`);
  return m[1]!.split(", ");
};
const ROUTES = ["/api/pulse", "/api/signals", "/api/funding"] as const;

describe("published symbol lists match lib/market-symbols.ts", () => {
  it("param description", () => expect(list(SYMBOL_PARAM_DESCRIPTION)).toEqual(MARKET_SYMBOL_LIST));

  it("llms.txt", () => {
    const lines = readFileSync("public/llms.txt", "utf8").split("\n").filter((l) => l.includes("Supported:") && l.includes("symbol="));
    expect(lines.length).toBe(1);
    expect(list(lines[0]!)).toEqual(MARKET_SYMBOL_LIST);
  });

  it("openapi.json parameter enum + description", () => {
    const api = JSON.parse(readFileSync("public/openapi.json", "utf8"));
    for (const r of ROUTES) {
      const p = api.paths[r].get.parameters.find((x: { name: string }) => x.name === "symbol");
      expect(p.schema.enum).toEqual(MARKET_SYMBOL_LIST);
      expect(list(p.description)).toEqual(MARKET_SYMBOL_LIST);
      expect(p.description).toBe(SYMBOL_PARAM_DESCRIPTION);
    }
  });

  it("402 bazaar queryParams enum + description", () => {
    const cfgs = { "/api/pulse": pulseRouteConfig(), "/api/signals": signalsRouteConfig(), "/api/funding": fundingRouteConfig() };
    for (const r of ROUTES) {
      const entry = Object.entries(cfgs[r]).find(([k]) => k.includes(r) && k.startsWith("GET"))?.[1] ?? Object.values(cfgs[r])[0];
      const qp = (entry as any).extensions.bazaar.schema.properties.input.properties.queryParams.properties.symbol;
      expect(qp.enum).toEqual(MARKET_SYMBOL_LIST);
      expect(qp.description).toBe(SYMBOL_PARAM_DESCRIPTION);
    }
  });
});
