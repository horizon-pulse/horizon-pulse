import Link from "next/link";
import { GITHUB_REPO } from "@/lib/config";
import "@/app/landing.css";

export function SiteHeader() {
  return (
    <header className="hp-header">
      <div className="hp-wrap hp-header-in">
        <Link href="/" className="hp-brand">
          <span className="hp-mark" aria-hidden>
            <svg viewBox="0 0 32 32" width="22" height="22"><g fill="none" stroke="currentColor"><path d="M5.5 5V27M26.5 5V27" strokeWidth="2.4" /><path d="M6 16.5H13.5L15.2 7.5L17.4 22.5L18.6 16.5H26" strokeWidth="2" strokeLinejoin="round" /></g></svg>
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
