/** Odin fix 4: replay store interface; memory adapter + Upstash REST adapter (fetch stubbed, offline). */
import { describe, expect, it } from "vitest";
import { CAS_SCRIPT, MemoryReplayStore, UpstashReplayStore, createReplayStore, encodeReplayValue, parseReplayValue } from "@/lib/xrpl-replay-store";

function fakeUpstash() {
  const kv = new Map<string, string>();
  const calls: string[][] = [];
  const f = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const a = JSON.parse(init.body) as string[];
    calls.push(a);
    if (init.headers.Authorization !== "Bearer tok") return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    let result: unknown = null;
    if (a[0] === "SET") {
      if (a.includes("NX") && kv.has(a[1])) result = null;
      else (kv.set(a[1], a[2]), (result = "OK"));
    } else if (a[0] === "GET") result = kv.get(a[1]) ?? null;
    else if (a[0] === "DEL") result = kv.delete(a[1]) ? 1 : 0;
    else if (a[0] === "EVAL") {
      // Server-side atomic CAS (what the Lua script does on Upstash).
      const [, , , key, expected, next] = a;
      if (kv.get(key) === expected) (kv.set(key, next), (result = 1));
      else result = 0;
    }
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { kv, calls, f };
}

describe("XRPL replay store", () => {
  for (const [name, make] of [
    ["memory", () => new MemoryReplayStore()],
    ["upstash", () => new UpstashReplayStore("https://x.upstash.io", "tok", fakeUpstash().f)],
  ] as const) {
    it(`${name}: claim is set-if-absent; second claim sees the held state; release frees it`, async () => {
      const s = make();
      expect(await s.claim("k", 60_000)).toBeNull();
      expect(await s.claim("k", 60_000)).toBe("in_flight");
      await s.set("k", "settled", 60_000);
      expect(await s.claim("k", 60_000)).toBe("settled");
      await s.release("k");
      expect(await s.claim("k", 60_000)).toBeNull();
    });
  }

  it("upstash: atomic NX + PX TTL, namespaced key, bearer token", async () => {
    const u = fakeUpstash();
    const s = new UpstashReplayStore("https://x.upstash.io/", "tok", u.f);
    await s.claim("abc", 90_000_000);
    expect(u.calls[0]).toEqual(["SET", "hp:xrpl:replay:abc", "in_flight", "NX", "PX", "90000000"]);
  });

  it("upstash: errors throw (caller fails closed on claim)", async () => {
    const s = new UpstashReplayStore("https://x.upstash.io", "wrong", fakeUpstash().f);
    await expect(s.claim("k", 1000)).rejects.toThrow();
    expect(() => new UpstashReplayStore("http://x.upstash.io", "tok")).toThrow();
  });

  it("memory: entries expire after TTL", async () => {
    const s = new MemoryReplayStore();
    expect(await s.claim("k", 1)).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    expect(await s.claim("k", 1)).toBeNull();
  });

  it("selection: Upstash only when both env vars are set and the URL is https", () => {
    expect(createReplayStore({}).kind).toBe("memory");
    expect(createReplayStore({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io" }).kind).toBe("memory");
    expect(createReplayStore({ UPSTASH_REDIS_REST_URL: "http://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }).kind).toBe("memory");
    expect(createReplayStore({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }).kind).toBe("upstash");
  });

  it("values: encode/parse round-trip; timestamps only; unknown → null; claim reports the state part", async () => {
    expect(encodeReplayValue({ state: "settled" })).toBe("settled");
    expect(encodeReplayValue({ state: "settle_unconfirmed", firstSeen: 1700000000123 })).toBe("settle_unconfirmed@1700000000123");
    expect(parseReplayValue("redeeming@1@2")).toEqual({ state: "redeeming", firstSeen: 1, lease: 2 });
    expect(parseReplayValue("settle_unconfirmed")).toEqual({ state: "settle_unconfirmed" });
    for (const bad of ["", "bogus", "settled@x", "settled@1@2@3", 5, null]) expect(parseReplayValue(bad)).toBeNull();
    for (const s of [new MemoryReplayStore(), new UpstashReplayStore("https://x.upstash.io", "tok", fakeUpstash().f)]) {
      await s.claim("k", 60_000);
      await s.set("k", "settle_unconfirmed@123", 60_000);
      expect(await s.claim("k", 60_000)).toBe("settle_unconfirmed");
    }
  });

  for (const [name, make] of [
    ["memory", () => ({ s: new MemoryReplayStore(), calls: [] as string[][] })],
    ["upstash", () => {
      const u = fakeUpstash();
      return { s: new UpstashReplayStore("https://x.upstash.io", "tok", u.f), calls: u.calls };
    }],
  ] as const) {
    it(`${name}: cas swaps only from the exact expected value; concurrent cas → exactly one winner`, async () => {
      const { s } = make();
      await s.set("k", "settle_unconfirmed@5", 60_000);
      expect(await s.cas!("k", "settle_unconfirmed@6", "x", 60_000)).toBe(false);
      const wins = await Promise.all([1, 2, 3, 4, 5].map((i) => s.cas!("k", "settle_unconfirmed@5", `redeeming@5@${i}`, 60_000)));
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(await s.get!("k")).toMatch(/^redeeming@5@[1-5]$/);
    });
  }

  it("upstash cas = one EVAL (GET == expected → SET PX), namespaced key, same TTL", async () => {
    const u = fakeUpstash();
    const s = new UpstashReplayStore("https://x.upstash.io", "tok", u.f);
    await s.cas("abc", "a", "b", 90_000_000);
    expect(u.calls.at(-1)).toEqual(["EVAL", CAS_SCRIPT, "1", "hp:xrpl:replay:abc", "a", "b", "90000000"]);
    expect(CAS_SCRIPT).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(CAS_SCRIPT).toContain("'PX', ARGV[3]");
  });
});

