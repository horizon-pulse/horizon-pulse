import Link from "next/link";
import { GITHUB_REPO } from "@/lib/config";
import "@/app/landing.css";

export function SiteHeader() {
  return (
    <header className="hp-header">
      <div className="hp-wrap hp-header-in">
        <Link href="/" className="hp-brand">
          <span className="hp-mark" aria-hidden>
            <svg viewBox="0 0 32 32" width="22" height="22"><g fill="none" stroke="currentColor"><path d="M7 4V28M25 4V28" strokeWidth="3" /><path d="M8.5 16.5H13.5L15.3 8L17.3 23L18.8 16.5H23.5" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" /></g></svg>
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
