import type { AlertSummary, RailAlertSummary, XrplAlertKind } from "@/lib/alert-persist";

/** Sentinel 10/19: fixed labels for the allowlisted kinds; nothing else is ever rendered. */
const KIND_ROWS: readonly [XrplAlertKind, string][] = [
  ["xrpl_check_failing", "Check failing"],
  ["xrpl_entry_dropped", "Entry dropped"],
  ["other", "Other"],
];

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
        {a.xrplKinds && (
          <table className="hp-table" data-hp-xrpl-kinds="">
            <thead>
              <tr>
                <th>XRPL alert kind</th>
                <th className="p">Today (ET)</th>
                <th className="p">Last 24 h</th>
              </tr>
            </thead>
            <tbody>
              {KIND_ROWS.map(([k, label]) => (
                <tr key={k} data-hp-xrpl-kind={k.replace(/^xrpl_/, "")}>
                  <td className="r">{label}</td>
                  <td className="p">{a.xrplKinds!.todayEt[k]}</td>
                  <td className="p">{a.xrplKinds!.last24h[k]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {a.status !== "ok" && <p className="hp-fine">Alert counts {a.status === "unavailable" ? "unavailable right now" : "not recorded on this deployment"}.</p>}
      </div>
    </section>
  );
}
