"use client";
import { useEffect, useState } from "react";
import { CopyBlock } from "@/components/CopyBlock";

type R = { route: string; priceUsd: string; input: string };
const BASE = "https://horizonpulse.dev";
const REFRESH: Record<string, string> = {
  screenshot: "Cached sample, refreshed at most every 10 minutes",
  pdf: "Cached sample, refreshed at most every 10 minutes",
  search: "Recorded sample, refreshed at most once a day",
};

function trim(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 160 ? v.slice(0, 160) + `… (${v.length} chars)` : v;
  if (Array.isArray(v)) return v.slice(0, 8).map((x) => trim(x, depth + 1)).concat(v.length > 8 ? [`… ${v.length - 8} more`] : []);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth + 1)]));
  return v;
}

export function TryPlayground({ routes }: { routes: R[] }) {
  const [sel, setSel] = useState(routes[0]?.route ?? "pulse");
  const [state, setState] = useState<{ loading: boolean; status?: number; at?: string; body?: string; err?: string }>({ loading: false });
  const cur = routes.find((r) => r.route === sel)!;

  useEffect(() => {
    const h = typeof window !== "undefined" ? window.location.hash.replace("#", "") : "";
    if (h && routes.some((r) => r.route === h)) setSel(h);
  }, [routes]);

  async function run(route: string) {
    setState({ loading: true });
    try {
      const res = await fetch(`/api/demo/${route}`);
      const json = await res.json();
      const sample = json.sample ?? json;
      const age = Number(res.headers.get("age") ?? 0);
      const served = res.headers.get("date") ? new Date(res.headers.get("date")!).getTime() : Date.now();
      const atIso = typeof sample?.asOf === "string" ? sample.asOf : new Date(served - age * 1000).toISOString();
      const at = new Date(atIso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      setState({ loading: false, status: json.sample_status ?? res.status, at, body: JSON.stringify(trim(sample), null, 2) });
    } catch (e) {
      setState({ loading: false, err: e instanceof Error ? e.message : "Request failed" });
    }
  }

  useEffect(() => {
    run(sel);
    if (typeof window !== "undefined") history.replaceState(null, "", `#${sel}`);
  }, [sel]);

  return (
    <div className="hp-try">
      <div className="hp-try-tabs" role="tablist">
        {routes.map((r) => (
          <button key={r.route} type="button" role="tab" aria-selected={r.route === sel} className={r.route === sel ? "on" : ""} onClick={() => setSel(r.route)}>
            /{r.route}
            <em>{r.priceUsd}</em>
          </button>
        ))}
      </div>
      <div className="hp-try-meta">
        <div><span>Sample input</span>{cur.input}</div>
        <div><span>Freshness</span>{REFRESH[cur.route] ?? "Cached sample, refreshed at most every 5 minutes"}. The paid route always runs live on your input.</div>
        <div><span>Paid route</span><code>/api/{cur.route}</code> at {cur.priceUsd} per call</div>
      </div>
      <div className="hp-code tall">
        <div className="hp-code-h">
          <span>
            {state.loading ? "Running the free sample…" : state.err ? "Request failed" : `Recorded sample · ${state.at} · HTTP ${state.status}`}
          </span>
          <span className="hp-try-acts">
            <button type="button" className="hp-code-copy" onClick={() => run(sel)} disabled={state.loading}>Reload</button>
            <a className="hp-code-copy" href={`/api/demo/${sel}`} target="_blank" rel="noreferrer">Raw JSON</a>
          </span>
        </div>
        <pre>{state.loading ? "…" : state.err ?? state.body}</pre>
      </div>
      <div className="hp-try-next">
        <CopyBlock title="Same thing from your terminal" code={`curl ${BASE}/api/demo/${sel}`} />
        <CopyBlock title="Paid call, your own input (returns 402 with the price)" code={`curl -i '${BASE}/api/${sel}'`} />
      </div>
      <p className="hp-try-foot">
        Ready to pay per call? <a href="/docs#quickstart">See the quickstart</a> for the x402 client that handles the 402 and retry for you.
      </p>
    </div>
  );
}
