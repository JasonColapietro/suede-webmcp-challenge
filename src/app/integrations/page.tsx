/**
 * Public integrations page: which agent-commerce protocols the studio speaks,
 * what is implemented today, and the dated receipt that proves each one.
 * Renders entirely from the client-safe registries in src/lib/distribution,
 * so the page can never drift from the code.
 */
import type { Metadata } from "next";
import { withDefaultSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { PROTOCOL_PROVIDERS } from "@/lib/distribution/providers";
import { DISCOVERY_VENUES } from "@/lib/distribution/venues";
import "../chrome.css";
import "../site.css";
import "./integrations.css";

export const metadata: Metadata = withDefaultSocialImages({
  title: { absolute: "Agent Protocol Integrations | Suede Agent Studio" },
  description:
    "See how Suede Agent Studio implements x402, AP2, A2A, MCP, WebMCP, and AgentCash discovery, with dated receipts and live verification paths.",
  alternates: { canonical: "/integrations" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/integrations",
    siteName: "Suede Agent Studio",
    title: "Agent Protocol Integrations | Suede Agent Studio",
    description:
      "x402 v2, AP2 v0.2, A2A, MCP, WebMCP, and AgentCash discovery, implemented in production with dated receipts and live verification paths.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Protocol Integrations | Suede Agent Studio",
    description:
      "x402 v2, AP2 v0.2, A2A, MCP, WebMCP, and AgentCash discovery, implemented in production with dated receipts and live verification paths.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
});

const ACCENTS = ["var(--primary)", "var(--text-info)", "var(--text-success)"] as const;
const POST_ONLY_ENDPOINTS = new Set(["/api/mcp"]);

function isExternal(url: string): boolean {
  return url.startsWith("http");
}

export default function IntegrationsPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">Integrations</span>
          <h1>Every agent rail, implemented and inspectable.</h1>
          <p>
            Agents that buy from other agents need shared protocols for
            discovery, contracts, and payment. Suede Agent Studio implements
            the current rails in production rather than announcing them: each
            integration below carries the date it shipped and a live path you
            can check right now.
          </p>
          <p className="it-plain">
            The same registry that renders this page is machine-readable at{" "}
            <a href="/api/providers">/api/providers</a>, so an agent can read
            what a human reads here.
          </p>
        </header>

        <section className="it-section" aria-label="Protocol integrations">
          <span className="lp-eyebrow">Protocols</span>
          <h2>What the studio speaks today.</h2>
          <div className="it-grid">
            {PROTOCOL_PROVIDERS.map((provider, index) => (
              <article
                key={provider.id}
                className="it-card"
                style={{ "--c": ACCENTS[index % ACCENTS.length] } as React.CSSProperties}
              >
                <span className="it-protocol">
                  {provider.protocol}
                  {provider.partner ? (
                    <span className="it-partner-badge">{provider.partner.label}</span>
                  ) : null}
                </span>
                <h3>{provider.steward}</h3>
                <p>{provider.implemented}</p>
                {provider.partner ? (
                  <p className="it-partner">{provider.partner.detail}</p>
                ) : null}
                {provider.endpoints.length > 0 ? (
                  <div
                    className="it-endpoints"
                    role="group"
                    aria-label={`Live ${provider.protocol} endpoints`}
                  >
                    {provider.endpoints.map((endpoint) =>
                      POST_ONLY_ENDPOINTS.has(endpoint) ? (
                        <code key={endpoint} className="it-endpoint">
                          POST {endpoint}
                        </code>
                      ) : (
                        <a key={endpoint} href={endpoint} className="it-endpoint">
                          {endpoint}
                        </a>
                      ),
                    )}
                  </div>
                ) : null}
                <p className="it-receipt">
                  Shipped {provider.receipt.date}. {provider.receipt.ref}.{" "}
                  <a
                    href={provider.receipt.verifyUrl}
                    aria-label={`Verify the ${provider.protocol} integration`}
                    {...(isExternal(provider.receipt.verifyUrl)
                      ? { rel: "noopener noreferrer", target: "_blank" }
                      : {})}
                  >
                    Verify
                  </a>
                </p>
              </article>
            ))}
          </div>
        </section>

        <section className="it-section" aria-label="Discovery venues">
          <span className="lp-eyebrow">Discovery venues</span>
          <h2>Where launched agents get listed.</h2>
          <p className="it-section-lede">
            Suede publishes its own manifests and agent cards; the services
            below are independent third-party venues. Their listing mechanics
            differ: some index automatically, some accept a GitHub submission,
            and some still need a human to send a draft.
          </p>
          <ul className="it-venues">
            {DISCOVERY_VENUES.map((venue) => (
              <li key={venue.id} className="it-venue">
                <a href={venue.url} rel="noopener noreferrer" target="_blank">
                  {venue.name}
                </a>
                <span className="it-venue-mechanism">{venue.mechanism}</span>
                <span className="it-venue-status">{venue.status}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="lp-cta-band">
          <span className="lp-eyebrow" style={{ color: "var(--primary)" }}>
            Build on the rails
          </span>
          <h2>Publish an agent that other agents can find and pay.</h2>
          <p className="it-cta-note">
            Every flow you launch inherits these integrations: discovery
            manifests, agent cards, MCP tools, and pay-per-call pricing, with
            settlement off until you turn it on.
          </p>
          <Link href="/start" className="lp-btn lp-btn--primary">
            Start building →
          </Link>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
