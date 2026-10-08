import Link from "next/link";
import { DEFAULT_PAY_TO, GITHUB_REPO, CONTACT_EMAIL } from "@/lib/config";

const X_URL = "https://x.com/HorizonPulseAPI";

export function SiteFooter() {
  return (
      <footer className="hp-footer">
        <div className="hp-wrap">
          <div className="hp-foot-grid">
            <div>
              <h4>Horizon Pulse</h4>
              <p style={{ color: "var(--text-2)", margin: 0, maxWidth: 300 }}>Pay-per-call APIs for AI agents, settled in USDC on Base with x402.</p>
            </div>
            <div>
              <h4>Developers</h4>
              <Link href="/docs">API docs</Link>
              <Link href="/docs#quickstart">Quickstart</Link>
              <a href="/try">Free samples</a>
              <Link href="/agents">For agents: skill + MCP</Link>
              <h4 style={{ marginTop: 18 }}>For agents (raw)</h4>
              <a href="/skill.md">skill.md</a>
              <a href="/openapi.json">openapi.json</a>
              <a href="/llms.txt">llms.txt</a>
              <a href="/.well-known/x402">.well-known/x402</a>
            </div>
            <div>
              <h4>Project</h4>
              <a href={GITHUB_REPO} target="_blank" rel="noreferrer">Source on GitHub</a>
              <a href={X_URL} target="_blank" rel="noreferrer">@HorizonPulseAPI on X</a>
              <Link href="/status">Status</Link>
              <Link href="/listing-fix">Bazaar listing fix</Link>
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </div>
            <div>
              <h4>Network</h4>
              <a href="https://www.x402.org/" target="_blank" rel="noreferrer">x402 protocol</a>
              <a href="https://base.org" target="_blank" rel="noreferrer">Base</a>
              <a href={`https://basescan.org/address/${DEFAULT_PAY_TO}`} target="_blank" rel="noreferrer">payTo on Basescan</a>
            </div>
          </div>
          <p className="hp-fine">
            Unpaid requests to paid routes return HTTP 402 with <code>PAYMENT-REQUIRED</code> until a valid x402 v2 <code>PAYMENT-SIGNATURE</code> is sent. Only live routes are listed.
          </p>
        </div>
      </footer>
  );
}
