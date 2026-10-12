import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET as slash } from "../app/api/demo/market/[op]/route";
import { GET as dash } from "../app/api/demo/[route]/route";

const req = (p: string) => new NextRequest(`https://horizonpulse.dev${p}`);

describe("/api/demo/market/<op> slash alias", () => {
  for (const op of ["search", "quote"]) {
    it(`market/${op} == market-${op}`, async () => {
      const a = await slash(req(`/api/demo/market/${op}`), { params: Promise.resolve({ op }) });
      const b = await dash(req(`/api/demo/market-${op}`), { params: Promise.resolve({ route: `market-${op}` }) });
      expect(a.status).toBe(200);
      expect(a.status).toBe(b.status);
      expect(await a.text()).toBe(await b.text());
    });
  }
  it("unknown op 404s", async () => {
    const r = await slash(req("/api/demo/market/nope"), { params: Promise.resolve({ op: "nope" }) });
    expect(r.status).toBe(404);
  });
});

import { parseSearchInput } from "../lib/market/engine";
describe("market/search rail aliases", () => {
  it("polygon / eip155:137 -> exact network eip155:137 (no rail); evm -> x402:evm; xrpl -> x402:xrpl; xrpl:0 exact", () => {
    for (const [r, rail, network] of [["polygon", null, "eip155:137"], ["Polygon", null, "eip155:137"], ["eip155:137", null, "eip155:137"], ["evm", "x402:evm", null], ["xrpl", "x402:xrpl", null], ["xrpl:0", null, "xrpl:0"]]) {
      const p = parseSearchInput({ q: "x", rail: r } as never) as { rail?: string | null; network?: string | null };
      expect(p.rail, r!).toBe(rail);
      expect(p.network, r!).toBe(network);
    }
  });
});
