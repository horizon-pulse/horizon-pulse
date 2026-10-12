/** Replay store env: UPSTASH_REDIS_REST_* first, else Vercel Marketplace KV_REST_API_URL/TOKEN; read-only token never used; fail closed. */
import { describe, expect, it } from "vitest";
import { createReplayStore, resolveSharedReplayStoreEnv } from "@/lib/xrpl-replay-store";
import { getXrplRailConfig, hasSharedReplayStoreEnv } from "@/lib/xrpl-config";

const KV = { KV_REST_API_URL: "https://kv.upstash.io", KV_REST_API_TOKEN: "rw-token", KV_REST_API_READ_ONLY_TOKEN: "ro-token" };
const UP = { UPSTASH_REDIS_REST_URL: "https://up.upstash.io", UPSTASH_REDIS_REST_TOKEN: "up-token" };

function capture(env: Record<string, string>) {
  const seen: { url: string; auth: string; body: string[] }[] = [];
  const f = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    seen.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { store: createReplayStore(env, f), seen };
}

describe("KV_REST_API_* fallback", () => {
  it("KV pair alone → Upstash store using the READ-WRITE token and KV URL", async () => {
    expect(resolveSharedReplayStoreEnv(KV)).toEqual({ url: "https://kv.upstash.io", token: "rw-token", source: "vercel_kv" });
    const { store, seen } = capture(KV);
    expect(store.kind).toBe("upstash");
    await store.claim("k", 1000);
    expect(seen[0].url).toBe("https://kv.upstash.io");
    expect(seen[0].auth).toBe("Bearer rw-token");
    expect(seen[0].body).toEqual(["SET", "hp:xrpl:replay:k", "in_flight", "NX", "PX", "1000"]);
  });

  it("the read-only token is never used, even when it is the only token present", async () => {
    const ro = { KV_REST_API_URL: KV.KV_REST_API_URL, KV_REST_API_READ_ONLY_TOKEN: "ro-token" };
    expect(resolveSharedReplayStoreEnv(ro)).toBeNull();
    expect(createReplayStore(ro).kind).toBe("memory");
    expect(hasSharedReplayStoreEnv(ro)).toBe(false);
    const { seen } = capture(KV);
    const s = createReplayStore(KV, (async (u: string, i: { headers: Record<string, string>; body: string }) => {
      seen.push({ url: u, auth: i.headers.Authorization, body: JSON.parse(i.body) });
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }) as unknown as typeof fetch);
    await s.claim("x", 1000).catch(() => {});
    await s.set("x", "settled", 1000);
    await s.release("x");
    expect(seen.length).toBeGreaterThan(0);
    for (const c of seen) expect(c.auth).not.toContain("ro-token");
  });

  it("UPSTASH_* wins when both families are set (no mixing)", () => {
    expect(resolveSharedReplayStoreEnv({ ...KV, ...UP })).toEqual({ url: "https://up.upstash.io", token: "up-token", source: "upstash" });
  });

  it("fail closed: half-set UPSTASH pair does NOT fall back to KV; half-set KV; non-https", () => {
    expect(resolveSharedReplayStoreEnv({ ...KV, UPSTASH_REDIS_REST_URL: UP.UPSTASH_REDIS_REST_URL })).toBeNull();
    expect(resolveSharedReplayStoreEnv({ ...KV, UPSTASH_REDIS_REST_TOKEN: "up-token" })).toBeNull();
    expect(resolveSharedReplayStoreEnv({ KV_REST_API_URL: KV.KV_REST_API_URL })).toBeNull();
    expect(resolveSharedReplayStoreEnv({ KV_REST_API_TOKEN: "rw-token" })).toBeNull();
    expect(resolveSharedReplayStoreEnv({ ...KV, KV_REST_API_URL: "http://kv.upstash.io" })).toBeNull();
    expect(resolveSharedReplayStoreEnv({ KV_REST_API_URL: "  ", KV_REST_API_TOKEN: "rw-token" })).toBeNull();
    expect(createReplayStore({ ...KV, UPSTASH_REDIS_REST_URL: UP.UPSTASH_REDIS_REST_URL }).kind).toBe("memory");
  });

  it("xrpl:0 config accepts the KV pair as the shared store; refuses read-only-only and nothing", () => {
    const MAIN = { HP_XRPL_ENABLED: "true", HP_XRPL_NETWORK: "xrpl:0", HP_XRPL_PAYTO: "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf", HP_XRPL_FACILITATOR_URL: "self", XRPL_MAINNET_ALLOWED: "true" };
    expect(getXrplRailConfig({ ...MAIN, ...KV }).enabled).toBe(true);
    expect(getXrplRailConfig({ ...MAIN, KV_REST_API_URL: KV.KV_REST_API_URL, KV_REST_API_READ_ONLY_TOKEN: "ro" }).enabled).toBe(false);
    expect(getXrplRailConfig(MAIN).enabled).toBe(false);
    // flags off: KV present changes nothing
    expect(getXrplRailConfig({ ...KV }).enabled).toBe(false);
  });
});
