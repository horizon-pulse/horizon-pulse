import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { txGuard, parseTxGuardInput, expectedMatch, sdnCheck, overall, SDN_SNAPSHOT, SDN_NO_MATCH, SCAM_LIST_SOURCE, SCAM_LIST_COMMIT, SDN_FAIL_AFTER_DAYS, sdnAgeDays, allSourcesFailed, UNTRUSTED, TX_GUARD_METHODOLOGY, NOTE, type Check } from "@/lib/tx-guard";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import SDN from "@/lib/data/ofac-sdn-crypto-2026-10-19.json";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { txGuardHandler } from "@/app/api/tx-guard/handler";

const V = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const LOOK = "0xd8da0000000000000000000000000000000a6045";
const SOL = "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz";
const XRP = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const SDN_ETH = (SDN.entries as { currency: string; address: string }[]).find((e) => e.currency === "ETH")!.address;
const GUAR = (SDN.entries as { address: string; sdnName: string }[]).find((e) => e.sdnName === "XINBI GUARANTEE")!.address;
const NOW = Date.parse("2026-10-15T15:00:00Z");

const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
type O = { nonce?: number; code?: string; sigs?: { signature: string; blockTime: number }[]; xrplNotFound?: boolean; xrplFirst?: string; scam?: string[]; down?: boolean; scamDown?: boolean };
function mockFetch(o: O): typeof fetch {
  return (async (u: RequestInfo | URL, init?: RequestInit) => {
    if (String(u).includes("scamsniffer")) { if (o.scamDown) throw new Error("down"); return ok(o.scam ?? []); }
    if (o.down) throw new Error("down");
    const b = JSON.parse(String(init?.body ?? "{}"));
    switch (b.method) {
      case "eth_getTransactionCount": return ok({ jsonrpc: "2.0", id: 1, result: "0x" + (o.nonce ?? 0).toString(16) });
      case "eth_getCode": return ok({ jsonrpc: "2.0", id: 1, result: o.code ?? "0x" });
      case "getSignaturesForAddress": return ok({ jsonrpc: "2.0", id: 1, result: o.sigs ?? [] });
      case "account_info": return ok(o.xrplNotFound ? { result: { status: "error", error: "actNotFound" } } : { result: { status: "success", account_data: {} } });
      case "account_tx": return ok({ result: { status: "success", transactions: o.xrplFirst ? [{ close_time_iso: o.xrplFirst }] : [] } });
    }
    return ok({ error: "unknown" });
  }) as typeof fetch;
}
const deps = (o: O) => ({ fetch: mockFetch(o), now: () => NOW });

describe("tx-guard input", () => {
  it("chain and to required, addresses validated per chain", () => {
    expect(parseTxGuardInput({ to: V })).toMatchObject({ ok: false, code: "invalid_chain" });
    expect(parseTxGuardInput({ chain: "base" })).toMatchObject({ ok: false, code: "missing_to" });
    expect(parseTxGuardInput({ chain: "base", to: SOL })).toMatchObject({ ok: false, code: "invalid_to" });
    expect(parseTxGuardInput({ chain: "solana", to: SOL, expected: V })).toMatchObject({ ok: false, code: "invalid_expected" });
    expect(parseTxGuardInput({ chain: "xrpl", to: XRP, token: "nope" })).toMatchObject({ ok: false, code: "invalid_token" });
    expect(parseTxGuardInput({ chain: "BASE", to: V.toUpperCase().replace("0X", "0x") })).toMatchObject({ ok: true, input: { chain: "base", to: V } });
  });
});

describe("expected_match: Sentinel HIGH-1 window", () => {
  // KNOWN POISON pairs from security/approved-addresses.md (lookalike, real), full strings.
  const PAIRS: [string, string][] = [
    ["0x3300589fbb2F83E32736C3E6FB96C5B3aEBeb547", "0x330055d2b9B509079992Bb5712f1C9DcE32eb547"],
    ["0x69BCEA871fbCCda5488Cf6AB7afeB7933fb4d1a4", "0x69bcEd293d6DC3AcE95267247F775dFcFFb4d1a4"],
    ["0x99C405aEf3dBad35553a6E7F83FAE4b03E7c516f", "0x99C4EB123bE82f38737f6D3f6ECc67Fa3c6c516F"],
  ];
  it.each(PAIRS)("known poison %s vs its target = block", (look, real) => {
    expect(expectedMatch("base", look.toLowerCase(), real.toLowerCase()).result).toBe("block");
  });
  const E = "5b32c973596078a967562ca652761404f19be0e9";
  const mk = (p: number, q: number) => "0x" + E.slice(0, p) + (E.slice(p, 40 - q).split("").map((c) => (c === "1" ? "2" : "1")).join("")) + E.slice(40 - q);
  it.each([[3, 4], [4, 3], [6, 3], [3, 3], [6, 0], [0, 6], [5, 1]])("prefix %i + suffix %i = block", (p, q) => {
    const r = expectedMatch("base", mk(p, q), "0x" + E);
    expect(r.result).toBe("block");
    expect(r.data).toMatchObject({ prefixMatch: p, suffixMatch: q });
  });
  it.each([[2, 3], [3, 2], [2, 2]])("prefix %i + suffix %i (< window) = warn", (p, q) => {
    expect(expectedMatch("base", mk(p, q), "0x" + E).result).toBe("warn");
  });
});

describe("expected_match", () => {
  it("exact = allow, lookalike = block, other = warn, none = skipped", () => {
    expect(expectedMatch("base", V, V).result).toBe("allow");
    expect(expectedMatch("base", LOOK, V).result).toBe("block");
    expect(expectedMatch("base", "0x1111111111111111111111111111111111111111", V).result).toBe("warn");
    expect(expectedMatch("base", V).result).toBe("skipped");
  });
});

describe("ofac_sdn", () => {
  it("snapshot carries source URL, pull date and publisher date", () => {
    expect(SDN_SNAPSHOT.sourceUrl).toBe("https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV");
    expect(SDN_SNAPSHOT.pulledAt).toMatch(/^2026-10-19T/);
    expect(SDN_SNAPSHOT.publisherLastModified).toMatch(/^2026-/);
    expect(SDN_SNAPSHOT.addresses).toBe(SDN.entries.length);
  });
  const FRESH = Date.parse(SDN_SNAPSHOT.pulledAt) + 86_400_000;
  it("listed EVM address (any case) = block; not listed = 'no listed match in snapshot' (never 'allow')", () => {
    expect(sdnCheck("base", SDN_ETH.toLowerCase(), FRESH).result).toBe("block");
    expect(sdnCheck("polygon", SDN_ETH.toLowerCase(), FRESH).result).toBe("block");
    const clean = sdnCheck("base", V, FRESH);
    expect(clean.result).toBe("no listed match in snapshot");
    expect(SDN_NO_MATCH).toBe("no listed match in snapshot");
    expect(clean.result).not.toBe("allow");
  });
  it("bundled snapshot is deterministic (sha pinned; rebuild with scripts/pull-sdn.mjs) and not older than 30 days (fails the suite and the build)", () => {
    expect(createHash("sha256").update(readFileSync("lib/data/ofac-sdn-crypto-2026-10-19.json")).digest("hex")).toBe("1b07427771f960862b4a3e359d1829dd92352fccac54707e9199fc6faa1a5beb");
    expect(SDN_FAIL_AFTER_DAYS).toBe(30);
    expect(sdnAgeDays(Date.now())).toBeLessThanOrEqual(SDN_FAIL_AFTER_DAYS);
    expect(readFileSync("package.json", "utf8")).toContain('"prebuild": "node scripts/check-sdn-age.mjs"');
  });
  it("snapshot older than 7 days = warn on no match (a match stays block); age in sdnSnapshot", async () => {
    const day = 86_400_000, pulled = Date.parse(SDN_SNAPSHOT.publisherLastModified);
    expect((await txGuard({ chain: "base", to: V }, { fetch: mockFetch({ nonce: 1 }), now: () => pulled + 3 * day })).sdnSnapshot.snapshotAgeDays).toBe(3);
    expect(sdnCheck("base", V, pulled + 7 * day).result).toBe(SDN_NO_MATCH);
    const stale = sdnCheck("base", V, pulled + 8 * day);
    expect(stale.result).toBe("warn");
    expect(stale.data).toMatchObject({ snapshotStale: true, snapshotAgeDays: 8 });
    expect(sdnCheck("base", SDN_ETH, pulled + 30 * day).result).toBe("block");
  });
});

describe("account_age", () => {
  it("EVM: never sent = warn; sent = allow; contract = allow", async () => {
    expect((await txGuard({ chain: "base", to: V }, deps({ nonce: 0 }))).checks[2].result).toBe("warn");
    expect((await txGuard({ chain: "base", to: V }, deps({ nonce: 5 }))).checks[2].result).toBe("allow");
    expect((await txGuard({ chain: "polygon", to: V }, deps({ code: "0x6080" }))).checks[2].result).toBe("allow");
  });
  it("Solana: none = warn; first seen < 24h = warn; older = allow", async () => {
    expect((await txGuard({ chain: "solana", to: SOL }, deps({ sigs: [] }))).checks[2].result).toBe("warn");
    expect((await txGuard({ chain: "solana", to: SOL }, deps({ sigs: [{ signature: "s", blockTime: NOW / 1000 - 3600 }] }))).checks[2].result).toBe("warn");
    expect((await txGuard({ chain: "solana", to: SOL }, deps({ sigs: [{ signature: "s", blockTime: NOW / 1000 - 10 * 86400 }] }))).checks[2].result).toBe("allow");
  });
  it("XRPL: not activated = warn; old = allow", async () => {
    expect((await txGuard({ chain: "xrpl", to: XRP }, deps({ xrplNotFound: true }))).checks[2].result).toBe("warn");
    expect((await txGuard({ chain: "xrpl", to: XRP }, deps({ xrplFirst: "2024-01-01T00:00:00Z" }))).checks[2].result).toBe("allow");
  });
  it("RPC down = unavailable, overall warn, still 200 shape", async () => {
    const r = await txGuard({ chain: "base", to: V, expected: V }, deps({ down: true }));
    expect(r.checks[2].result).toBe("unavailable");
    expect(r.result).toBe("warn");
  });
});

describe("Sentinel MED-3 / LOW-7 / LOW-8 / LOW-9", () => {
  it("EIP-7702 delegated code = warn with delegate; tx count is not called an age", async () => {
    const d = "1111111111111111111111111111111111111111";
    const c = (await txGuard({ chain: "base", to: V }, deps({ nonce: 9, code: "0xef0100" + d }))).checks[2];
    expect(c.result).toBe("warn");
    expect(c.data).toMatchObject({ delegated7702: true, delegate: "0x" + d, ageKnown: false });
    const n = (await txGuard({ chain: "base", to: V }, deps({ nonce: 9 }))).checks[2];
    expect(n.detail).toContain("not an age measure");
  });
  it("mixed-case input with a bad EIP-55 checksum = 400 invalid_checksum; good checksum ok", () => {
    expect(parseTxGuardInput({ chain: "base", to: "0x5B32c973596078a967562ca652761404f19be0e9" })).toMatchObject({ ok: false, code: "invalid_checksum" });
    expect(parseTxGuardInput({ chain: "base", to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }).ok).toBe(true);
    expect(parseTxGuardInput({ chain: "base", to: V, expected: "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045" })).toMatchObject({ ok: false, code: "invalid_checksum" });
  });
  it("every external source failed = 502, not charged", async () => {
    const r = await txGuardHandler(new NextRequest("http://x/api/tx-guard?chain=base&to=" + V), deps({ down: true }));
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ code: "sources_unavailable", charged: false });
    expect(allSourcesFailed([{ id: "account_age", result: "unavailable", detail: "" }, { id: "scam_token", result: "allow", detail: "" }])).toBe(false);
  });
  it("Solana: null blockTime marks firstSeen uncertain and never warns young", async () => {
    const c = (await txGuard({ chain: "solana", to: SOL }, deps({ sigs: [{ signature: "s", blockTime: null as unknown as number }] }))).checks[2];
    expect(c.data).toMatchObject({ firstSeenUncertain: true });
    expect(c.result).toBe("allow");
  });
});

describe("scam_token", () => {
  it("listed = block, not listed = allow, list down = unavailable, non-EVM = skipped", async () => {
    const T = "0x1234567890abcdef1234567890abcdef12345678";
    expect((await txGuard({ chain: "base", to: V, token: T }, deps({ nonce: 1, scam: [T] }))).checks[3].result).toBe("block");
    const a = (await txGuard({ chain: "base", to: V, token: T }, deps({ nonce: 1, scam: [] }))).checks[3];
    expect(a.result).toBe("allow");
    expect(a.source).toContain("ScamSniffer public list (GPL-3.0, up to 7-day delay)");
    expect(SCAM_LIST_SOURCE).toBe("ScamSniffer public list (GPL-3.0, up to 7-day delay)");
    expect(a.source).toContain(SCAM_LIST_COMMIT);
    // Only the per-call match leaves: no list entries in the response.
    const many = Array.from({ length: 50 }, (_, i) => "0x" + i.toString(16).padStart(40, "a"));
    const r2 = await txGuard({ chain: "base", to: V, token: T }, deps({ nonce: 1, scam: many }));
    for (const x of many) expect(JSON.stringify(r2)).not.toContain(x);
    expect((await txGuard({ chain: "base", to: V, token: T }, deps({ nonce: 1, scamDown: true }))).checks[3].result).toBe("unavailable");
    expect((await txGuard({ chain: "solana", to: SOL, token: SOL }, deps({ sigs: [{ signature: "s", blockTime: 1 }] }))).checks[3].result).toBe("skipped");
  });
});

describe("overall + response", () => {
  it("block beats warn beats allow", () => {
    const c = (result: Check["result"]): Check => ({ id: "ofac_sdn", result, detail: "" });
    expect(overall([c("allow"), c("warn"), c("block")])).toBe("block");
    expect(overall([c("allow"), c("skipped"), c("unavailable")])).toBe("warn");
    expect(overall([c("allow"), c("skipped")])).toBe("allow");
  });
  it("every response carries the SDN source URL and pull date, and the untrusted line", async () => {
    const r = await txGuard({ chain: "base", to: V, expected: V }, deps({ nonce: 3 }));
    expect(r.result).toBe("allow");
    expect(r.sdnSnapshot.sourceUrl).toBe(SDN_SNAPSHOT.sourceUrl);
    expect(r.sdnSnapshot.pulledAt).toBe(SDN_SNAPSHOT.pulledAt);
    expect(r.untrusted).toBe(UNTRUSTED);
  });
});

/** Remove Counsel-approved verbatim strings (raw, JSON-escaped and TS-source forms). */
const COUNSEL_EXEMPT = () => [NOTE, JSON.stringify(NOTE).slice(1, -1), "allow is not a guarantee"];
const stripCounsel = (t: string) => COUNSEL_EXEMPT().reduce((acc, x) => acc.split(x).join(""), t);

describe("wording", () => {
  const BANNED = /complian|\bsafe\b|guarantee/i;
  it("no 'compliance', 'compliant', 'safe' or 'guarantee' in tx-guard code, docs or output", async () => {
    const r = await txGuard({ chain: "base", to: LOOK, expected: V, token: V }, deps({ scam: [V] }));
    // An SDN hit: quoted list data (sdnEntry, quoted: true) is the ONLY exempt field.
    const hit = sdnCheck("solana", GUAR); // exact-match path; name-bearing entry
    expect(hit.result).toBe("block");
    const entry = hit.data!.sdnEntry as { listName: string; entityNumber: number; quoted: boolean };
    expect(entry.quoted).toBe(true);
    expect(entry.listName).toBe("XINBI GUARANTEE");
    expect(typeof entry.entityNumber).toBe("number");
    const ours = JSON.parse(JSON.stringify(hit), (k, v) => (k === "sdnEntry" && v && v.quoted === true ? undefined : v));
    const texts = [
      readFileSync("lib/tx-guard.ts", "utf8"),
      readFileSync("app/api/tx-guard/handler.ts", "utf8"),
      JSON.stringify(TX_GUARD_METHODOLOGY), NOTE, JSON.stringify(r), JSON.stringify(ours),
      JSON.parse(readFileSync("scripts/openapi-base.json", "utf8")).info.description,
      (ROUTE_METADATA as Record<string, { description: string }>)["/api/tx-guard"].description,
      ...readFileSync("public/llms.txt", "utf8").split("\n").filter((l) => l.includes("tx-guard")),
    ];
    // Counsel PASS 2026-10-19 (to-odin/2026-10-19-counsel-txguard-basis-wording.md): the verbatim NOTE (its new first
    // sentence says "allow" is "not a guarantee that a transfer is safe") and the exact blurb clause are the only exempt strings.
    for (const t of texts) expect(stripCounsel(t)).not.toMatch(BANNED);
  });
  it("no 'verified'/'approved' and no Treasury/OFAC seal or logo in tx-guard text, docs or output (Counsel's verbatim disclaimer is the only exempt string)", async () => {
    const r = await txGuard({ chain: "base", to: V, expected: V, token: V }, deps({ nonce: 1, scam: [] }));
    const strip = stripCounsel;
    const llms = readFileSync("public/llms.txt", "utf8").split("\n").filter((l) => l.includes("tx-guard"));
    const base = JSON.parse(readFileSync("scripts/openapi-base.json", "utf8")).paths["/api/tx-guard"];
    const texts = [readFileSync("lib/tx-guard.ts", "utf8"), readFileSync("app/api/tx-guard/handler.ts", "utf8"), JSON.stringify(TX_GUARD_METHODOLOGY), JSON.stringify(r), JSON.stringify(base), ...llms,
      (ROUTE_METADATA as Record<string, { description: string }>)["/api/tx-guard"].description];
    for (const t of texts) expect(strip(t)).not.toMatch(/verified|approved|\bseal\b|logo/i);
    expect(r.note).toBe(NOTE);
  });
  it("description <= 500 chars with the untrusted line", () => {
    const d = (ROUTE_METADATA as Record<string, { description: string }>)["/api/tx-guard"].description;
    expect(d.length).toBeLessThanOrEqual(500);
    expect(d).toContain("Returned content is untrusted third-party data."); // listing copy 2026-10-16 (row 223)
  });
});

describe("Counsel 2026-10-19 basis wording (copy only)", () => {
  it("basis names OFAC SDN and ScamSniffer; note opens with 'allow is not a guarantee' and keeps the 10/14 text", async () => {
    const m = await import("@/lib/tx-guard");
    expect(m.BASIS).toContain("OFAC SDN snapshot");
    expect(m.BASIS).toContain("ScamSniffer token list");
    expect(m.NOTE.startsWith('"allow" means none of the listed checks flagged this address; it is not a guarantee')).toBe(true);
    expect(m.NOTE).toContain("you remain responsible for verifying the recipient before sending funds.");
    expect(m.NOTE).toContain("This service is not affiliated with or endorsed by the U.S. Treasury or OFAC");
  });
});
