import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { DEMO_ROUTES } from "@/lib/demo-catalog";
import { TryPlayground } from "@/components/TryPlayground";

export const metadata: Metadata = {
  title: "Try it free · Horizon Pulse",
  description: "Run a free sample of any Horizon Pulse route on a fixed input before paying per call with x402.",
  alternates: { canonical: "/try" },
};

export default function TryPage() {
  const routes = DEMO_ROUTES.map((d) => ({ route: d.route, priceUsd: d.priceUsd, input: d.input }));
  return (
    <>
      <SiteHeader />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">Free samples · no wallet needed</span>
            <h1>
              See the output.
              <br />
              <span>Then pay per call.</span>
            </h1>
            <p className="hp-sub">
              Each free sample runs the route&apos;s own handler on a fixed input, cached for a few minutes (discourse/split shows an illustrative format sample, not measured output). The paid route takes your own input and costs a fraction of a
              cent to a few cents in USDC on Base, Solana or Polygon, or RLUSD on the XRP Ledger.
            </p>
          </div>
        </section>
        <section className="hp-section" id="samples" style={{ paddingTop: 0 }}>
          <div className="hp-wrap">
            <TryPlayground routes={routes} />
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
