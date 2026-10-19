import Link from "next/link";
import { GITHUB_REPO } from "@/lib/config";
import "@/app/landing.css";

export function SiteHeader() {
  return (
    <header className="hp-header">
      <div className="hp-wrap hp-header-in">
        <Link href="/" className="hp-brand">
          <span className="hp-mark" aria-hidden>
            {/* Brand kit v1 pulse glyph (svg/hp-pulse-glyph-*.svg), currentColor */}
            <svg viewBox="40 90 432 300" width="18" height="18"><polyline points="72,272 209.76,272 236,122 268.8,358 295.04,272 400,272" fill="none" stroke="currentColor" strokeWidth="26" strokeLinecap="round" strokeLinejoin="round" /><circle cx="440" cy="272" r="22" fill="currentColor" /></svg>
          </span>
          Horizon Pulse
        </Link>
        <nav className="hp-nav">
          <a href="/#catalog">Catalog</a>
          <a href="/#how">How it works</a>
          <a href="/#agents">For agents</a>
          <Link href="/agent-promotion">Agent promotion</Link>
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
