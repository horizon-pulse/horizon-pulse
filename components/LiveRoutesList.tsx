import { LIVE_PAID_ROUTES } from "@/lib/live-catalog";

type Props = {
  /** When true, append " / call" after the price (status page style). */
  perCall?: boolean;
};

/** Renders only the six live paid routes — never invents or advertises 404s. */
export function LiveRoutesList({ perCall = false }: Props) {
  return (
    <ul style={{ paddingLeft: 18, marginBottom: 0 }}>
      {LIVE_PAID_ROUTES.map((r) => (
        <li key={r.path}>
          <code>
            {r.method} {r.path}
          </code>{" "}
          — {r.priceUsd} USDC ({r.priceAtomic} atomic)
          {perCall ? " / call" : ""} — {r.summary}
        </li>
      ))}
    </ul>
  );
}
