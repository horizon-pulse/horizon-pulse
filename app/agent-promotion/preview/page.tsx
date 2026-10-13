import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { PreviewForm } from "@/components/PreviewForm";
import { PREVIEW_COPY as C } from "@/lib/preview/copy";
import { DISCLAIMERS } from "@/lib/preview/labels";

export const metadata: Metadata = {
  title: "x402 preview (draft) | Horizon Pulse",
  description: C.sub,
  robots: { index: false, follow: false }, // draft: not public until wording is approved
};

export default function PreviewPage() {
  return (
    <div className="hp">
      <SiteHeader />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">{C.chip}</span>
            <h1>{C.h1}</h1>
            <p className="hp-sub">{C.sub}</p>
          </div>
        </section>
        <section className="hp-section" style={{ paddingTop: 40 }}>
          <div className="hp-wrap">
            <div className="hp-grid two">
              <div className="hp-tile">
                <h3>Request</h3>
                <PreviewForm />
              </div>
              <div className="hp-tile">
                <h3>What you get</h3>
                <ul>{C.what.map((w) => <li key={w}>{w}</li>)}</ul>
                <p style={{ fontSize: 13 }}>{C.limits}</p>
                <ul style={{ fontSize: 12 }}>{DISCLAIMERS.map((d) => <li key={d}>{d}</li>)}</ul>
              </div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
