import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

export default function NotFound() {
  return (
    <div className="hp">
      <SiteHeader />
      <main>
        <section className="hp-hero">
          <div className="hp-wrap">
            <span className="hp-chip">404</span>
            <h1>
              Page not found.
              <br />
              <span>The routes are still here.</span>
            </h1>
            <p className="hp-sub">This URL doesn&apos;t exist on horizonpulse.dev. Paid routes live under <code>/api</code>, and every one has a free sample.</p>
            <div className="hp-ctas">
              <a className="hp-btn primary" href="/#catalog">See the catalog</a>
              <a className="hp-btn ghost" href="/status">Status</a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
