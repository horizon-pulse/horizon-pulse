/**
 * $75 seller watch (async scope §5, Odin Q3/Q6). Day-0 check report at accept, then one record per day for 30 days.
 *  - Day n (1..30) window = [t0 + n·24h, t0 + (n+1)·24h). A record written inside the window = delivered.
 *  - A window that closed with no record -> `missed` (our failure). Never back-filled; never two records per day
 *    (day:{job}:{n} is SET NX).
 *  - Target down / payTo changed / price changed / delisted / screen hit = EVENTS in that day's record, not failures.
 *  - Refund (approved terms): missed >= 3 or our early stop -> price × undelivered ÷ 30; abuse stop -> 0; no auto-renewal.
 *  - Findings wording (Counsel 6–8): quote and link only; screens read "address appears on [list] snapshot dated …";
 *    lookalikes read "resembles". No safety rating.
 */
import { decodeChallenge } from "@/lib/bazaar-check";
import { guardedGet, type GuardedGetErr, type GuardedGetOk } from "@/lib/guarded-get";
import { defaultDeps as txDeps, scamToken, sdnCheck, SDN_SNAPSHOT, type Chain, type Deps as TxDeps } from "@/lib/tx-guard";

export const DAY_MS = 86_400_000;
export const WATCH_DAYS = 30;

export type Accept = { network: string; payTo: string; amount: string; asset: string };
export type Screen = { payTo: string; network: string; list: string; result: "appears" | "no_match" | "unavailable" | "skipped"; detail: string };
export type CheckRecord = {
  checked_at: string;
  target: string;
  reachable: boolean;
  http_status: number | null;
  accepts: Accept[];
  listing: { well_known_present: boolean; target_listed: boolean | null };
  payto_consistency: { evm_payTos: string[]; consistent_across_evm: boolean | null };
  screens: Screen[];
  lookalikes: { a: string; b: string; note: string }[];
};

export type WatchDeps = { get: (url: string) => Promise<GuardedGetOk | GuardedGetErr>; tx: TxDeps };
let depsOverride: WatchDeps | null = null;
export function setWatchDepsForTests(d: WatchDeps | null) {
  depsOverride = d;
}
const deps = (): WatchDeps => depsOverride ?? { get: (u) => guardedGet(u, { maxBytes: 256 * 1024, timeoutMs: 8_000, followRedirects: false }), tx: txDeps() };

function chainOf(network: string): Chain | null {
  if (network === "eip155:8453") return "base";
  if (network === "eip155:137") return "polygon";
  if (network.startsWith("solana:")) return "solana";
  if (network.startsWith("xrpl:")) return "xrpl";
  return null;
}

function parseAccepts(res: GuardedGetOk): Accept[] {
  const hdr = res.headers.get("payment-required");
  const ch = (hdr ? decodeChallenge(hdr) : null) ?? decodeChallenge(Buffer.from(res.body).toString("base64"));
  const list = ch && Array.isArray((ch as any).accepts) ? ((ch as any).accepts as any[]) : [];
  return list.slice(0, 10).map((a) => ({ network: String(a?.network ?? ""), payTo: String(a?.payTo ?? ""), amount: String(a?.amount ?? a?.maxAmountRequired ?? ""), asset: String(a?.asset ?? "") }));
}

/** Two different addresses that share the first 4 and last 4 characters "resemble" each other (lookalike pattern). */
export function resembles(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (x === y || x.length < 12 || y.length < 12) return false;
  const strip = (s: string) => s.replace(/^0x/, "");
  return strip(x).slice(0, 4) === strip(y).slice(0, 4) && x.slice(-4) === y.slice(-4);
}

export async function watchCheck(target: string, known: string[] = []): Promise<CheckRecord> {
  const d = deps();
  const checked_at = new Date(d.tx.now()).toISOString();
  const r = await d.get(target);
  const accepts = r.ok && r.status === 402 ? parseAccepts(r) : [];
  let wellKnown = false;
  let listed: boolean | null = null;
  try {
    const wk = await d.get(`${new URL(target).origin}/.well-known/x402`);
    if (wk.ok && wk.status === 200) {
      wellKnown = true;
      const doc = JSON.parse(wk.body);
      const res: string[] = Array.isArray(doc?.resources) ? doc.resources.map(String) : [];
      const t = target.split("?")[0];
      listed = res.some((x) => x.split("?")[0] === t || x.endsWith(new URL(t).pathname));
    }
  } catch {
    /* listing unknown */
  }
  const evm = [...new Set(accepts.filter((a) => a.network.startsWith("eip155:")).map((a) => a.payTo.toLowerCase()))];
  const screens: Screen[] = [];
  for (const a of accepts) {
    const chain = chainOf(a.network);
    if (!chain || !a.payTo) continue;
    const sdn = sdnCheck(chain, a.payTo, d.tx.now());
    screens.push({
      payTo: a.payTo,
      network: a.network,
      list: "OFAC SDN",
      result: sdn.result === "block" ? "appears" : sdn.result === "unavailable" ? "unavailable" : "no_match",
      detail: sdn.result === "block" ? `address appears on OFAC SDN snapshot dated ${SDN_SNAPSHOT.publisherLastModified}; confirm with the official source` : `no listed match in OFAC SDN snapshot dated ${SDN_SNAPSHOT.publisherLastModified}`,
    });
    const sc = await scamToken(chain, a.payTo, d.tx);
    screens.push({
      payTo: a.payTo,
      network: a.network,
      list: "ScamSniffer",
      result: sc.result === "block" ? "appears" : sc.result === "allow" ? "no_match" : sc.result === "skipped" ? "skipped" : "unavailable",
      detail: sc.result === "block" ? "address appears on the ScamSniffer public list snapshot; confirm with the official source" : sc.detail,
    });
  }
  const all = [...new Set([...accepts.map((a) => a.payTo), ...known])];
  const lookalikes: CheckRecord["lookalikes"] = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (resembles(all[i], all[j])) lookalikes.push({ a: all[i], b: all[j], note: "resembles (same first and last characters)" });
  return {
    checked_at,
    target,
    reachable: r.ok,
    http_status: r.ok ? r.status : null,
    accepts,
    listing: { well_known_present: wellKnown, target_listed: listed },
    payto_consistency: { evm_payTos: evm, consistent_across_evm: evm.length ? evm.length === 1 : null },
    screens,
    lookalikes,
  };
}

export type WatchEvent = { kind: "target_unreachable" | "payto_changed" | "price_changed" | "delisted" | "new_screen_hit" | "lookalike"; detail: string };
export function diffEvents(base: CheckRecord, cur: CheckRecord): WatchEvent[] {
  const ev: WatchEvent[] = [];
  if (!cur.reachable || cur.http_status !== 402) ev.push({ kind: "target_unreachable", detail: `HTTP ${cur.http_status ?? "no answer"}` });
  const key = (a: Accept) => a.network;
  const bm = new Map(base.accepts.map((a) => [key(a), a]));
  for (const a of cur.accepts) {
    const b = bm.get(key(a));
    if (!b) continue;
    if (b.payTo.toLowerCase() !== a.payTo.toLowerCase()) ev.push({ kind: "payto_changed", detail: `${a.network}: ${b.payTo} -> ${a.payTo}` });
    if (b.amount !== a.amount) ev.push({ kind: "price_changed", detail: `${a.network}: ${b.amount} -> ${a.amount}` });
  }
  if (base.listing.target_listed === true && cur.listing.target_listed === false) ev.push({ kind: "delisted", detail: "target no longer in /.well-known/x402" });
  const hits = (r: CheckRecord) => new Set(r.screens.filter((s) => s.result === "appears").map((s) => `${s.list}:${s.payTo.toLowerCase()}`));
  const bh = hits(base);
  for (const h of hits(cur)) if (!bh.has(h)) ev.push({ kind: "new_screen_hit", detail: h });
  if (cur.lookalikes.length > base.lookalikes.length) ev.push({ kind: "lookalike", detail: "new resembling payTo seen" });
  return ev;
}

export type DayState = { n: number; status: "pending" | "due" | "closed" };
/** Window state of day n at time now. */
export function dayWindow(t0: number, n: number, now: number): DayState["status"] {
  const start = t0 + n * DAY_MS;
  if (now < start) return "pending";
  if (now < start + DAY_MS) return "due";
  return "closed";
}

/** Approved watch refund (atomic USDC). stop: null | "ours" | "abuse"; notRun = days never run after an early stop. */
export function watchRefundAtomic(amount: string, missed: number, notRun: number, stop: null | "ours" | "abuse"): string {
  if (stop === "abuse") return "0";
  const undelivered = missed + notRun;
  if (!(missed >= 3 || stop === "ours") || undelivered <= 0) return "0";
  return ((BigInt(amount) * BigInt(Math.min(WATCH_DAYS, undelivered))) / BigInt(WATCH_DAYS)).toString();
}
