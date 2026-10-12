/**
 * HEAD is served by each route's GET handler (Next.js). The unpaid challenge
 * must declare the same Bazaar method for HEAD as for GET ("GET"), not "HEAD".
 */
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV } from "./helpers/capture";

const ROOT = path.resolve(__dirname, "..");

describe("HEAD 402 bazaar method", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("HEAD /api/pulse 402 declares bazaar method GET, same PAYMENT-REQUIRED as GET", async () => {
    installFacilitatorMock();
    vi.stubEnv("CDP_API_KEY_ID", CDP_ENV.CDP_API_KEY_ID);
    vi.stubEnv("CDP_API_KEY_SECRET", CDP_ENV.CDP_API_KEY_SECRET);
    const mod = (await import(path.join(ROOT, "app", "api", "pulse", "route.ts"))) as { GET: (r: NextRequest) => Promise<Response> };
    const mk = (method: string) => new NextRequest("https://horizonpulse.dev/api/pulse", { method, headers: { accept: "application/json" } });
    const head = await mod.GET(mk("HEAD"));
    const get = await mod.GET(mk("GET"));
    expect(head.status).toBe(402);
    const pr = decodePaymentRequiredHeader(head.headers.get("payment-required")!) as { extensions?: { bazaar?: { info?: { input?: { method?: string } } } } };
    expect(pr.extensions?.bazaar?.info?.input?.method).toBe("GET");
    expect(head.headers.get("payment-required")).toBe(get.headers.get("payment-required"));
  });
});
