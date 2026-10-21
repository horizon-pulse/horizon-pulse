/**
 * Default (no ?symbol=) parity for /api/pulse, /api/signals, /api/funding.
 *
 * tests/fixtures/symbol-default-parity.golden.json was captured ONCE by running
 * this file with CAPTURE_PARITY=1 against main ca4ab07 handlers (before the
 * symbol param existed). It must never be refreshed on the symbol-param branch:
 * a request without ?symbol= has to produce byte-identical status + body.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeVendorMock, type VendorMode } from "./helpers/market-vendor-mock";

const GOLDEN = path.join(__dirname, "fixtures", "symbol-default-parity.golden.json");
let mock = makeVendorMock();
vi.mock("@/lib/no-brotli", async (orig) => ({
  ...(await orig<typeof import("@/lib/no-brotli")>()),
  vendorFetch: (i: string | URL | Request) => mock.fn(i),
}));

const CASES: Array<{ name: string; route: "pulse" | "signals" | "funding"; mode: VendorMode; query?: string }> = [
  { name: "pulse coinbase", route: "pulse", mode: {} },
  { name: "pulse coingecko fallback", route: "pulse", mode: { coinbaseDown: true } },
  { name: "pulse all down", route: "pulse", mode: { coinbaseDown: true, coingeckoDown: true } },
  { name: "signals coingecko", route: "signals", mode: {} },
  { name: "signals coinbase fallback", route: "signals", mode: { coingeckoDown: true } },
  { name: "funding", route: "funding", mode: {} },
];

async function run(route: string, query = ""): Promise<{ status: number; body: string; calls: string[] }> {
  const req = new NextRequest(`https://horizonpulse.dev/api/${route}${query}`);
  const mod = await import(`@/app/api/${route}/handler`);
  const h = mod[`${route}Handler`] as (r: NextRequest) => Promise<Response>;
  const res = await h(req);
  return { status: res.status, body: await res.text(), calls: [...mock.calls] };
}

describe("no ?symbol= is byte-identical to main ca4ab07", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("matches the pre-change golden for every vendor path", async () => {
    const got: Record<string, unknown> = {};
    for (const c of CASES) {
      mock = makeVendorMock(c.mode);
      got[c.name] = await run(c.route, c.query);
    }
    if (process.env.CAPTURE_PARITY === "1" && !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + "\n");
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(got).toEqual(golden);
  });
});
