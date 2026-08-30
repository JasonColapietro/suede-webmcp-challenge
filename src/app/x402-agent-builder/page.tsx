/**
 * SEO acquisition page: x402 agent builder keyword target.
 * Explains the x402 protocol and how Suede Agent Studio wraps it in a no-code
 * builder. The /no-code-ai-agent-platform link is pinned by
 * tests/no-code-agent-platform-page.test.tsx; keep it.
 */
import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { NODE_META } from "@/lib/flow/node-meta";
import "../chrome.css";
import "../site.css";
import "./x402.css";

export const metadata: Metadata = {
  title: { absolute: "Build x402 Earning Agents | Suede Agent Studio" },
  description:
    "Build AI agents that can accept exact USDC per paid Live call through x402 v2 on Base when settlement is enabled. Dry-run stays free.",
  alternates: { canonical: "/x402-agent-builder" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/x402-agent-builder",
    siteName: "Suede Agent Studio",
    title: "Build x402 Earning Agents | Suede Agent Studio",
    description:
      "Build AI agents that can accept exact USDC per paid Live call through x402 v2 on Base when settlement is enabled. Dry-run stays free.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Build x402 Earning Agents | Suede Agent Studio",
    description:
      "Build AI agents that can accept exact USDC per paid Live call through x402 v2 on Base when settlement is enabled. Dry-run stays free.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

const PAGE_CAPS: { kicker: string; caps: readonly string[] } = {
  kicker: "Protocol guide + builder",
  caps: [
    "See how x402 settles a call",
    `Wire a flow from ${NODE_META.length} node types`,
    "Price each call in USDC",
    "Enable settlement for Live calls",
    "Dry-run free, no wallet",
  ],
};

const BENEFITS: { color: string; label: string; body: string }[] = [
  {
    color: "var(--text-success)",
    label: "Conditional settlement",
    body: "A payment-enabled Live call requires the exact x402 v2 terms it advertised. The caller retries with PAYMENT-SIGNATURE; only a verified and settled payment lets the flow run.",
  },
  {
    color: "var(--text-info)",
    label: "Verifiable x402 v2",
    body: "Suede verifies the signed Base USDC authorization and uses its configured facilitator for settlement. You provide the payout wallet; Suede never claims to create or custody it.",
  },
  {
    color: "var(--primary)",
    label: "Discoverable by other agents",
    body: "Every published agent is listed in the machine-readable x402 index at /.well-known/x402, with explicit payment readiness. Other agents can discover its AgentCard and A2A interface before calling it.",
  },
];

const STEPS: { step: string; lead: string; text: string }[] = [
  {
    step: "01",
    lead: "Open the canvas.",
    text: `Wire the flow from ${NODE_META.length} node types: triggers, LLM reasoning, HTTP fetches, data transforms, branch logic, documents, comms, and finance.`,
  },
  {
    step: "02",
    lead: "Wire them together.",
    text: "Set your agent's input schema and the output it returns.",
  },
  {
    step: "03",
    lead: "Set a price.",
    text: "Enter a USDC amount per call: fractions of a cent to dollars, your choice.",
  },
  {
    step: "04",
    lead: "Publish.",
    text: "Your agent gets a Live REST endpoint and appears in the x402 directory. Payment remains off until the required payout and settlement gates pass.",
  },
];

export default function X402AgentBuilderPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">x402 Protocol</span>
          <h1>Build agents that can earn on paid Live calls.</h1>
          <p>
            x402 is an open protocol for HTTP-native micropayments. Suede Agent
            Studio wraps it in a visual builder so any developer (or
            non-developer) can publish an agent that charges callers per run
            and settles exact USDC on Base when payment is enabled.
          </p>
          <p className="xb-plain">
            In plain terms: you wire a flow on a canvas — one node fetches, one
            reasons, one branches, one sends — and Suede publishes the finished
            graph as a single URL. x402 is the header that lets a caller pay for
            one run of it.
          </p>
          <div className="xb-caps" aria-label="What you can do from this page">
            <span className="xb-caps-kicker">{PAGE_CAPS.kicker}</span>
            {PAGE_CAPS.caps.map((cap) => (
              <span key={cap} className="lp-pill">
                {cap}
              </span>
            ))}
          </div>
          <div className="lp-hero-actions xb-hero-actions">
            <Link href="/start" className="lp-btn lp-btn--primary">
              Build your first earning agent →
            </Link>
            <Link href="/pricing" className="lp-btn lp-btn--ghost">
              See pricing →
            </Link>
          </div>
          <p className="xb-rails-note">
            x402 v2 is the only caller-payment settlement rail. It is active
            only for payment-enabled Live services; Stripe funds builder
            credit, while A2A is the discovery and invocation interface. See{" "}
            how those boundaries fit together in{" "}
            <Link href="/no-code-ai-agent-platform">
              the no-code platform guide
            </Link>
            ,{" "}
            <Link href="/ai-agent-marketplace-payments">
              the marketplace overview
            </Link>{" "}
            or{" "}
            <Link href="/docs/payments">the payments docs</Link>.
          </p>
        </header>

        <section className="xb-benefits" aria-label="Why x402">
          {BENEFITS.map((b) => (
            <div
              key={b.label}
              className="xb-benefit"
              style={{ "--c": b.color } as React.CSSProperties}
            >
              <span className="k">{b.label}</span>
              <p>{b.body}</p>
            </div>
          ))}
        </section>

        <section className="xb-section">
          <span className="lp-eyebrow">How the protocol works</span>
          <h2>One HTTP header. Verified settlement.</h2>

          <div className="xb-protocol">
            <div className="xb-protocol-copy">
              <p>
                The x402 standard adds a payment layer to standard HTTP. When a
                caller wants to run your agent, their client receives a{" "}
                <code>402 Payment Required</code> negotiation with the
                agent&apos;s payment terms, attaches a signed USDC
                authorization, and re-sends the request.
              </p>
              <p>
                The platform verifies and settles the payment before the flow
                runs, then your agent executes and returns the result. No
                webhook reconciliation, no refund logic, no invoice tracking.
              </p>
            </div>

            <div className="xb-exchange" role="img" aria-label="Example x402 request and response exchange">
              <div className="lbl">Caller request</div>
              <div>
                <span className="verb">POST</span>{" "}
                <span>/api/agents/my-agent/run</span>
              </div>
              <div className="ok" style={{ marginTop: "0.5rem" }}>
                PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6MiwiLi4uIjoiLi4uIn0=
              </div>
              <div className="dim">The signed payload echoes the live v2 quote.</div>
              <div className="lbl lbl--rule">Agent verifies → runs → responds</div>
              <div className="ok" style={{ marginTop: "0.5rem" }}>
                HTTP 200 OK
              </div>
              <div className="dim">{`{ "result": "...", "settled": true }`}</div>
            </div>
          </div>
        </section>

        <section className="xb-section">
          <span className="lp-eyebrow">Get started in minutes</span>
          <h2>Build without touching a wallet.</h2>
          <ol className="xb-steps">
            {STEPS.map((item) => (
              <li key={item.step} className="xb-step">
                <span className="no">{item.step}</span>
                <p>
                  <b>{item.lead}</b> {item.text}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section className="lp-cta-band">
          <span className="lp-eyebrow" style={{ color: "var(--primary)" }}>
            Start building
          </span>
          <h2>Your first x402 agent is free.</h2>
          <p className="xb-cta-note">
            Dry-run mode lets you build and test with no wallet required.
            Connect a payout wallet and pass the settlement readiness gates
            when you want a priced Live endpoint to accept payment.
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
