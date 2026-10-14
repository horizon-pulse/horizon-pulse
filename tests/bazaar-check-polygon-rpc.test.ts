/** polygon-rpc.com answers 403 "API key disabled": bazaar-check's Polygon on-chain check tries keyless RPCs first. */
import { describe, expect, it, vi } from "vitest";
import { defaultDeps, onchainCheck } from "@/lib/bazaar-check";

describe("Polygon on-chain check RPC order", () => {
  it("first call goes to polygon.drpc.org, never polygon-rpc.com when it answers", async () => {
    const urls: string[] = [];
    const deps = { ...defaultDeps(), fetch: vi.fn(async (u: string | URL | Request) => { urls.push(String(u)); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x01" })); }) as unknown as typeof fetch };
    const r = await onchainCheck(deps, "eip155:137", "0x5b32c973596078a967562ca652761404f19be0e9");
    expect(r?.holdsUsdc).toBe(true);
    expect(urls).toEqual(["https://polygon.drpc.org"]);
  });
  it("polygon-rpc.com is only the last fallback", async () => {
    const urls: string[] = [];
    const deps = { ...defaultDeps(), fetch: vi.fn(async (u: string | URL | Request) => { urls.push(String(u)); throw new Error("down"); }) as unknown as typeof fetch };
    const r = await onchainCheck(deps, "eip155:137", "0x5b32c973596078a967562ca652761404f19be0e9");
    expect(r?.holdsUsdc).toBeNull();
    expect(urls).toEqual(["https://polygon.drpc.org", "https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"]);
  });
});
