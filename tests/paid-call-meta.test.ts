import { describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_SECONDS, settleInfo, withPaidCallMeta } from "@/lib/paid-call-meta";

const settle = Buffer.from(JSON.stringify({ success: true, transaction: "0xabc", network: "eip155:8453", payer: "0x1" })).toString("base64");
const paid = () => new Response("{}", { status: 200, headers: { "payment-response": settle } });

describe("paid-call meta (plan #2)", () => {
  it("adds the poll interval on a settled 2xx feed route and logs route/rail/tx only", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = withPaidCallMeta("/api/pulse", "GET", paid());
    expect(r.headers.get("x-hp-poll-interval-seconds")).toBe(String(POLL_INTERVAL_SECONDS["/api/pulse"]));
    const line = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(line).toEqual({ evt: "paid_call", route: "/api/pulse", rail: "eip155:8453", tx: "0xabc" });
    expect(JSON.stringify(line)).not.toContain("payer");
    log.mockRestore();
  });
  it("non-feed route: logs, no cadence header", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = withPaidCallMeta("/api/fetch", "GET", paid());
    expect(r.headers.get("x-hp-poll-interval-seconds")).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
  it("leaves unpaid 402, errors and HEAD untouched and silent", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const [m, res] of [
      ["GET", new Response("{}", { status: 402 })],
      ["GET", new Response("{}", { status: 500, headers: { "payment-response": settle } })],
      ["HEAD", paid()],
      ["GET", new Response("{}", { status: 200 })],
    ] as const) {
      const out = withPaidCallMeta("/api/pulse", m, res);
      expect(out.headers.get("x-hp-poll-interval-seconds")).toBeNull();
    }
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it("bad settle header decodes to empty", () => {
    expect(settleInfo(new Response("", { headers: { "payment-response": "%%%" } }))).toEqual({});
  });
});
