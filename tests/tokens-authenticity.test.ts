/** Tokenized-stock real-token check (branch tokens-authenticity, flag off). Mocked Coinbase API, no network. */
import { describe, expect, it, vi } from "vitest";
import {
  NOT_ADVICE, NOT_AFFILIATED, US_PERSONS_NOTICE, checkTokenAddress, tokensAuthenticityEnabled, type Deps,
} from "@/lib/tokens-authenticity/check";

const NOW = Date.UTC(2026, 9, 20, 21, 40);
const TSLA = "0xb2000000000000000000001e800a7f5189430cD0";
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const FAKE_ELSA = "0x65813c76b11acc4b6246cab03764ed2b11df6785";
const REAL_ELSA = "0x29cC30f9D113B356Ce408667aa6433589CeCBDcA";
const page1 = { tokens: [{ contract_address: AAPL, symbol: "AAPLc", isin: "US0378331005", description: "desc", icon_url: "https://x/i.png" }], next_page_token: "p2" };
const page2 = { tokens: [{ contract_address: TSLA, symbol: "TSLAc", isin: "US88160R1014" }], next_page_token: "" };

function deps(mode: "ok" | "down" | "empty" = "ok", urls: string[] = []): Deps {
  return {
    now: () => NOW,
    fetch: vi.fn(async (u: string | URL | Request) => {
      const url = String(u); urls.push(url);
      if (mode === "down") return new Response("x", { status: 503 });
      if (mode === "empty") return new Response(JSON.stringify({ tokens: [] }), { status: 200 });
      return new Response(JSON.stringify(url.includes("page_token=p2") ? page2 : page1), { status: 200 });
    }) as unknown as typeof fetch,
  };
}

describe("tokens-authenticity", () => {
  it("flag is off unless exactly 'true'", () => {
    expect(tokensAuthenticityEnabled({})).toBe(false);
    expect(tokensAuthenticityEnabled({ HP_TOKENS_AUTHENTICITY_ENABLED: "1" })).toBe(false);
    expect(tokensAuthenticityEnabled({ HP_TOKENS_AUTHENTICITY_ENABLED: "TRUE" })).toBe(false);
    expect(tokensAuthenticityEnabled({ HP_TOKENS_AUTHENTICITY_ENABLED: "true" })).toBe(true);
  });
  it("fake ELSA is NOT a match", async () => {
    const r = await checkTokenAddress(FAKE_ELSA, deps());
    expect(r).toMatchObject({ ok: true, match: false, matched_list: null });
  });
  it("real ELSA IS a match (reference token)", async () => {
    const r = await checkTokenAddress(REAL_ELSA, deps());
    expect(r).toMatchObject({ ok: true, match: true, matched_list: "reference_token", symbol: "ELSA" });
    expect(await checkTokenAddress(REAL_ELSA.toLowerCase(), deps())).toMatchObject({ match: true });
  });
  it("Coinbase token on page 2 matches case-insensitively, with ISIN and dated statement", async () => {
    const urls: string[] = [];
    const r = await checkTokenAddress(TSLA.toLowerCase(), deps("ok", urls));
    expect(urls).toHaveLength(2);
    expect(r).toMatchObject({ ok: true, match: true, matched_list: "coinbase_tokenized_stocks_api", symbol: "TSLAc", isin: "US88160R1014" });
    if (r.ok) expect(r.statement).toBe("Listed in Coinbase's public tokenized-stocks API as of 2026-10-20T21:40:00.000Z.");
  });
  it("synthetic TSLAc lookalike address is not a match", async () => {
    const r = await checkTokenAddress("0xb2000000000000000000001e800a7f5189430cd1", deps());
    expect(r).toMatchObject({ ok: true, match: false });
  });
  it("never re-exports the list, descriptions or icons; never says certified; carries Counsel lines verbatim", async () => {
    for (const a of [AAPL, FAKE_ELSA, REAL_ELSA]) {
      const r = await checkTokenAddress(a, deps());
      const s = JSON.stringify(r);
      expect(s.toLowerCase()).not.toContain("certif");
      expect(s.toLowerCase()).not.toContain("verified by coinbase");
      expect(s).not.toContain("icon_url"); expect(s).not.toContain("desc");
      if (a !== AAPL) expect(s).not.toContain(AAPL);
      expect(s).not.toContain(TSLA);
      expect(r).toMatchObject({ notice: US_PERSONS_NOTICE, not_affiliated: NOT_AFFILIATED, not_advice: NOT_ADVICE });
    }
    expect(US_PERSONS_NOTICE).toBe("Data only. These tokens are issued under Regulation S and are not available to U.S. persons or in other restricted jurisdictions; check your own eligibility. This route does not offer, sell, recommend or facilitate buying, selling or holding them. Horizon Pulse is not affiliated with Coinbase, Base or Chainlink.");
    expect(NOT_AFFILIATED).toBe("Horizon Pulse is not affiliated with Coinbase, Base or Chainlink.");
  });
  it("C1: bad EIP-55 checksum on mixed case is 400; lowercase in -> checksummed out", async () => {
    const bad = "0x29cC30f9D113B356Ce408667aa6433589CeCBDca"; // last char case flipped
    expect(await checkTokenAddress(bad, deps())).toMatchObject({ ok: false, status: 400, charged: false });
    const r = await checkTokenAddress(REAL_ELSA.toLowerCase(), deps());
    expect(r).toMatchObject({ ok: true, address: REAL_ELSA });
    const t = await checkTokenAddress(TSLA.toLowerCase(), deps());
    expect(t).toMatchObject({ ok: true, address: TSLA });
    const f = await checkTokenAddress(FAKE_ELSA, deps());
    expect(f.ok && f.address.toLowerCase()).toBe(FAKE_ELSA);
    expect(f.ok && f.address).not.toBe(FAKE_ELSA);
  });
  it("C2: whole fetch time budget -> 502; oversize body -> 502", async () => {
    const hang: Deps = { now: () => NOW, fetch: vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch };
    const t0 = Date.now();
    expect(await checkTokenAddress(TSLA, hang, { budgetMs: 50 })).toMatchObject({ ok: false, status: 502, charged: false });
    expect(Date.now() - t0).toBeLessThan(2000);
    // fetch that ignores the signal entirely still gets cut by the budget
    const deaf: Deps = { now: () => NOW, fetch: vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch };
    expect(await checkTokenAddress(TSLA, deaf, { budgetMs: 50 })).toMatchObject({ ok: false, status: 502 });
    // slow pages: each page fine alone, total exceeds budget
    let n = 0;
    const slow: Deps = { now: () => NOW, fetch: vi.fn(async () => { await new Promise((r) => setTimeout(r, 40)); return new Response(JSON.stringify({ tokens: [{ contract_address: AAPL, symbol: "AAPLc" }], next_page_token: `p${++n}` })); }) as unknown as typeof fetch };
    expect(await checkTokenAddress(TSLA, slow, { budgetMs: 100 })).toMatchObject({ ok: false, status: 502 });
    expect(n).toBeLessThan(5);
    const big = JSON.stringify({ tokens: [{ contract_address: TSLA, symbol: "TSLAc", pad: "x".repeat(5000) }] });
    const bigDeps: Deps = { now: () => NOW, fetch: vi.fn(async () => new Response(big)) as unknown as typeof fetch };
    expect(await checkTokenAddress(TSLA, bigDeps, { maxBytes: 1000 })).toMatchObject({ ok: false, status: 502 });
    expect(await checkTokenAddress(TSLA, bigDeps, { maxBytes: 100_000 })).toMatchObject({ ok: true, match: true });
    const lied: Deps = { now: () => NOW, fetch: vi.fn(async () => new Response(big, { headers: { "content-length": "999999999" } })) as unknown as typeof fetch };
    expect(await checkTokenAddress(TSLA, lied)).toMatchObject({ ok: false, status: 502 });
  });
  it("C3: not-advice line exact text (Counsel c)", () => {
    expect(NOT_ADVICE).toBe("Not financial, investment, tax, legal or health advice. Quotes about tokens, securities or other financial products are not a recommendation to buy, sell or hold anything. Price differences are observed technical values that may be stale (reference feeds freeze outside market hours and during corporate actions) and are not a trading signal.");
  });
  it("C4: real ELSA keeps the 'cited public sources' wording", async () => {
    const r = await checkTokenAddress(REAL_ELSA, deps());
    expect(r.ok && r.statement).toContain("in the cited public sources as of");
  });
  it("bad input 400, list down or empty 502 (never a false 'no match')", async () => {
    expect(await checkTokenAddress("ELSA", deps())).toMatchObject({ ok: false, status: 400, charged: false });
    expect(await checkTokenAddress(undefined, deps())).toMatchObject({ ok: false, status: 400 });
    expect(await checkTokenAddress(FAKE_ELSA, deps("down"))).toMatchObject({ ok: false, status: 502, charged: false });
    expect(await checkTokenAddress(FAKE_ELSA, deps("empty"))).toMatchObject({ ok: false, status: 502 });
  });
});
