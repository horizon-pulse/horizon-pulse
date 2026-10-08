import type { Metadata } from "next";
import { BLOG_POSTS } from "@/lib/blog";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

const POST = BLOG_POSTS.find((p) => p.slug === "why-agent-discoverability-matters")!;
const TROUBLESHOOT = "https://docs.cdp.coinbase.com/x402/support/troubleshooting#my-endpoint-is-missing-from-the-bazaar";
const GET_DISCOVERED = "https://docs.cdp.coinbase.com/x402/seller/get-discovered";
const CBI_PAPER = "https://www.coinbase.com/public-policy/advocacy/documents/machine-to-machine-payments-in-the-aifi-era";

export const metadata: Metadata = {
  title: `${POST.title} | Horizon Pulse`,
  description: POST.description,
  openGraph: { title: POST.title, description: POST.description, type: "article", publishedTime: POST.published },
};

export default function WhyAgentDiscoverabilityMattersPage() {
  return (
    <div className="hp">
      <SiteHeader />
      <main>
        <article className="hp-prose">
          <div className="hp-label"><a href="/blog" style={{ textDecoration: "none", color: "inherit" }}>Blog</a></div>
          <h1>{POST.title}</h1>
          <p className="hp-meta">
            Published <time dateTime={POST.published}>{POST.published}</time>
          </p>

          <p>
            A paid API that no agent can find earns nothing. That sounds obvious, but it&apos;s one of the most common gaps in x402: the
            route works, it returns <code>402 Payment Required</code>, a payment even settles, and the API still doesn&apos;t show up
            where agents look.
          </p>
          <p>
            Coinbase Institute&apos;s October 2026 paper,{" "}
            <a href={CBI_PAPER} target="_blank" rel="noopener">Machine-to-machine payments in the AiFi era</a>, opens its case with a
            simple line: &ldquo;The internet now has a second customer.&rdquo; That customer is software, and it can only pay for what it
            can find. (Quoted for context only. This is not an endorsement of Horizon Pulse by Coinbase.)
          </p>

          <h2>How agents find tools today</h2>
          <p>Agents rarely browse. They search catalogs and read machine-readable descriptions. Four surfaces do most of the work:</p>
          <ul>
            <li>
              <strong>Coinbase&apos;s x402 Bazaar.</strong> The CDP catalog of x402 resources. Per Coinbase&apos;s docs, agents reach it
              through CDP APIs and the Bazaar MCP server, and people browse it on agentic.market. A route appears there only after the
              facilitator has seen a paid call (more below).
            </li>
            <li>
              <strong>MCP registries and directories.</strong> For agents that work through the Model Context Protocol, a registry entry
              is how an MCP server gets found. Many of these need the server owner to submit from their own account.
            </li>
            <li>
              <strong>llms.txt and skill.md.</strong> Plain-text files at a known path that tell a language model what your service
              does, which endpoints matter, and when to use them. An agent can read them in one fetch.
            </li>
            <li>
              <strong>OpenAPI.</strong> The schema an agent uses to build a valid request. Coinbase&apos;s docs are direct about why this
              matters: without input schemas and examples, &quot;agents can discover your endpoint but can&apos;t construct a valid
              call.&quot;
            </li>
          </ul>
          <p>
            Discovery and usability are two separate problems. A catalog entry gets an agent to your door. Your description and schemas
            decide whether it can call you correctly the first time.
          </p>

          <h2>Why a paid route stays invisible</h2>
          <p>
            Coinbase documents the Bazaar&apos;s indexing requirements in its troubleshooting guide (
            <a href={TROUBLESHOOT} target="_blank" rel="noreferrer">My endpoint is missing from the Bazaar</a>). An endpoint must:
          </p>
          <ol>
            <li>
              Be served over <strong>public HTTPS</strong>. Localhost, plain HTTP, and endpoints behind an authenticating proxy
              aren&apos;t indexed.
            </li>
            <li>
              Return <strong>valid Bazaar metadata on the 402</strong>.
            </li>
            <li>
              Have <strong>settled at least one payment through the CDP facilitator</strong>. On that settlement call, both{" "}
              <code>paymentPayload.extensions.bazaar</code> and <code>paymentPayload.resource</code> must be set.
            </li>
          </ol>
          <p>
            After that, indexing can take up to 15 minutes. The guide&apos;s first recommendation is to run CDP&apos;s validation
            endpoint, which names the missing requirement faster than a manual checklist.
          </p>
          <p>
            Missing one of these is common. As of 2026-10-01, 25 public GitHub issues in x402-foundation/x402 and coinbase/cdp-sdk
            describe a settled-but-not-indexed payment.
          </p>
          <p>
            Coinbase&apos;s <a href={GET_DISCOVERED} target="_blank" rel="noreferrer">Get discovered</a> guide adds three more things
            sellers miss:
          </p>
          <ul>
            <li>
              <strong>Listings expire.</strong> &quot;Resources that go 30 days without a settlement are removed from both the catalog
              and search results.&quot; A listing has to be maintained. It isn&apos;t a one-time task.
            </li>
            <li>
              <strong>Descriptions have a hard limit.</strong> Keep the route description to 500 characters or fewer. The CDP
              facilitator rejects verify and settle requests whose description is longer. Bare endpoint names and placeholder text score
              zero on metadata quality.
            </li>
            <li>
              <strong>Ranking is earned.</strong> Results are ordered by real usage and listing quality over a rolling 30-day window, and
              new endpoints rank conservatively. Resources on shared tunneling domains are weighted below those on dedicated domains.
            </li>
          </ul>
          <p>
            One more practical point: if your server validates input before the x402 middleware runs, the Bazaar&apos;s asynchronous
            check, which sends your example input or an empty body, may never reach the 402. Make sure it does.
          </p>

          <h2>What we learned listing our own routes</h2>
          <p>
            Horizon Pulse runs a live x402 v2 service on Base mainnet: USDC through Coinbase&apos;s CDP facilitator, with 13 paid
            routes. As of the CDP merchant lookup on 2026-10-08, 13 routes are listed in Coinbase&apos;s x402 Bazaar. We&apos;re also
            listed on x402scan, and our <code>/.well-known/x402</code> manifest is live. We share this as a delivery reference, not a
            revenue claim.
          </p>
          <p>What carried over into how we deliver for others:</p>
          <ul>
            <li>
              <strong>Metadata goes in the 402 itself.</strong> Our 402 responses carry <code>serviceName</code>, tags and an icon URL,
              so a catalog has something to show beyond a URL. The Coinbase Institute paper makes the same general point about x402:
              &ldquo;The standard therefore needs to carry discovery metadata, including price and schema information, alongside the
              payment flow so an agent can locate a priced endpoint rather than merely pay one.&rdquo;
            </li>
            <li>
              <strong>The first settle is the trigger, so plan for it.</strong> One route in our own codebase was committed and listed
              the same afternoon, because we ran the paid test call that triggers indexing right after the commit.
            </li>
            <li>
              <strong>Verify on-chain, not just in logs.</strong> Our end-to-end paid settlements are verified on-chain, which rules out
              a payment problem when a route is missing.
            </li>
            <li>
              <strong>Don&apos;t charge for broken data.</strong> If an upstream price feed is down, our gas, portfolio and signals
              routes return 503 with <code>charged:false</code> and settlement is skipped, so an agent never pays for a failed answer.
            </li>
            <li>
              <strong>Cover more than one surface.</strong> The same service also exposes its tools over MCP at <code>/mcp</code>.
              Agents that never touch a catalog can still find you through the files and registries they do read.
            </li>
          </ul>

          <h2>Where we can help</h2>
          <p>
            If you&apos;d like this done for your API, our new <strong>Agent promotion</strong> service covers listing work for the Coinbase
            x402 Bazaar, x402scan, MCP directories and agent catalogs. It also includes an agent-optimized description pack (llms.txt,
            skill.md, an OpenAPI summary, and a Bazaar description that fits Coinbase&apos;s 500-character limit) and a monthly
            agent-traffic report. Where a directory needs your own account, such as the MCP Registry or npm, we prepare a
            ready-to-submit pack and you submit it. We can&apos;t promise placement, ranking or traffic. Directories make their own
            decisions. Details are at <a href="/agent-promotion">horizonpulse.dev/agent-promotion</a>. If you only need to know why an
            existing route isn&apos;t listed, our <a href="/listing-fix">listing fix</a> starts with a written review.
          </p>
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}
