import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { DEMO_ROUTES } from "@/lib/demo-catalog";
import { TryPlayground } from "@/components/TryPlayground";

export const metadata: Metadata = {
  title: "Try it free · Horizon Pulse",
  description: "Run a free sample of any Horizon Pulse route and see real output before paying per call with x402.",
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
              Each sample runs the real route on a fixed input, free. The paid route takes your own input and costs a fraction of a
              cent to a few cents in USDC on Base.
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
