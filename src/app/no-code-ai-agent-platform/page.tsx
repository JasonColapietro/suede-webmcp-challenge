import type { Metadata } from "next";
import Link from "next/link";
import SiteFooter from "@/components/site/SiteFooter";
import SiteNav from "@/components/site/SiteNav";
import { OG_IMAGE, SITE_URL } from "@/lib/site";
import "../chrome.css";
import "../site.css";
import "./no-code.css";

const PAGE_URL = `${SITE_URL}/no-code-ai-agent-platform`;

export const metadata: Metadata = {
  title: { absolute: "No-Code AI Agent Platform | Suede Agent Studio" },
  description:
    "Build an AI agent on a visual canvas, dry-run it without a wallet, publish a stable endpoint, and keep Test, Live, and caller-payment approvals separate.",
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: PAGE_URL,
    siteName: "Suede Agent Studio",
    title: "No-Code AI Agent Platform | Suede Agent Studio",
    description:
      "Visual agent building with dry runs, immutable versions, human Live approval, publishing, and x402 pay-per-call settlement.",
    images: [{ url: OG_IMAGE }],
  },
  twitter: {
    card: "summary_large_image",
    title: "No-Code AI Agent Platform | Suede Agent Studio",
    description:
      "Build visually, dry-run without a wallet, and keep publishing, Live promotion, and payments under separate controls.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
    images: [OG_IMAGE],
  },
};

const PAGE_CAPS: { kicker: string; caps: readonly string[] } = {
  kicker: "Platform guide",
  caps: [
    "Build in Guided or Studio",
    "Dry-run with zero spend",
    "Promote Test, then Live",
    "Turn on settlement last",
    "See each control's limits",
  ],
};

const BUILD_PATH = [
  {
    number: "01",
    label: "Guided or Studio",
    state: "Draft",
    detail: "Describe the job or wire explicit nodes, ports, and edges on the canvas.",
  },
  {
    number: "02",
    label: "Dry run",
    state: "No spend",
    detail: "Exercise the flow while cost-bearing and side-effecting nodes stay stubbed.",
  },
  {
    number: "03",
    label: "Saved version",
    state: "Immutable",
    detail: "Freeze the exact graph and settings that will move through review.",
  },
  {
    number: "04",
    label: "Test",
    state: "Human choice",
    detail: "Promote a saved version into Test and inspect the version receipt.",
  },
  {
    number: "05",
    label: "Live",
    state: "Typed approval",
    detail: "Promote that same Test version by typing PROMOTE LIVE.",
  },
  {
    number: "06",
    label: "Published endpoint",
    state: "x402 when enabled",
    detail: "Accept paid calls only when Live and settlement gates are both ready.",
  },
] as const;

const CONTROL_ROWS = [
  {
    control: "Dry run",
    changes: "Runs the graph with safe stubs for cost-bearing and side-effecting nodes.",
    doesNot: "It does not call those live services, spend credits, or prove an integration works.",
  },
  {
    control: "Launch / publish",
    changes: "Validates the flow and publishes its stable public page and discovery record.",
    doesNot: "It does not promote a version to Live or enable paid settlement.",
  },
  {
    control: "Promote to Test",
    changes: "Selects an immutable saved version as the active Test version.",
    doesNot: "The Test receipt does not certify that a scoped test suite passed.",
  },
  {
    control: "Promote to Live",
    changes: "Moves that same active Test version to Live after typed confirmation.",
    doesNot: "It does not configure a payout address or switch settlement on by itself.",
  },
  {
    control: "Enable settlement",
    changes: "Allows a priced Live endpoint to verify and settle eligible caller payments.",
    doesNot: "It does not create traffic, demand, or a guarantee of earnings.",
  },
] as const;

const FAQS = [
  {
    question: "Is Suede Agent Studio really no-code?",
    answer:
      "Yes. Guided mode can turn a plain-language job into a draft flow, and Studio exposes the same flow as visual nodes, ports, and edges. Code is an optional setting, not a requirement for building or publishing an agent.",
  },
  {
    question: "Do I need a wallet to build or dry-run an agent?",
    answer:
      "No. You can start, edit, save, and dry-run a flow without connecting a wallet. A valid payout configuration is required before an operator can receive settled caller payments.",
  },
  {
    question: "Does publishing automatically turn on paid execution?",
    answer:
      "No. Publishing, promoting an immutable version through Test and Live, and enabling settlement are separate controls. Each boundary has to be satisfied before a priced public call can settle.",
  },
  {
    question: "How do caller payments work today?",
    answer:
      "A payment-enabled Live endpoint returns x402 payment terms. The caller authorizes USDC on Base and retries; the platform verifies and settles the payment before the flow runs. A response reports settled true only after real settlement succeeds.",
  },
  {
    question: "Does a Test promotion prove the flow passed its tests?",
    answer:
      "No. Test records which immutable version an operator selected and is a prerequisite for Live promotion. It is a version-control receipt, not proof that every node or external integration passed a scoped test.",
  },
] as const;

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": `${PAGE_URL}#webpage`,
      url: PAGE_URL,
      name: "No-Code AI Agent Platform",
      description:
        "A source-bounded guide to visual agent building, dry runs, publishing, human Live approval, and current pay-per-call settlement in Suede Agent Studio.",
      datePublished: "2026-07-31",
      dateModified: "2026-07-31",
      inLanguage: "en-US",
      about: { "@id": `${SITE_URL}/#app` },
      breadcrumb: { "@id": `${PAGE_URL}#breadcrumb` },
      mainEntity: { "@id": `${PAGE_URL}#faq` },
    },
    {
      "@type": "BreadcrumbList",
      "@id": `${PAGE_URL}#breadcrumb`,
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Suede Agent Studio",
          item: SITE_URL,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "No-Code AI Agent Platform",
          item: PAGE_URL,
        },
      ],
    },
    {
      "@type": "FAQPage",
      "@id": `${PAGE_URL}#faq`,
      mainEntity: FAQS.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: item.answer,
        },
      })),
    },
  ],
};

export default function NoCodeAIAgentPlatformPage(): React.JSX.Element {
  return (
    <div className="lp nc-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <SiteNav />
      <main id="main-content">
        <header className="lp-shell nc-hero">
          <div className="nc-hero__copy">
            <span className="lp-eyebrow">No-code agent platform · controlled publishing</span>
            <h1 className="nc-hero__title">Build a no-code AI agent that earns USDC per call.</h1>
            <p className="nc-hero__lede">
              Describe a job or wire it on a visual canvas, then publish it as a priced
              endpoint that earns USDC on every settled call. Dry runs need no wallet,
              and paid calls stay off until you deliberately promote an immutable
              version to Live and enable settlement.
            </p>
            <p className="nc-plain">
              A flow is a graph: each node does one job — fetch, reason, branch,
              send — and the edges pass data between them. Publishing turns that
              graph into one endpoint a person or another agent can call.
            </p>
            <div className="nc-caps" aria-label="What you can do from this page">
              <span className="nc-caps-kicker">{PAGE_CAPS.kicker}</span>
              {PAGE_CAPS.caps.map((cap) => (
                <span key={cap} className="lp-pill">
                  {cap}
                </span>
              ))}
            </div>
            <div className="nc-actions">
              <Link href="/start" className="lp-btn lp-btn--primary">
                Start with a job →
              </Link>
              <Link href="/docs/building-flows" className="lp-btn lp-btn--ghost">
                See how flows are built
              </Link>
            </div>
            <p className="nc-hero__note">
              You set the price, and the settled sale routes to your wallet. See{" "}
              <Link href="/pricing#split">how the split works</Link>. Launch, Live
              promotion, and settlement remain separate operator decisions.
            </p>
          </div>

          <aside className="nc-flight" aria-labelledby="approval-path-title">
            <div className="nc-flight__head">
              <span>Operator flight path</span>
              <strong id="approval-path-title">Six visible states</strong>
            </div>
            <ol className="nc-flight__list">
              {BUILD_PATH.map((step) => (
                <li key={step.number} className="nc-flight__step">
                  <span className="nc-flight__number">{step.number}</span>
                  <div>
                    <div className="nc-flight__label">
                      <strong>{step.label}</strong>
                      <span>{step.state}</span>
                    </div>
                    <p>{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </aside>
        </header>

        <section className="lp-shell nc-section" aria-labelledby="what-no-code-means">
          <div className="nc-section__intro">
            <span className="lp-eyebrow">What no-code means here</span>
            <h2 id="what-no-code-means">One flow, two visual ways in</h2>
            <p>
              Guided mode starts from the outcome you describe. Studio shows the graph
              you can inspect and change. Both produce an explicit flow rather than a
              hidden prompt chain.
            </p>
          </div>
          <div className="nc-modes">
            <article>
              <span>01 · Guided</span>
              <h3>Start with the job</h3>
              <p>
                Describe the input, desired output, and constraints. Review the draft
                flow before anything can leave Draft.
              </p>
            </article>
            <article>
              <span>02 · Studio</span>
              <h3>See the topology</h3>
              <p>
                Inspect nodes, typed parameters, input and output ports, explicit edges,
                run state, and per-node cost estimates on the canvas.
              </p>
            </article>
            <article>
              <span>03 · Code setting</span>
              <h3>Optional, not required</h3>
              <p>
                Use the code-oriented setting when you want it. The visual builder,
                version review, publishing, and run controls do not depend on it.
              </p>
            </article>
          </div>
        </section>

        <section className="lp-shell nc-section" aria-labelledby="separate-controls">
          <div className="nc-section__intro nc-section__intro--wide">
            <span className="lp-eyebrow">Approval boundaries</span>
            <h2 id="separate-controls">These controls are separate on purpose</h2>
            <p>
              A green state in one column never silently advances the next. The operator
              can see what each action changes and what it leaves untouched.
            </p>
          </div>
          <div className="nc-table-wrap">
            <table className="nc-control-table">
              <thead>
                <tr>
                  <th scope="col">Control</th>
                  <th scope="col">What changes</th>
                  <th scope="col">What does not</th>
                </tr>
              </thead>
              <tbody>
                {CONTROL_ROWS.map((row) => (
                  <tr key={row.control}>
                    <th scope="row">{row.control}</th>
                    <td>{row.changes}</td>
                    <td>{row.doesNot}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="nc-confirmation">
            Live promotion requires the active Test version and the exact typed phrase{" "}
            <code>PROMOTE LIVE</code>.
          </p>
        </section>

        <section className="lp-shell nc-section nc-payment" aria-labelledby="payment-flow">
          <div className="nc-section__intro">
            <span className="lp-eyebrow">Current pay-per-call contract</span>
            <h2 id="payment-flow">A caller pays before a priced flow runs</h2>
            <p>
              The public execution route fails closed unless the agent, deployment,
              platform, settlement, and payout gates are ready. An explicit dry-run
              request still wins over paid execution.
            </p>
          </div>
          <ol className="nc-payment__steps">
            <li>
              <span>01</span>
              <div>
                <strong>Terms</strong>
                <p>A payment-enabled Live endpoint returns x402 payment terms to the caller.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>Authorization</strong>
                <p>The caller signs a USDC authorization on Base and retries the call.</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>Settlement</strong>
                <p>The platform verifies and settles the payment before running the flow.</p>
              </div>
            </li>
            <li>
              <span>04</span>
              <div>
                <strong>Result</strong>
                <p>The response reports settled true only after real settlement succeeds.</p>
              </div>
            </li>
          </ol>
          <div className="nc-rails" aria-label="Current commercial and discovery rails">
            <p><strong>x402</strong><span>Caller settlement</span></p>
            <p><strong>Stripe</strong><span>Builder gateway-credit top-ups</span></p>
            <p><strong>A2A</strong><span>Agent discovery</span></p>
          </div>
          <p className="nc-payment__link">
            Read the exact operational boundaries in the{" "}
            <Link href="/docs/payments">payments documentation</Link>.
          </p>
        </section>

        <section className="lp-shell nc-section" aria-labelledby="limitations">
          <div className="nc-section__intro">
            <span className="lp-eyebrow">Useful limits</span>
            <h2 id="limitations">What this page is not promising</h2>
          </div>
          <ul className="nc-limits">
            <li>
              <strong>Dry run is not a live integration test.</strong>
              <span>Cost-bearing and side-effecting nodes are intentionally stubbed.</span>
            </li>
            <li>
              <strong>Publishing does not create demand.</strong>
              <span>It creates a stable public and machine-readable place to evaluate the agent.</span>
            </li>
            <li>
              <strong>Some prototype nodes cannot be launched.</strong>
              <span>Connector Lab API Operation is simulation-only and blocked from Launch and Live.</span>
            </li>
            <li>
              <strong>x402 is the caller-payment rail today.</strong>
              <span>Stripe funds builder gateway credits; A2A describes discovery, not settlement.</span>
            </li>
          </ul>
        </section>

        <section className="lp-shell nc-section nc-next" aria-labelledby="choose-next-step">
          <div className="nc-section__intro">
            <span className="lp-eyebrow">Choose the next proof</span>
            <h2 id="choose-next-step">Build, verify, or compare</h2>
            <p>Follow the path that matches the decision you are making now.</p>
          </div>
          <div className="nc-next__links">
            <Link href="/start"><span>Build</span><strong>Start in Guided mode →</strong></Link>
            <Link href="/docs/building-flows"><span>Inspect</span><strong>Building flows →</strong></Link>
            <Link href="/docs/launching"><span>Control</span><strong>Launching and Live →</strong></Link>
            <Link href="/pricing"><span>Budget</span><strong>Read pricing →</strong></Link>
            <Link href="/rankings/best-ai-agent-builders"><span>Survey</span><strong>Builder rankings →</strong></Link>
            <Link href="/compare/gumloop-alternative"><span>Compare</span><strong>Suede vs. Gumloop →</strong></Link>
          </div>
        </section>

        <section className="lp-shell nc-section nc-faq" id="faq" aria-labelledby="faq-title">
          <div className="nc-section__intro">
            <span className="lp-eyebrow">FAQ</span>
            <h2 id="faq-title">Before you build</h2>
          </div>
          <div className="nc-faq__list">
            {FAQS.map((item) => (
              <details key={item.question}>
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
