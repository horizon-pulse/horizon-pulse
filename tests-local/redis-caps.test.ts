/** LOCAL ONLY, never in CI: the real seller-dd caps Lua on a local Redis OSS via a thin Upstash-REST shim. Run: node scripts/test-redis-caps.mjs (see docs/seller-dd-local-redis.md). */
import net from "node:net";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UpstashPremiumStore } from "@/lib/premium/store";
import { ddKeys, releaseUnsigned, reserveTestPay, type Reservation } from "@/lib/seller-dd/caps";
import { unsettledKey } from "@/lib/premium/handler";

const PORT = Number(process.env.HP_LOCAL_REDIS_PORT ?? "0");
if (!PORT) throw new Error("HP_LOCAL_REDIS_PORT not set: run via node scripts/test-redis-caps.mjs");

const enc = (a: (string | number)[]) => `*${a.length}\r\n` + a.map((x) => { const b = Buffer.from(String(x)); return `$${b.length}\r\n${b}\r\n`; }).join("");
function parse(buf: Buffer, i = 0): [unknown, number] {
  const t = String.fromCharCode(buf[i]!); const e = buf.indexOf("\r\n", i); const line = buf.toString("utf8", i + 1, e);
  if (t === "+") return [line, e + 2]; if (t === "-") return [{ __err: line }, e + 2]; if (t === ":") return [Number(line), e + 2];
  if (t === "$") { const n = Number(line); if (n < 0) return [null, e + 2]; return [buf.toString("utf8", e + 2, e + 2 + n), e + 4 + n]; }
  if (t === "*") { const n = Number(line); if (n < 0) return [null, e + 2]; const out = []; let j = e + 2; for (let k = 0; k < n; k++) { const [v, nj] = parse(buf, j); out.push(v); j = nj; } return [out, j]; }
  throw new Error("resp");
}
function send(cmds: (string | number)[][]): Promise<unknown[]> {
  return new Promise((res, rej) => {
    const s = net.connect(PORT, "127.0.0.1"); let buf = Buffer.alloc(0);
    s.on("data", (d) => { buf = Buffer.concat([buf, d]); try { const out = []; let j = 0; for (let k = 0; k < cmds.length; k++) { const [v, nj] = parse(buf, j); out.push(v); j = nj; } s.end(); res(out); } catch { /* wait for more */ } });
    s.on("error", rej); s.write(cmds.map(enc).join(""));
  });
}
const shim = (async (_u: string, init: any) => {
  const cmds = JSON.parse(init.body) as (string | number)[][];
  const out = await send(cmds);
  return new Response(JSON.stringify(out.map((r: any) => (r && r.__err ? { error: r.__err } : { result: r }))), { status: 200 });
}) as unknown as typeof fetch;

const NOW = Date.parse("2026-10-21T15:00:00Z");
const PREFIX = `hp:test:ddcap:${randomBytes(6).toString("hex")}:`;
const store = () => new UpstashPremiumStore(`http://127.0.0.1:${PORT}`, "local", PREFIX, shim);
let i = 0;
const res = (o: Partial<Reservation> = {}): Reservation => ({ request_id: `r${i++}`, seller: `s${i}.example.com`, domain: `d${i}.com`, ip: `10.0.${Math.floor(i / 250)}.${i % 250}`, payTo: "0x" + "ab".repeat(20), value_usd: 0.1, nonce: "0x" + i.toString(16).padStart(64, "0"), validBefore: Math.floor(NOW / 1000) + 240, at: NOW, ...o });
const get = async (k: string) => Number((await send([["GET", PREFIX + k]]))[0] ?? 0);
const flush = async () => { const keys = (await send([["KEYS", PREFIX + "*"]]))[0] as string[]; if (keys.length) await send([["DEL", ...keys]]); };

describe(`Redis OSS local: ${PREFIX}`, () => {
  it("version", async () => { const info = String((await send([["INFO", "server"]]))[0]); console.log("REDIS", /redis_version:(\S+)/.exec(info)![1], "prefix", PREFIX); });
  it("200 parallel reserves: no cap overshoot (unsettled $3 is the limiter => exactly 30)", async () => {
    await flush(); const s = store();
    const out = await Promise.all(Array.from({ length: 200 }, () => reserveTestPay(s, res(), NOW)));
    const ok = out.filter((o) => o.ok).length;
    const day = await get(ddKeys.day(NOW)), life = await get(ddKeys.life()), uns = await get(unsettledKey(NOW));
    console.log("200-parallel", { ok, refused: 200 - ok, day_micro: day, life_micro: life, unsettled_usd: uns, codes: [...new Set(out.filter((o) => !o.ok).map((o: any) => o.code))] });
    expect(day).toBeLessThanOrEqual(5_000_000); expect(life).toBeLessThanOrEqual(25_000_000); expect(uns).toBeLessThanOrEqual(3 + 1e-9);
    expect(day).toBe(ok * 100_000); expect(life).toBe(ok * 100_000);
    expect(ok).toBe(30);
  });
  it("200 parallel with day cap as limiter (unsettled pre-empty, day at 4.5): exactly 5", async () => {
    await flush(); const s = store();
    await send([["SET", PREFIX + ddKeys.day(NOW), "4500000"], ["SET", PREFIX + ddKeys.life(), "0"]]);
    const out = await Promise.all(Array.from({ length: 200 }, () => reserveTestPay(s, res(), NOW)));
    const ok = out.filter((o) => o.ok).length;
    console.log("day-edge", { ok, day_micro: await get(ddKeys.day(NOW)) });
    expect(ok).toBe(5); expect(await get(ddKeys.day(NOW))).toBe(5_000_000);
  });
  it("lifetime edge: 24.7 + 30 parallel -> exactly 3, no leaked partials", async () => {
    await flush(); const s = store();
    await send([["SET", PREFIX + ddKeys.life(), "24700000"]]);
    const out = await Promise.all(Array.from({ length: 30 }, () => reserveTestPay(s, res(), NOW)));
    const ok = out.filter((o) => o.ok).length;
    console.log("lifetime-edge", { ok, life_micro: await get(ddKeys.life()), day_micro: await get(ddKeys.day(NOW)), unsettled: await get(unsettledKey(NOW)) });
    expect(ok).toBe(3); expect(await get(ddKeys.life())).toBe(25_000_000); expect(await get(ddKeys.day(NOW))).toBe(300_000);
    expect(out.filter((o) => !o.ok).every((o: any) => o.code === "lifetime_cap")).toBe(true);
  });
  it("per-host: 25 parallel same domain -> exactly 3", async () => {
    await flush(); const s = store();
    const out = await Promise.all(Array.from({ length: 25 }, () => reserveTestPay(s, res({ domain: "same.com" }), NOW)));
    const ok = out.filter((o) => o.ok).length;
    console.log("per-host", { ok, host: await get(ddKeys.host("same.com", NOW)) });
    expect(ok).toBe(3); expect(await get(ddKeys.host("same.com", NOW))).toBe(3);
  });
  it("LOW-B on real Lua: 20 parallel releases of one reservation refund exactly once", async () => {
    await flush(); const s = store();
    const r = res(); expect((await reserveTestPay(s, r, NOW)).ok).toBe(true);
    const rel = await Promise.all(Array.from({ length: 20 }, () => releaseUnsigned(s, r, NOW)));
    console.log("release-once", { released_true: rel.filter(Boolean).length, day_micro: await get(ddKeys.day(NOW)) });
    expect(rel.filter(Boolean).length).toBe(1); expect(await get(ddKeys.day(NOW))).toBe(0);
  });
  it("MEDIUM-1: release before any reserve seeds from the legacy float key; caps remember it", async () => {
    await flush(); const s = store();
    await send([["SET", PREFIX + ddKeys.legacyLife(), "24.9"]]);
    await releaseUnsigned(s, res(), NOW);
    expect(await get(ddKeys.life())).toBe(24_800_000);
    const out = await Promise.all(Array.from({ length: 10 }, () => reserveTestPay(s, res(), NOW)));
    expect(out.filter((o) => o.ok).length).toBe(2); expect(await get(ddKeys.life())).toBe(25_000_000);
  });
  it("cleanup", async () => { await flush(); expect(((await send([["KEYS", PREFIX + "*"]]))[0] as string[]).length).toBe(0); });
});
