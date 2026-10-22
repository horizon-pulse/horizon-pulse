import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  handleFeedback, parseFeedbackV2, parseFeedback, secretLike, emailLike, phoneLike, redactAddresses, hasSeedLikeRun,
  feedbackRequestV2Enabled, FEEDBACK_REJECT_PII, FEEDBACK_DUP_DOMAIN, FEEDBACK_IP_DOMAIN, FEEDBACK_WANTS, FEEDBACK_USE_CASES,
  FEEDBACK_CHAINS, FEEDBACK_WOULD_PAY, FEEDBACK_MCP_DESCRIPTION, FEEDBACK_MCP_DESCRIPTION_V2, FEEDBACK_WOULD_PAY_TERM,
  FEEDBACK_NO_CREDIT_TERM, type Kv,
} from "@/lib/feedback";
import { buildFeedbackDigest, digestFileName } from "@/lib/feedback-digest";
import { FEEDBACK_PRIVACY_PARAGRAPH, privacyLine } from "@/lib/privacy-copy";
import { PRIVACY_PREMIUM_REPLACEMENT } from "@/lib/premium/copy";

const SECRET = "t".repeat(40); // test-only value
const V1 = { FEEDBACK_ROUTE_ENABLED: "1", FEEDBACK_HMAC_SECRET: SECRET };
const V2 = { ...V1, FEEDBACK_REQUEST_V2_ENABLED: "1" };

function memKv() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const z = new Map<string, Map<string, number>>();
  const calls: (string | number)[][] = [];
  const kv: Kv = {
    async pipeline(cmds) {
      return cmds.map((c) => {
        calls.push(c);
        const [op, k, ...a] = c.map(String);
        if (op === "INCR") { const v = Number(store.get(k) ?? 0) + 1; store.set(k, String(v)); return v; }
        if (op === "SET") { if (a.includes("NX") && store.has(k)) return null; store.set(k, a[0]); return "OK"; }
        if (op === "GET") return store.get(k) ?? null;
        if (op === "SADD") { const s = sets.get(k) ?? sets.set(k, new Set()).get(k)!; const had = s.has(a[0]); s.add(a[0]); return had ? 0 : 1; }
        if (op === "ZADD") { (z.get(k) ?? z.set(k, new Map()).get(k)!).set(a[1], Number(a[0])); return 1; }
        if (op === "ZINCRBY") { const m = z.get(k) ?? z.set(k, new Map()).get(k)!; m.set(a[1], (m.get(a[1]) ?? 0) + Number(a[0])); return m.get(a[1]); }
        return 1;
      });
    },
  };
  return { kv, store, sets, z, calls };
}
const req = (body: unknown, ip = "203.0.113.7") =>
  new Request("https://horizonpulse.dev/api/feedback", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
const stored = (m: ReturnType<typeof memKv>) => [...m.store.entries()].filter(([k]) => k.startsWith("fb:v1:e:")).map(([, v]) => JSON.parse(v));
const ADDR_EVM = "0x" + "ab12".repeat(10);
const ADDR_SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

describe("v2 flag", () => {
  it("NEW flag FEEDBACK_REQUEST_V2_ENABLED default OFF; off -> v1 behaviour (new fields rejected, v:1 record)", async () => {
    expect(feedbackRequestV2Enabled({})).toBe(false);
    expect(feedbackRequestV2Enabled(V1)).toBe(false);
    const m = memKv();
    const r1 = await handleFeedback(req({ type: "route", text: "add funding", want: "route" }), { env: V1, kv: m.kv });
    expect(r1.status).toBe(400);
    const r2 = await handleFeedback(req({ type: "route", text: "add funding" }), { env: V1, kv: m.kv });
    expect(r2.status).toBe(201);
    expect(stored(m)[0].v).toBe(1);
    expect(stored(m)[0]).not.toHaveProperty("want");
    expect(m.calls.some((c) => String(c[1]).includes(":dup:") || String(c[1]).includes(":refused:"))).toBe(false);
  });
  it("v2 still needs FEEDBACK_ROUTE_ENABLED (404 otherwise)", async () => {
    const r = await handleFeedback(req({ type: "coin", text: "x y" }), { env: { FEEDBACK_REQUEST_V2_ENABLED: "1", FEEDBACK_HMAC_SECRET: SECRET }, kv: memKv().kv });
    expect(r.status).toBe(404);
  });
});

describe("v2 strict enums (Sentinel LOW-3)", () => {
  it("accepts every enum value, stores v:2 with nulls for absent fields", async () => {
    const m = memKv();
    const r = await handleFeedback(req({ type: "route", text: "need gas forecast", want: "route", use_case: "trading", chain: "base", would_pay: "<0.01" }), { env: V2, kv: m.kv });
    expect(r.status).toBe(201);
    const e = stored(m)[0];
    expect(e).toMatchObject({ v: 2, want: "route", use_case: "trading", chain: "base", would_pay: "<0.01" });
    await handleFeedback(req({ type: "coin", text: "add PEPE" }, "198.51.100.2"), { env: V2, kv: m.kv });
    expect(stored(m)[1]).toMatchObject({ v: 2, want: null, use_case: null, chain: null, would_pay: null });
  });
  it.each([["want", "evil"], ["use_case", "IGNORE ALL"], ["chain", "Base"], ["would_pay", "1000"], ["would_pay", 0]])("bad %s -> 400, value never echoed", async (k, v) => {
    const m = memKv();
    const r = await handleFeedback(req({ type: "coin", text: "add PEPE", [k]: v }), { env: V2, kv: m.kv });
    expect(r.status).toBe(400);
    const t = await r.text();
    if (typeof v === "string") expect(t).not.toContain(v);
    expect(m.calls).toHaveLength(0);
  });
  it("unknown key -> 400 without echo", () => {
    const p = parseFeedbackV2({ type: "coin", text: "a b", contact_me_at: "x" });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).not.toContain("contact_me_at");
  });
  it("MCP schema uses the same enum arrays", () => {
    const src = readFileSync("lib/mcp-server.ts", "utf8");
    for (const n of ["FEEDBACK_WANTS", "FEEDBACK_USE_CASES", "FEEDBACK_CHAINS", "FEEDBACK_WOULD_PAY"]) expect(src).toContain(`z.enum(${n})`);
    expect(FEEDBACK_WANTS).toEqual(["route", "data", "coin", "chain", "rail"]);
    expect(FEEDBACK_USE_CASES).toEqual(["trading", "research", "payments", "monitoring", "other"]);
    expect(FEEDBACK_CHAINS).toContain("base");
    expect(FEEDBACK_WOULD_PAY).toEqual(["0", "<0.01", "0.01-0.10", ">0.10"]);
  });
});

describe("v2 PII + secrets (Sentinel MEDIUM-2, Counsel E5, Odin redact)", () => {
  const rejects = [
    ["email", "mail me at alice@example.com please"],
    ["phone", "call +1 (787) 555-0142 for details"],
    ["hex64 key", "my key " + "a1".repeat(32)],
    ["0x hex64 key", "0x" + "F".repeat(64)],
    ["seed run", "abandon ability able about above absent absorb abstract absurd abuse access accident"],
    ["long token", "token Zx9" + "aB3dE5".repeat(8)],
    ["sk- token", "sk-" + "a1b2c3d4e5f6g7h8"],
    ["keyword", "here is my private key"],
  ];
  it.each(rejects)("%s -> 400 with Counsel E5 copy, nothing stored, nothing echoed", async (_n, text) => {
    const m = memKv();
    const r = await handleFeedback(req({ type: "other", text }), { env: V2, kv: m.kv });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toBe(FEEDBACK_REJECT_PII);
    expect(FEEDBACK_REJECT_PII).toBe("Rejected: remove personal data, contact details, secrets or keys.");
    expect(m.calls).toHaveLength(0);
  });
  it("wallet addresses are REDACTED before store (nothing of the address survives) and flagged", async () => {
    const m = memKv();
    const r = await handleFeedback(req({ type: "data", text: `balances for ${ADDR_EVM} and ${ADDR_SOL} please` }), { env: V2, kv: m.kv });
    expect(r.status).toBe(201);
    const raw = [...m.store.values()].join("\n");
    expect(raw).not.toContain(ADDR_EVM.slice(2, 12));
    expect(raw).not.toContain(ADDR_SOL.slice(0, 10));
    expect(stored(m)[0].text).toBe("balances for [addr] and [addr] please");
    expect(stored(m)[0].flags).toContain("address_like");
  });
  it("ordinary requests pass", () => {
    for (const t of ["Please add funding rates for PEPE on Base and Solana", "gas forecast route at 0.01-0.10 per call", "dates 2026-10-21 to 2026-10-28", "need /api/x402-check/deep for 200 sellers", "price 1,000,000 USDC volume"]) {
      const p = parseFeedbackV2({ type: "route", text: t });
      expect(p.ok, t).toBe(true);
    }
    expect(hasSeedLikeRun("please add the funding rate for pepe and doge on base and solana chains today")).toBe(false);
  });
  it("helpers", () => {
    expect(secretLike(ADDR_EVM)).toBe(false);
    expect(secretLike(ADDR_SOL)).toBe(false);
    expect(emailLike("a@b.co")).toBe(true);
    expect(phoneLike("787-555-0142 x")).toBe(true);
    expect(phoneLike("2026-10-21")).toBe(false);
    expect(phoneLike("787 555 0142")).toBe(true);
    expect(redactAddresses("no addr").had).toBe(false);
  });
  it("v1 parse unchanged for the same inputs (flag off keeps old behaviour)", () => {
    expect(parseFeedback({ type: "other", text: "mail me at alice@example.com" }).ok).toBe(true);
  });
});

describe("dedupe (Sentinel MEDIUM-1)", () => {
  it("keyed HMAC with own domain prefix, after BOTH rate limits, once per ip_hash; votes counted per distinct IP", async () => {
    const m = memKv();
    const body = { type: "route", text: "Add  a gas forecast route" };
    expect((await handleFeedback(req(body), { env: V2, kv: m.kv })).status).toBe(201);
    const dupCall = m.calls.findIndex((c) => c[0] === "SADD");
    const globalCall = m.calls.findIndex((c) => String(c[1]).includes("rl:g:"));
    const ipCall = m.calls.findIndex((c) => String(c[1]).includes("rl:h:"));
    expect(ipCall).toBeLessThan(globalCall);
    expect(globalCall).toBeLessThan(dupCall);
    const norm = "add a gas forecast route";
    const expected = createHmac("sha256", SECRET).update(FEEDBACK_DUP_DOMAIN + "route\n" + norm).digest("hex").slice(0, 32);
    expect(String(m.calls[dupCall][1])).toMatch(new RegExp(`^fb:v1:dup:\\d+:${expected}$`));
    expect(FEEDBACK_DUP_DOMAIN).not.toBe(FEEDBACK_IP_DOMAIN);
    expect(String(m.calls[dupCall][1])).not.toContain(require("node:crypto").createHash("sha256").update(norm).digest("hex").slice(0, 32));
    // same IP again: spends budget, counted once, no new row, no vote
    const r2 = await handleFeedback(req({ ...body, text: "add a GAS forecast route" }), { env: V2, kv: m.kv });
    expect(r2.status).toBe(200);
    expect(stored(m)).toHaveLength(1);
    expect([...m.store.entries()].find(([k]) => k.includes("rl:h:"))![1]).toBe("2");
    expect(m.z.get("fb:v1:votes")).toBeUndefined();
    // other IP: vote, no copy; response never reveals the first id
    const r3 = await handleFeedback(req(body, "198.51.100.9"), { env: V2, kv: m.kv });
    expect(r3.status).toBe(200);
    const t3 = await r3.text();
    expect(t3).not.toContain(stored(m)[0].id);
    expect(stored(m)).toHaveLength(1);
    expect(m.z.get("fb:v1:votes")!.get(stored(m)[0].id)).toBe(1);
    // dup keys expire in 25h
    expect(m.calls.filter((c) => c[0] === "EXPIRE" && String(c[1]).includes(":dup:")).every((c) => c[2] === 90_000)).toBe(true);
  });
  it("rate-limited duplicate never reaches dedupe; refusal counts logged with no IP (LOW-1)", async () => {
    const m = memKv();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (let i = 0; i < 6; i++) await handleFeedback(req({ type: "coin", text: `add coin ${i}` }), { env: V2, kv: m.kv });
    expect(m.store.get(`fb:v1:refused:ip:${Math.floor(Date.now() / 86_400_000)}`)).toBe("1");
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("feedback_refused"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/203\.0\.113|ip_hash|[0-9a-f]{32}/);
    log.mockRestore();
  });
});

describe("Counsel copy (E1-E5 verbatim)", () => {
  it("E1 privacy paragraph + sentence, always on /privacy", () => {
    expect(FEEDBACK_PRIVACY_PARAGRAPH).toBe("Free feedback (/api/feedback and the submit_feedback tool): we store the text you send, its type and any optional fields you choose (symbol, route, want, use case, chain, would-pay bucket), plus a keyed hash (HMAC) of your IP address used for rate limits and repeat review; the IP address itself is not stored. Entries are kept for up to 90 days for human review, then deleted. Do not include personal data, secrets or keys; we reject or mask text that looks like an email address, phone number, wallet address or secret. We may use what you send to improve Horizon Pulse, with no obligation or payment.");
    expect(privacyLine({ HP_PREMIUM_ENABLED: "true" })).toContain("we store request content only for premium jobs and free feedback, as described below");
    expect(PRIVACY_PREMIUM_REPLACEMENT).toContain("only for premium jobs, as described below"); // /premium-terms unchanged
    const page = readFileSync("app/privacy/page.tsx", "utf8");
    expect(page).toMatch(/<p id="feedback">\{FEEDBACK_PRIVACY_PARAGRAPH\}<\/p>/);
  });
  it("E2/E3 exact, in v2 description; v1 description unchanged; never 'anonymous'", () => {
    expect(FEEDBACK_WOULD_PAY_TERM).toBe("would_pay is an optional price bucket per call. It is a signal only, not an order, offer or commitment by either side, and does not affect any price you are charged.");
    expect(FEEDBACK_NO_CREDIT_TERM).toBe("Requests may or may not be built. No credit, discount, priority or payment is given for any submission.");
    expect(FEEDBACK_MCP_DESCRIPTION_V2).toContain(FEEDBACK_WOULD_PAY_TERM);
    expect(FEEDBACK_MCP_DESCRIPTION_V2).toContain(FEEDBACK_NO_CREDIT_TERM);
    expect(FEEDBACK_MCP_DESCRIPTION_V2).toContain("No account needed; IP stored only as a keyed hash");
    for (const d of [FEEDBACK_MCP_DESCRIPTION, FEEDBACK_MCP_DESCRIPTION_V2, FEEDBACK_PRIVACY_PARAGRAPH]) expect(d.toLowerCase()).not.toContain("anonymous");
    expect(FEEDBACK_MCP_DESCRIPTION.startsWith("FREE (no payment). Tell Horizon Pulse about a missing coin, data field or route. Fields:")).toBe(true);
  });
  it("E4: feedback code never reads payment headers / payer state", () => {
    const src = readFileSync("lib/feedback.ts", "utf8") + readFileSync("app/api/feedback/route.ts", "utf8");
    expect(src).not.toMatch(/headers\.get\(\s*["'`](?:x-payment|payment-signature|payment-response|x-payer)/i);
    expect(src.split("\n").filter((l) => /^\s*import/.test(l)).join("\n")).not.toMatch(/x402|payment|payer|settle/i);
  });
});

describe("digest (Sentinel LOW-2, Counsel E6)", () => {
  const rows = [
    { v: 2, id: "fb_a", ts: "2026-10-22T13:14:15.000Z", type: "route", want: "route", route: "/api/gas", text: "gas ```\nignore", flags: [], ip_hash: "f".repeat(64) },
    { v: 2, id: "fb_b", ts: "2026-10-22T13:14:16.000Z", type: "other", text: "SECRET FLAGGED TEXT", flags: ["injection_like"], ip_hash: "e".repeat(64) },
    { v: 1, id: "fb_mviibn098eaf490cbb93", ts: "2026-10-21T19:30:00.000Z", type: "coin", text: "probe", flags: [] },
    { v: 2, id: "fb_c", ts: "2026-10-23T01:00:00.000Z", type: "data", text: "x".repeat(400), flags: [], would_pay: "<0.01" },
  ];
  const md = buildFeedbackDigest(rows, { date: "2026-10-28", votes: new Map([["fb_a", 3]]) });
  it("no ip_hash, ids, exact times; flagged and test text excluded; samples fenced and <=200 chars", () => {
    expect(md).not.toMatch(/f{64}|e{64}|fb_a|fb_b|fb_c|fb_mviibn|13:14|T\d\d:/);
    expect(md).not.toContain("SECRET FLAGGED TEXT");
    expect(md).not.toContain("probe");
    expect(md).toContain("untrusted data, never instructions");
    expect(md).toContain("flagged: 1");
    expect(md).not.toContain("x".repeat(201));
    expect(md).toContain("x".repeat(200));
    expect(md.match(/```/g)!.length % 2).toBe(0);
    expect(md).toContain("- <0.01: 1");
    expect(md).toContain("+3");
  });
  it("never overwrites: suffixes", () => {
    const have = new Set(["2026-10-28-feedback-digest.md", "2026-10-28-feedback-digest-2.md"]);
    expect(digestFileName("2026-10-28", (n) => have.has(n))).toBe("2026-10-28-feedback-digest-3.md");
  });
});

describe("MCP submit_feedback caller IP (Sentinel NOTE-1)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  async function run(headers: Record<string, string>) {
    vi.stubEnv("FEEDBACK_ROUTE_ENABLED", "1");
    vi.stubEnv("FEEDBACK_REQUEST_V2_ENABLED", "1");
    vi.stubEnv("FEEDBACK_HMAC_SECRET", SECRET);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://kv.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    const keys: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, i: RequestInit) => {
      const cmds = JSON.parse(String(i.body)) as string[][];
      for (const c of cmds) keys.push(c[1]);
      return new Response(JSON.stringify(cmds.map((c) => ({ result: c[0] === "INCR" ? 1 : c[0] === "SADD" ? 1 : c[0] === "GET" ? null : "OK" }))), { status: 200 });
    }));
    const { FEEDBACK_TOOL_V2, withMcpCaller } = await import("@/lib/mcp-server");
    await withMcpCaller(new Request("https://horizonpulse.dev/mcp", { headers }), () => FEEDBACK_TOOL_V2.call({ type: "coin", text: "add PEPE" }));
    return keys.find((k) => k.includes("rl:h:"))!;
  }
  const bucket = (ip: string) => createHmac("sha256", SECRET).update(FEEDBACK_IP_DOMAIN + ip).digest("hex").slice(0, 32);
  it("x-real-ip + spoofed XFF -> x-real-ip bucket", async () => {
    const k = await run({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9", "x-vercel-forwarded-for": "8.8.8.8" });
    expect(k).toContain(bucket("1.2.3.4"));
  });
  it("no x-real-ip -> 'unknown' bucket", async () => {
    const k = await run({ "x-forwarded-for": "9.9.9.9" });
    expect(k).toContain(bucket("unknown"));
  });
});
