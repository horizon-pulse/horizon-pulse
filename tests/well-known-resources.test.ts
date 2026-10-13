/**
 * Odin 2026-10-13 hygiene (a): /.well-known/x402 resources are plain absolute
 * URLs (x402scan DISCOVERY.md section B form). "GET https://…" strings were
 * mis-split by Agent402's crawler (it only splits "VERB /path") into junk
 * routes like "/GET%20https://horizonpulse.dev/api/pulse".
 */
import { describe, expect, it } from "vitest";
import { GET } from "@/app/.well-known/x402/route";
import { LIVE_PAID_ROUTES } from "@/lib/live-catalog";

describe("/.well-known/x402 resources", () => {
  it("are unique same-origin absolute URLs with no verb prefix, one per paid path", async () => {
    const body = (await GET().json()) as { version: number; resources: string[] };
    expect(body.version).toBe(1);
    const paths = new Set(LIVE_PAID_ROUTES.map((r) => r.path.split("?")[0]));
    expect(body.resources.length).toBe(paths.size);
    expect(new Set(body.resources).size).toBe(body.resources.length);
    for (const r of body.resources) {
      expect(r).not.toMatch(/\s/);
      const u = new URL(r);
      expect(u.origin).toBe("https://horizonpulse.dev");
      expect(paths.has(u.pathname)).toBe(true);
    }
  });
});
