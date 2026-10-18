/**
 * Odin 11:44 AM ET (e): /status exposes the replay-store EVAL probe as a NON-SECRET meta field for the post-deploy
 * smoke (scripts/smoke-xrpl-replay-eval.mjs): <meta name="hp-xrpl-replay-eval" content="ok|unavailable|not_applicable">.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetXrplRailForTests, setXrplReplayStoreForTests } from "@/lib/xrpl-rail";
import { MemoryReplayStore } from "@/lib/xrpl-replay-store";
import { generateMetadata } from "@/app/status/page";

const mem = new MemoryReplayStore();
const shared = (probeEval: () => Promise<void>) =>
  ({ kind: "upstash", claim: mem.claim.bind(mem), set: mem.set.bind(mem), release: mem.release.bind(mem), get: mem.get.bind(mem), cas: mem.cas.bind(mem), probeEval }) as never;

afterEach(() => {
  setXrplReplayStoreForTests(null);
  resetXrplRailForTests();
  vi.restoreAllMocks();
});

describe("/status hp-xrpl-replay-eval meta (non-secret)", () => {
  it("ok / unavailable / not_applicable; carries no URL or token; title unchanged", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    setXrplReplayStoreForTests(shared(async () => {}));
    const ok = await generateMetadata();
    expect(ok.other).toEqual({ "hp-xrpl-replay-eval": "ok", "hp-solana-replay-eval": "not_applicable" }); // Solana: no shared store / rail off here
    expect(ok.title).toBe("Status | Horizon Pulse");
    setXrplReplayStoreForTests(shared(async () => { throw new Error("NOPERM https://secret.upstash.io token=abc"); }));
    const bad = await generateMetadata();
    expect(bad.other).toEqual({ "hp-xrpl-replay-eval": "unavailable", "hp-solana-replay-eval": "not_applicable" });
    expect(JSON.stringify(bad)).not.toMatch(/upstash|token|secret/i);
    setXrplReplayStoreForTests(new MemoryReplayStore());
    expect((await generateMetadata()).other).toEqual({ "hp-xrpl-replay-eval": "not_applicable", "hp-solana-replay-eval": "not_applicable" });
  });
});
