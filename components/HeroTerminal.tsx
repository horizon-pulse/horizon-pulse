"use client";
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

export function HeroTerminal() {
  const [n, setN] = useState(LINES.length);
  const [chars, setChars] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    setN(0);
    setChars(0);
    let line = 0, ch = 0, alive = true;
    const tick = () => {
      if (!alive) return;
      const cur = LINES[line];
      if (!cur) {
        setTimeout(() => { line = 0; ch = 0; setN(0); setChars(0); tick(); }, 4500);
        return;
      }
      if (cur.c === "cmd" && ch < cur.t.length) {
        ch += 2; setChars(ch); setTimeout(tick, 22); return;
      }
      line += 1; ch = 0; setN(line); setChars(0);
      setTimeout(tick, cur.c === "cmd" ? 380 : 260);
    };
    const start = setTimeout(tick, 500);
    return () => { alive = false; clearTimeout(start); };
  }, []);
  return (
    <div className="hp-term" aria-label="Recorded x402 test call replay">
      <div className="hp-term-bar">
        <span className="hp-dot r" /><span className="hp-dot y" /><span className="hp-dot g" />
        <span className="hp-term-title">agent → horizonpulse.dev</span>
      </div>
      <pre className="hp-term-body">
        {LINES.slice(0, n).map((l, i) => (
          <div key={i} className={`hp-l ${l.c ?? ""}`}>{l.t}</div>
        ))}
        {n < LINES.length && LINES[n].c === "cmd" && (
          <div className="hp-l cmd">{LINES[n].t.slice(0, chars)}<span className="hp-caret">▍</span></div>
        )}
      </pre>
      <div className="hp-term-foot">
        Recorded test call, {R.recordedAtUtc.slice(0, 10)}, paid from our own test wallet (not a customer).{" "}
        <a href={`https://basescan.org/tx/${R.tx}`} target="_blank" rel="noreferrer">View tx {short(R.tx)}</a>
      </div>
    </div>
  );
}
