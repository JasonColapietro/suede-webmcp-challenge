/**
 * SEO acquisition page: AI agent marketplace with built-in payments.
 * Targets searchers looking to publish and monetize AI agents.
 * The node count renders from NODE_META so it can never go stale.
 */
import type { Metadata } from "next";
import { withDefaultSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { NODE_META } from "@/lib/flow/node-meta";
import "../chrome.css";
import "../site.css";
import "./marketplace.css";

export const metadata: Metadata = withDefaultSocialImages({
  title: { absolute: "AI Agent Marketplace with Built-in Payments | Suede Agent Studio" },
  description:
    "Publish an AI agent, set a USDC price, and enable x402 v2 settlement on Base after the Live payment and payout readiness gates pass.",
  alternates: { canonical: "/ai-agent-marketplace-payments" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/ai-agent-marketplace-payments",
    siteName: "Suede Agent Studio",
    title: "AI Agent Marketplace with Built-in Payments | Suede Agent Studio",
    description:
      "Publish an AI agent, set a USDC price, and enable x402 v2 settlement on Base after the Live payment and payout readiness gates pass.",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Agent Marketplace with Built-in Payments | Suede Agent Studio",
    description:
      "Publish an AI agent, set a USDC price, and enable x402 v2 settlement on Base after the Live payment and payout readiness gates pass.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
});

const PAGE_CAPS: { kicker: string; caps: readonly string[] } = {
  kicker: "Marketplace guide",
  caps: [
    "List your agent in the directory",
    "Set any USDC price per call",
    "Enable x402 v2 on Base",
    "Skip the payment gateway",
    "Check the payout split",
  ],
};

const STEPS: { n: string; color: string; title: string; detail: string }[] = [
  {
    n: "01",
    color: "var(--primary)",
    title: "Build",
    detail:
      `Use the visual canvas to wire together AI calls, HTTP requests, data transforms, and logic branches. ${NODE_META.length} node types across triggers, AI, logic, documents, data, comms, dev ops, and finance. No code required.`,
  },
  {
    n: "02",
    color: "var(--text-info)",
    title: "Price",
    detail:
      "Set a per-call rate in USDC, anything from $0.001 to $10 or more. You control the price and can update it anytime without taking your agent offline.",
  },
  {
    n: "03",
    color: "var(--primary)",
    title: "Publish",
    detail:
      "One click makes your agent live. It appears in the Suede Agent Studio directory and the machine-readable x402 index immediately, discoverable by humans and other AI agents.",
  },
  {
    n: "04",
    color: "var(--text-success)",
    title: "Earn",
    detail:
      "When settlement is enabled, a paid Live call runs only after its exact x402 authorization verifies and settles. The settled USDC routes to the configured payout wallet.",
  },
];

const SPECS: { label: string; value: string; color: string }[] = [
  { label: "Settlement layer", value: "Base (Ethereum L2)", color: "var(--text-success)" },
  { label: "Payment currency", value: "USDC (dollar-pegged)", color: "var(--text-success)" },
  { label: "Facilitation", value: "Configured x402 facilitators", color: "var(--text-info)" },
  { label: "Payment protocol", value: "x402 v2 · exact", color: "var(--primary)" },
  { label: "Seller setup", value: "Payout wallet + Live readiness", color: "var(--text-muted)" },
  { label: "Payout timing", value: "After verified settlement", color: "var(--text-muted)" },
];

const AUDIENCE: { title: string; body: string; color: string }[] = [
  {
    title: "Solo developers",
    body: "Build a specialized agent once and let it earn while you work on something else. Per-call revenue scales with usage, not with your time.",
    color: "var(--primary)",
  },
  {
    title: "No-code builders",
    body: "The visual canvas doesn't require programming. If you can describe what your agent should do, you can build and publish it.",
    color: "var(--text-info)",
  },
  {
    title: "AI consultants",
    body: "Turn client workflows into published, sellable agents. Deliver the build once; collect per-call revenue from every future use.",
    color: "var(--primary)",
  },
];

export default function AIAgentMarketplacePaymentsPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">Marketplace</span>
          <h1>Publish your agent. Set a price. Enable direct settlement.</h1>
          <p>
            Suede Agent Studio is the AI agent marketplace where payments are
            part of the protocol, not an afterthought. Build once, publish to a
            live directory, then connect a payout wallet and pass the payment
            readiness gates when you want priced Live calls to accept x402.
            See exactly how the payout split works on the{" "}
            <Link href="/pricing#split">pricing page</Link>.
          </p>
          <p className="mp-plain">
            An agent here is a flow you built on the canvas: nodes wired into a
            graph, published at one address. Callers hit that address, your flow
            runs, and the price you set is what a single run costs them.
          </p>
          <div className="mp-caps" aria-label="What you can do from this page">
            <span className="mp-caps-kicker">{PAGE_CAPS.kicker}</span>
            {PAGE_CAPS.caps.map((cap) => (
              <span key={cap} className="lp-pill">
                {cap}
              </span>
            ))}
          </div>
          <div className="lp-hero-actions">
            <Link href="/start" className="lp-btn lp-btn--primary">
              List your agent →
            </Link>
            <Link href="/pricing#split" className="lp-btn lp-btn--ghost">
              See the payout split →
            </Link>
          </div>
        </header>

        <section className="mp-steps" aria-label="How it works">
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="mp-step"
              style={{ "--c": s.color } as React.CSSProperties}
            >
              <span className="no">Step {s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.detail}</p>
            </div>
          ))}
        </section>

        <section className="mp-section mp-settlement">
          <div className="mp-settlement-copy">
            <span className="lp-eyebrow">Settlement infrastructure</span>
            <h2>Exact USDC on Base, with explicit activation.</h2>
            <p>
              Suede Agent Studio verifies the caller&apos;s signed x402 v2 Base
              USDC authorization and uses configured facilitators for
              settlement. The seller supplies the payout wallet; Suede does
              not create or custody it.
            </p>
            <p>
              Callers pay in USDC (a dollar-pegged stablecoin), so there&apos;s
              no volatile-token price exposure in the quoted amount. After a
              settlement succeeds, the call routes to the configured payout
              wallet and the run records the settlement evidence.
            </p>
          </div>
          <div className="mp-specs">
            {SPECS.map((row) => (
              <div key={row.label} className="mp-spec">
                <span className="k">{row.label}</span>
                <span className="v" style={{ color: row.color }}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
          <p className="mp-rails-note">
            x402 v2 is the only caller-payment settlement rail, and only
            payment-enabled Live services use it. Stripe card top-ups fund
            builder gateway credit; A2A is the discovery and invocation
            interface. Full detail in{" "}
            <Link href="/docs/payments">Payments</Link>.
          </p>
        </section>

        <section className="mp-section">
          <span className="lp-eyebrow">Who it&apos;s for</span>
          <h2>Builders who want their work to compound.</h2>
          <div className="mp-audience">
            {AUDIENCE.map((card) => (
              <div
                key={card.title}
                className="mp-card"
                style={{ "--c": card.color } as React.CSSProperties}
              >
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="lp-cta-band">
          <span className="lp-eyebrow" style={{ color: "var(--primary)" }}>
            List your agent
          </span>
          <h2>Your agent. Your price. Your earnings.</h2>
          <p className="mp-cta-note">
            Build in dry-run, test for free, publish when ready. No
            subscription required to list, and every settled call routes
            straight to your payout wallet.
          </p>
          <Link href="/start" className="lp-btn lp-btn--primary">
            List your agent →
          </Link>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
