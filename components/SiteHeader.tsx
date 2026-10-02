import Link from "next/link";
import { GITHUB_REPO } from "@/lib/config";
import "@/app/landing.css";

export function SiteHeader() {
  return (
    <header className="hp-header">
      <div className="hp-wrap hp-header-in">
        <Link href="/" className="hp-brand">
          <span className="hp-mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M2 12h4l3-7 4 14 3-7h6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          Horizon Pulse
        </Link>
        <nav className="hp-nav">
          <a href="/#catalog">Catalog</a>
          <a href="/#how">How it works</a>
          <a href="/#agents">For agents</a>
          <Link href="/status">Status</Link>
          <Link href="/docs">Docs</Link>
        </nav>
        <div className="hp-header-cta">
          <a className="hp-btn ghost sm" href={GITHUB_REPO} target="_blank" rel="noreferrer">GitHub</a>
          <a className="hp-btn primary sm" href="/try">Try free</a>
        </div>
      </div>
    </header>
  );
}
