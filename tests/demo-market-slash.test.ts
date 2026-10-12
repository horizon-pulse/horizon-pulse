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

