import type { Metadata } from "next";
import Link from "next/link";
import { BLOG_POSTS } from "@/lib/blog";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "Blog | Horizon Pulse",
  description: "Notes on x402, agent discovery and pay-per-call APIs from the Horizon Pulse team.",
};

export default function BlogIndexPage() {
  return (
    <div className="hp">
      <SiteHeader />
      <main>
        <section className="hp-section" style={{ paddingTop: 72 }}>
          <div className="hp-wrap">
            <div className="hp-label">Blog</div>
            <h2>
              Notes on agent discovery <span>and x402.</span>
            </h2>
            <div className="hp-grid two" style={{ marginTop: 32 }}>
              {BLOG_POSTS.map((p) => (
                <Link className="hp-tile" key={p.slug} href={`/blog/${p.slug}`} style={{ textDecoration: "none" }}>
                  <span className="hp-step-n">Published {p.published}</span>
                  <h3>{p.title}</h3>
                  <p>{p.description}</p>
                  <div className="hp-tile-foot"><span /><span>Read →</span></div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
