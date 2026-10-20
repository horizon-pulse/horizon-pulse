/** C2 SSRF / rebinding on the real guarded transport with stub DNS (no external network). */
import { describe, expect, it } from "vitest";
import { defaultNetDeps } from "@/lib/seller-dd/checks";

const resolver = (ips: string[] | (() => string[])) => (_h: string, _o: unknown, cb: (e: any, a: any[]) => void) => cb(null, (typeof ips === "function" ? ips() : ips).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

describe("C2 network guard", () => {
  it.each(["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1", "fd00::1"])("blocks %s", async (ip) => {
    const n = defaultNetDeps(resolver([ip]) as never);
    const r = await n.get402("https://seller.example.com/api");
    expect(r).toMatchObject({ ok: false, code: "host_blocked" });
  });
  it("http is refused before any connect", async () => {
    const n = defaultNetDeps(resolver(["93.184.216.34"]) as never);
    expect(await n.get402("http://seller.example.com/api")).toEqual({ ok: false, code: "http_not_allowed" });
    expect(await n.getPaid("http://seller.example.com/api", "93.184.216.34", "x")).toEqual({ ok: false, code: "http_not_allowed" });
  });
  it("DNS answer changes between 402 fetch and paid call -> dns_changed, no paid request", async () => {
    const n = defaultNetDeps(resolver(["203.0.113.9"]) as never);
    expect(await n.getPaid("https://seller.example.com/api", "93.184.216.34", "x")).toEqual({ ok: false, code: "dns_changed" });
  });
  it("rebinding to a private IP on the paid call is blocked", async () => {
    let calls = 0;
    const n = defaultNetDeps(resolver(() => (calls++ === 0 ? ["93.184.216.34", "127.0.0.1"] : ["127.0.0.1"])) as never);
    const r = await n.getPaid("https://seller.example.com/api", "93.184.216.34", "x");
    expect(r.ok).toBe(false);
  });
});
