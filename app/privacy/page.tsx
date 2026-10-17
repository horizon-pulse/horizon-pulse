import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { ROUTE_LOG_PRIVACY_LINE } from "@/lib/privacy-copy";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Privacy | Horizon Pulse",
  description: "What Horizon Pulse records for paid API calls and how long it is kept.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="hp-section">
          <div className="hp-wrap">
            <h1>Privacy</h1>
            <p id="route-log">{ROUTE_LOG_PRIVACY_LINE}</p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
