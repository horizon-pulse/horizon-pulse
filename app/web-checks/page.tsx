import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { CONTACT_EMAIL } from "@/lib/config";
import { auditHighTiersEnabled, darkEnabled } from "@/lib/dark-routes";
import { CHECK_USER_AGENT, DATA_USER_AGENT, optOutCount, REDIRECT_COPY } from "@/lib/dark-checks-shared";

// Read the flag per request: dark (404) exactly when the web readiness checks route is dark (Counsel C3).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Web readiness checks: what we request and how to opt out | Horizon Pulse",
  description: "What Horizon Pulse web readiness checks request from a site, how to recognise them, and how a domain owner can opt out.",
  alternates: { canonical: "/web-checks" },
  robots: { index: false },
};

export default function WebChecksPage() {
  if (!darkEnabled("audit")) notFound();
  const optOutTotal = optOutCount();
  // Certificate history (crt.sh) is only part of the checks when the high tiers are on (HP_AUDIT_HIGH_TIERS_ENABLED).
  const ctHistory = auditHighTiersEnabled();
  const dataSources = ctHistory ? "npm, PyPI, pypistats, OSV.dev, deps.dev, the CISA KEV feed, crt.sh" : "npm, PyPI, pypistats, OSV.dev, deps.dev, the CISA KEV feed";
  const mail = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Web checks opt-out")}`;
  return (
    <>
      <SiteHeader />
      <main>
        <section className="hp-section">
          <div className="hp-wrap">
            <h1>Web readiness checks</h1>
            <p>
              A Horizon Pulse customer asked for automated, point-in-time web readiness checks of a site. These checks look only at publicly
              observable information. They are not a security audit or a penetration test.
            </p>
            <h2>How to recognise the requests</h2>
            <p>
              Requests to the site carry the User-Agent <code>{CHECK_USER_AGENT}</code>. Requests to public data sources ({dataSources}) carry{" "}
              <code>{DATA_USER_AGENT}</code>.
            </p>
            <h2>What is requested from the submitted host</h2>
            <ul id="checks">
              <li>One GET of <code>https://host/</code> and one GET of <code>http://host/</code> (the http redirect is not followed).</li>
              <li>One GET of <code>/.well-known/security.txt</code>.</li>
              <li>One TLS handshake to port 443 to read the certificate.</li>
              <li>Public DNS lookups (A, AAAA, NS, MX, CAA, TXT, <code>_dmarc</code> and 9 common DKIM selector names).</li>
              {ctHistory ? <li>Certificate-transparency history for the name from crt.sh (a public log service, not the site itself).</li> : null}
            </ul>
            <p id="redirects">{REDIRECT_COPY}</p>
            <p>A single host is checked at most 3 times per minute across all of our servers.</p>
            <h2>Opt out</h2>
            <p id="opt-out">
              Domain owners can ask us not to check their domain by emailing <a href={mail}>{CONTACT_EMAIL}</a> with the domain name. A listed domain also covers its subdomains. The list is checked before any request
              is sent, including the DNS lookup, so an opted-out domain receives no traffic from these checks.
            </p>
            <p id="opt-out-count">Domains currently opted out: {optOutTotal}. The list itself is not published.</p>
            <form id="opt-out-check" action="/web-checks/opt-out" method="get">
              <label>
                Check one exact domain: <input name="domain" type="text" inputMode="url" maxLength={253} placeholder="example.com" required />
              </label>{" "}
              <button type="submit">Check</button>
            </form>
            <p>The lookup answers only yes or no for the one domain entered (no wildcards or partial matches) and is rate limited.</p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
