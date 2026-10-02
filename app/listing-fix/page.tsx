import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_EMAIL } from "@/lib/config";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = {
  title: "x402 Bazaar listing fix | Horizon Pulse",
  description:
    "Your x402 endpoint returns 402 but isn't in Coinbase's x402 Bazaar? Free diagnosis, then a $99 per host hands-on fix (intro rate).",
};

const box = {
  marginTop: 20,
  padding: 18,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.03)",
} as const;

export default function ListingFixPage() {
  return (
    <>
      <SiteHeader />
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 20px" }}>
        <p style={{ opacity: 0.7, letterSpacing: "0.08em", fontSize: 12 }}>LISTING FIX</p>
        <h1 style={{ fontSize: 28, margin: "8px 0 12px" }}>Missing from Coinbase&apos;s x402 Bazaar?</h1>
        <p style={{ opacity: 0.9 }}>
          Your endpoint returns a 402, but agents searching the CDP Bazaar can&apos;t find it. The usual
          blockers are small: a resource URL scheme, a metadata shape the validator rejects, or a settle
          path that never reaches the CDP Facilitator. We check from the outside and tell you which one it is.
        </p>

        <section style={box}>
          <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>1. Free diagnosis</h2>
          <p style={{ margin: 0, opacity: 0.9 }}>
            Send us your host. We run unpaid probes only: your 402, Coinbase&apos;s public x402 validator, and
            CDP&apos;s discovery and merchant lookups. You get the exact check that fails and why. No payment,
            no keys, nothing sent to your wallet.
          </p>
        </section>

        <section style={box}>
          <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>
            2. Hands-on fix: $99 per host <span style={{ fontSize: 13, opacity: 0.7 }}>(intro rate)</span>
          </h2>
          <ul style={{ margin: 0, paddingLeft: 18, opacity: 0.9, lineHeight: 1.6 }}>
            <li>The specific change for your stack, worked through with you until CDP&apos;s validator returns <code>valid: true</code>.</li>
            <li>Guidance on the CDP-facilitated verify or settle that triggers indexing (verify moves no funds).</li>
            <li>A recheck of discovery and the merchant lookup afterwards.</li>
            <li>You make the changes in your own code. We never ask for keys, deploy access, or wallet control.</li>
          </ul>
        </section>

        <section style={box}>
          <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>What we don&apos;t promise</h2>
          <p style={{ margin: 0, opacity: 0.9 }}>
            Indexing is done by Coinbase, not us, so we can&apos;t guarantee a listing or a timeline. We can
            get your endpoint passing the public checks Coinbase documents.
          </p>
          <p style={{ margin: "10px 0 0", opacity: 0.9 }}>
            Payment: [TBD] · Refunds: [TBD]
          </p>
        </section>

        <p style={{ marginTop: 28 }}>
          Start with the free diagnosis:{" "}
          <a href={`mailto:${CONTACT_EMAIL}?subject=Listing%20check`}>{CONTACT_EMAIL}</a>
        </p>
        <p style={{ opacity: 0.7, fontSize: 13 }}>
          Background: Coinbase&apos;s{" "}
          <a href="https://docs.cdp.coinbase.com/x402/support/troubleshooting#my-endpoint-is-missing-from-the-bazaar" target="_blank" rel="noreferrer">
            Bazaar troubleshooting guide
          </a>
          . Horizon Pulse&apos;s own routes are <Link href="/#catalog">here</Link>.
        </p>
      </main>
    </>
  );
}
