"use client";
import { CODE } from "@/lib/client-snippets";
import { useEffect, useState } from "react";
import { RECORDED_CALL as R } from "@/lib/recorded-call";

type Line = { t: string; c?: "cmd" | "err" | "key" | "dim" | "ok" | "out" };
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const LINES: Line[] = [
  { t: `$ curl -i ${R.url}`, c: "cmd" },
  { t: `HTTP/2 ${R.unpaidStatus} Payment Required`, c: "err" },
  { t: `payment-required: ${R.paymentRequiredHeaderPrefix}…`, c: "dim" },
  { t: `  scheme=${R.accepts.scheme}  network=${R.accepts.network}`, c: "key" },
  { t: `  amount=${R.accepts.amount} (USDC, 6 dp = $0.005)  payTo=${short(R.accepts.payTo)}`, c: "key" },
  { t: `$ agent: sign EIP-3009 transfer, retry with PAYMENT-SIGNATURE`, c: "cmd" },
  { t: `→ facilitator verify ✓  settle ✓  (${R.wallMs} ms)`, c: "ok" },
  { t: `HTTP/2 ${R.paidStatus} OK`, c: "ok" },
  { t: `{ "BTC": ${R.body.BTC}, "ETH": ${R.body.ETH}, "SOL": ${R.body.SOL}, … }`, c: "out" },
  { t: `tx ${short(R.tx)} on Base`, c: "dim" },
];



const TABS = [
  { id: "replay", label: "Recorded call" },
  { id: "curl", label: "curl" },
  { id: "node", label: "Node" },
  { id: "python", label: "Python" },
  { id: "mcp", label: "MCP" },
];

function Replay() {
  const [n, setN] = useState(LINES.length);
  const [chars, setChars] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    setN(0);
    setChars(0);
    let line = 0, ch = 0, alive = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (f: () => void, ms: number) => timers.push(setTimeout(f, ms));
    const tick = () => {
      if (!alive) return;
      const cur = LINES[line];
      if (!cur) {
        later(() => { line = 0; ch = 0; setN(0); setChars(0); tick(); }, 4500);
        return;
      }
      if (cur.c === "cmd" && ch < cur.t.length) {
        ch += 2; setChars(ch); later(tick, 22); return;
      }
      line += 1; ch = 0; setN(line); setChars(0);
      later(tick, cur.c === "cmd" ? 380 : 260);
    };
    later(tick, 500);
    return () => { alive = false; timers.forEach(clearTimeout); };
  }, []);
  return (
    <pre className="hp-term-body">
      {LINES.slice(0, n).map((l, i) => (
        <div key={i} className={`hp-l ${l.c ?? ""}`}>{l.t}</div>
      ))}
      {n < LINES.length && LINES[n].c === "cmd" && (
        <div className="hp-l cmd">{LINES[n].t.slice(0, chars)}<span className="hp-caret">▍</span></div>
      )}
    </pre>
  );
}

function Code({ code }: { code: string }) {
  return (
    <pre className="hp-term-body">
      {code.split("\n").map((l, i) => (
        <div key={i} className={/^\s*(#|\/\/)/.test(l) ? "hp-c" : "hp-l"}>{l || " "}</div>
      ))}
    </pre>
  );
}

export function HeroTerminal() {
  const [tab, setTab] = useState("replay");
  const title = tab === "replay" ? "agent → horizonpulse.dev" : CODE[tab].title;
  return (
    <div className="hp-frame" aria-label="Recorded x402 test call and integration snippets">
      <div className="hp-frame-bar">
        <span className="hp-dots" aria-hidden><i /><i /><i /></span>
        <div className="hp-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === tab} className={t.id === tab ? "on" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="hp-frame-title">{title}</span>
      </div>
      {tab === "replay" ? <Replay /> : <Code code={CODE[tab].code} />}
      <div className="hp-frame-foot">
        <span>Recorded test call, {R.recordedAtUtc.slice(0, 10)}, paid from our own test wallet (not a customer).</span>
        <a href={`https://basescan.org/tx/${R.tx}`} target="_blank" rel="noreferrer">View tx {short(R.tx)} ↗</a>
      </div>
    </div>
  );
}
