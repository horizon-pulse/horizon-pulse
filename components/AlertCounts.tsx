import type { AlertSummary, RailAlertSummary } from "@/lib/alert-persist";

/** Odin 9:09 / 9:16 AM AST 10/19: public, non-secret rail alert COUNTS on /status (today + last 7 days only). */
export function AlertCounts({ a }: { a: AlertSummary }) {
  const row = (name: string, r: RailAlertSummary | null) => (
    <tr key={name} data-hp-alert-rail={name}>
      <td className="r">{name}</td>
      <td className="p">{r ? r.today : "n/a"}</td>
      <td className="p">{r ? r.last7d : "n/a"}</td>
    </tr>
  );
  return (
    <section className="hp-section" id="alerts" data-hp-alerts={a.status}>
      <div className="hp-wrap">
        <div>
          <div className="hp-label">Rail alerts</div>
          <h2>
            Alert counts. <span>Counts only.</span>
          </h2>
        </div>
        <table className="hp-table">
          <thead>
            <tr>
              <th>Rail</th>
              <th className="p">Today (UTC)</th>
              <th className="p">Last 7 days</th>
            </tr>
          </thead>
          <tbody>{[row("XRPL", a.xrpl), row("Solana", a.solana)]}</tbody>
        </table>
        {a.status !== "ok" && <p className="hp-fine">Alert counts {a.status === "unavailable" ? "unavailable right now" : "not recorded on this deployment"}.</p>}
      </div>
    </section>
  );
}
