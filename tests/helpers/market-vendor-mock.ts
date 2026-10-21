/**
 * Deterministic vendor mock for /api/pulse, /api/signals, /api/funding handler tests.
 * Every vendor URL is answered from a seeded table; unknown URLs throw so a test
 * can never silently hit the network. `calls` records every URL requested.
 */
export type VendorMode = { coinbaseDown?: boolean; coingeckoDown?: boolean };

function seed(s: string): number {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 100003;
  return h;
}

export function makeVendorMock(mode: VendorMode = {}) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fn = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    let m = url.match(/exchange\.coinbase\.com\/products\/([A-Z0-9]+)-USD\/stats$/);
    if (m) {
      if (mode.coinbaseDown) return json({ message: "down" }, 503);
      const k = seed(m[1]!);
      return json({ open: String(100 + (k % 50)), last: String(101 + (k % 57)) });
    }
    m = url.match(/exchange\.coinbase\.com\/products\/([A-Z0-9]+)-USD\/candles/);
    if (m) {
      if (mode.coinbaseDown) return json({ message: "down" }, 503);
      const k = seed(m[1]!);
      return json(Array.from({ length: 100 }, (_, i) => [i, 1, 2, 1, 50 + ((k + i * 7) % 23)]));
    }
    m = url.match(/api\.coingecko\.com\/api\/v3\/simple\/price\?ids=([^&]+)/);
    if (m) {
      if (mode.coingeckoDown) return json({ error: "rate" }, 429);
      const out: Record<string, unknown> = {};
      for (const id of decodeURIComponent(m[1]!).split(",")) {
        const k = seed(id);
        out[id] = { usd: 10 + (k % 900), usd_24h_change: ((k % 11) - 5) / 2 };
      }
      return json(out);
    }
    m = url.match(/api\.coingecko\.com\/api\/v3\/coins\/([a-z0-9-]+)\/ohlc/);
    if (m) {
      if (mode.coingeckoDown) return json({ error: "rate" }, 429);
      const k = seed(m[1]!);
      return json(Array.from({ length: 23 }, (_, i) => [i, 1, 2, 1, 40 + ((k + i * 13) % 29)]));
    }
    m = url.match(/okx\.com\/api\/v5\/public\/funding-rate\?instId=([A-Z0-9-]+)$/);
    if (m) {
      const k = seed(m[1]!);
      return json({
        code: "0",
        data: [{ instId: m[1], fundingRate: String(((k % 9) - 4) / 10000), nextFundingRate: "", fundingTime: "1792627200000" }],
      });
    }
    throw new Error(`unmocked vendor URL ${url}`);
  };
  return { fn, calls };
}
