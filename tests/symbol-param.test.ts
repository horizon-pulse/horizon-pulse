import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeVendorMock } from "./helpers/market-vendor-mock";
import { MARKET_SYMBOL_LIST, parseSymbolParam } from "@/lib/market-symbols";

let mock = makeVendorMock();
vi.mock("@/lib/no-brotli", async (orig) => ({
  ...(await orig<typeof import("@/lib/no-brotli")>()),
  vendorFetch: (i: string | URL | Request) => mock.fn(i),
}));

const ROUTES = ["pulse", "signals", "funding"] as const;
const url = (r: string, q: string) => `https://horizonpulse.dev/api/${r}${q}`;

async function handler(r: string) {
  const mod = await import(`@/app/api/${r}/handler`);
  return mod[`${r}Handler`] as (req: NextRequest) => Promise<Response>;
}

describe("parseSymbolParam", () => {
  it("absent -> default set", () => expect(parseSymbolParam(url("pulse", ""))).toEqual({ ok: true, symbols: null }));
  it("case-insensitive, trimmed", () => {
    expect(parseSymbolParam(url("pulse", "?symbol=link"))).toEqual({ ok: true, symbols: ["LINK"] });
    expect(parseSymbolParam(url("pulse", "?symbol=%20qnt%20"))).toEqual({ ok: true, symbols: ["QNT"] });
  });
  it("rejects unknown, empty, repeated, comma lists, prototype keys", () => {
    for (const q of ["?symbol=FOO", "?symbol=", "?symbol=BTC&symbol=ETH", "?symbol=BTC,ETH", "?symbol=__proto__", "?symbol=toString", "?symbol=USDC"]) {
      expect(parseSymbolParam(url("pulse", q)).ok).toBe(false);
    }
  });
  it("LINK and QNT are supported", () => {
    expect(MARKET_SYMBOL_LIST).toContain("LINK");
    expect(MARKET_SYMBOL_LIST).toContain("QNT");
  });
});

describe("supported ?symbol= returns only that asset", () => {
  beforeEach(() => (mock = makeVendorMock()));
  for (const r of ROUTES) {
    for (const s of ["LINK", "QNT", "btc"]) {
      it(`${r} ${s}`, async () => {
        const res = await (await handler(r))(new NextRequest(url(r, `?symbol=${s}`)));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Object.keys(body.assets)).toEqual([s.toUpperCase()]);
        if (r === "funding") {
          expect(body.assets[s.toUpperCase()].instId).toBe(`${s.toUpperCase()}-USDT-SWAP`);
          expect(body.methodology.source).toContain(`${s.toUpperCase()}-USDT-SWAP`);
        }
        if (r === "signals") expect(body.assets[s.toUpperCase()].funding.instId).toBe(`${s.toUpperCase()}-USDT-SWAP`);
        // only that symbol's vendor URLs were requested
        for (const c of mock.calls) expect(c).not.toMatch(/ETH-|SOL-|ethereum|solana/);
      });
    }
  }
  it("pulse QNT uses the quant-network id on CoinGecko fallback", async () => {
    mock = makeVendorMock({ coinbaseDown: true });
    const res = await (await handler("pulse"))(new NextRequest(url("pulse", "?symbol=QNT")));
    const body = await res.json();
    expect(body.source).toBe("coingecko");
    expect(body.assets.QNT.id).toBe("quant-network");
  });
});

describe("unsupported ?symbol= -> 400 before payment (no verify, no settle)", () => {
  afterEach(() => vi.restoreAllMocks());
  for (const r of ROUTES) {
    it(`${r}: unpaid and paid-header requests both 400, no vendor, no facilitator`, async () => {
      mock = makeVendorMock();
      const globalFetch = vi.spyOn(globalThis, "fetch");
      const { GET } = await import(`@/app/api/${r}/route`);
      for (const headers of [{}, { "payment-signature": "dGVzdA==" }, { "x-payment": "dGVzdA==" }] as Record<string, string>[]) {
        const res: Response = await GET(new NextRequest(url(r, "?symbol=NOTACOIN"), { headers }));
        expect(res.status).toBe(400);
        expect(res.headers.get("payment-required")).toBeNull();
        expect(res.headers.get("payment-response")).toBeNull();
        const body = await res.json();
        expect(body).toMatchObject({ ok: false, code: "unsupported_symbol", charged: false, route: `/api/${r}` });
        expect(body.supported).toEqual(MARKET_SYMBOL_LIST);
      }
      expect(mock.calls).toEqual([]);
      expect(globalFetch).not.toHaveBeenCalled();
    });
    it(`${r}: handler also refuses a bad symbol on its own`, async () => {
      mock = makeVendorMock();
      const res = await (await handler(r))(new NextRequest(url(r, "?symbol=FOO")));
      expect(res.status).toBe(400);
      expect(mock.calls).toEqual([]);
    });
  }
});

describe("supported ?symbol= unpaid still gets the normal 402", () => {
  for (const r of ROUTES) {
    it(`${r}?symbol=LINK -> 402`, async () => {
      const { GET } = await import(`@/app/api/${r}/route`);
      const res: Response = await GET(new NextRequest(url(r, "?symbol=LINK"), { headers: { accept: "application/json" } }));
      expect(res.status).toBe(402);
    });
  }
});
