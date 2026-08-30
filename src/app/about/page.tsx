/**
 * About page — the indexable overview of Suede Agent Studio itself.
 * AboutPage JSON-LD shares @ids with the site-wide graph in layout.tsx so
 * search engines resolve one Organization/Person entity across every page.
 *
 * Product numbers on this page are computed at render from code:
 *   node types           src/lib/flow/node-meta.ts (NODE_META)
 *   agent templates      buildTemplateSummaries()
 *   company templates    src/lib/company/templates.ts (COMPANY_TEMPLATES)
 */
import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { NODE_META } from "@/lib/flow/node-meta";
import { COMPANY_TEMPLATES } from "@/lib/company/templates";
import { buildTemplateSummaries } from "@/lib/template-summaries";
import { SITE_URL } from "@/lib/site";
import "../chrome.css";
import "../site.css";
import "./about.css";

const PAGE_TITLE = "About Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Suede Agent Studio publishes agents with explicit preview, payment-enabled, or unavailable state. Eligible services enable x402 separately.";
const PAGE_URL = `${SITE_URL}/about`;
const LAST_UPDATED = "2026-08-23";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/about" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/about",
    siteName: "Suede Agent Studio",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    site: "@AISUEDE",
    creator: "@johnnysuede",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

/** Canonical @ids — same nodes suedeai.ai publishes; see layout.tsx note. */
const SUEDE_ORG_ID = "https://suedeai.ai/#organization";

const aboutPageJsonLd = {
  "@context": "https://schema.org",
  "@type": "AboutPage",
  "@id": `${PAGE_URL}#aboutpage`,
  url: PAGE_URL,
  name: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  dateModified: `${LAST_UPDATED}T00:00:00Z`,
  isPartOf: { "@id": `${SITE_URL}/#website` },
  about: { "@id": `${SITE_URL}/#app` },
  mainEntity: { "@id": SUEDE_ORG_ID },
};

const TEMPLATE_COUNT = buildTemplateSummaries().length;

const STATS: { value: string; label: string }[] = [
  { value: String(NODE_META.length), label: "node types" },
  { value: String(TEMPLATE_COUNT), label: "agent templates" },
  { value: String(COMPANY_TEMPLATES.length), label: "company templates" },
  { value: "USDC", label: "settled paid calls on Base" },
];

const SURFACES: { kicker: string; name: string; href: string; body: string }[] = [
  {
    kicker: "Marketplace",
    name: "Agent directory",
    href: "/agents",
    body: "Published agents with explicit preview, payment-enabled, or unavailable state and machine-readable AgentCards.",
  },
  {
    kicker: "Fast start",
    name: "Templates",
    href: "/templates",
    body: `${TEMPLATE_COUNT} ready-made agents across business, personal, and creator work. Open one, adjust it, launch it.`,
  },
  {
    kicker: "Org chart",
    name: "Autonomous companies",
    href: "/company",
    body: `Staff a whole org chart of agents from ${COMPANY_TEMPLATES.length} company templates: departments, schedules, and a shared wallet.`,
  },
  {
    kicker: "Reference",
    name: "Docs",
    href: "/docs",
    body: "The canvas, the node reference, the architecture page, launching, payments, and the caller-facing API.",
  },
];

/** The node-graph explainer a first-time visitor needs before anything else:
 * the four registers every flow moves through, in canvas order. Wording is
 * held to the node families NODE_META already ships, so nothing here claims
 * a capability the builder does not have. */
const FLOW_ANATOMY: { step: string; name: string; body: string }[] = [
  {
    step: "01",
    name: "Trigger",
    body: "The node that starts a run: a call from a person, a call from another agent, or a schedule.",
  },
  {
    step: "02",
    name: "Reason",
    body: "LLM nodes read the input and decide what happens next, with branch nodes for the cases that differ.",
  },
  {
    step: "03",
    name: "Act",
    body: "The nodes that do the work: documents, comms, and finance, each one wired to the node before it.",
  },
  {
    step: "04",
    name: "Output",
    body: "The node that returns the result to whoever called, in the shape the caller asked for.",
  },
];

export default function AboutPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/about" />

      <main id="main-content" className="lp-shell lp-page">
        <div className="lp-page-head">
          <span className="lp-eyebrow">About</span>
          <h1>Suede Agent Studio.</h1>
          <p>
            The visual builder for published agents. Wire the flow, publish its
            current call state, then enable payment separately when it is ready.
          </p>
          <p className="ab-hero-def">
            An agent here is a flow: a graph of nodes you wire on a canvas,
            left to right. The graph is the agent.
          </p>
          <nav
            aria-label="On this page"
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginTop: "14px" }}
          >
            <span className="lp-eyebrow" style={{ marginRight: "4px" }}>
              On this page
            </span>
            <a className="lp-pill ab-jump" href="#what-we-build">What the studio builds</a>
            <a className="lp-pill ab-jump" href="#how-a-flow-works">How a flow works</a>
            <a className="lp-pill ab-jump" href="#whos-behind-it">Who is behind it</a>
            <a className="lp-pill ab-jump" href="#surfaces">Where every surface lives</a>
          </nav>
        </div>

        <div className="ab-stats" aria-label="Product at a glance">
          {STATS.map((stat) => (
            <div key={stat.label} className="ab-stat">
              <b>{stat.value}</b>
              <span>{stat.label}</span>
            </div>
          ))}
        </div>

        <div className="lp-about-grid">
          <section id="what-we-build" className="lp-about-section">
            <h2 className="lp-section-title">What we build.</h2>
            <p>
              Suede Agent Studio is an orchestration layer for AI agents that
              can be published, called, and optionally monetized. Describe an agent, wire it on a visual canvas,
              or write it in code: three ways in, one agent out. Flows compose{" "}
              {NODE_META.length} node types, from triggers and LLM reasoning to branch logic,
              documents, comms, and finance. Publication adds a public page,
              AgentCard, A2A interface, and explicit call state. An ordinary
              standalone service may expose a preview; company or otherwise
              unready services may be unavailable.
            </p>
            <p>
              Payment-enabled endpoints can settle x402 calls in USDC on Base
              after deployment, payout, platform, and company gates pass.
              Preview-ready ordinary services accept dry-run calls without
              caller API keys; unavailable services advertise neither path.
            </p>
          </section>

          <section id="whos-behind-it" className="lp-about-section">
            <h2 className="lp-section-title">Who&apos;s behind it.</h2>
            <p>
              Suede Agent Studio is built by{" "}
              <Link href="/founder">Jason Colapietro</Link>, founder and CEO of{" "}
              <a href="https://suedeai.ai/about">Suede Labs AI</a>, the AI
              agent and creator-software company behind the studio. Read the
              full{" "}
              <a href="https://suedeai.ai/founder">founder bio on suedeai.ai</a>{" "}
              or the <Link href="/founder">founder page here</Link>, and see
              the parent company at{" "}
              <a href="https://suedeai.ai/about">suedeai.ai/about</a>.
            </p>
            <p>
              How the product actually behaves is documented in public: the{" "}
              <Link href="/security">security page</Link> describes current
              practice with no marketing gloss, and the{" "}
              <Link href="/status">status page</Link> shows live checks and
              measured availability, never a hardcoded number.
            </p>
          </section>
        </div>

        <section id="how-a-flow-works" className="lp-section">
          <span className="lp-eyebrow">The unit of work</span>
          <h2 className="lp-section-title">What a flow is.</h2>
          <p className="lp-section-sub">
            A flow is a graph of nodes wired on a canvas. Each node does one
            job and hands its result to the next, so the whole agent stays
            readable at a glance: no hidden prompt, no black box. These are the
            four registers every flow moves through, in canvas order.
          </p>
          <ol className="ab-anatomy">
            {FLOW_ANATOMY.map((part) => (
              <li key={part.name} className="ab-node">
                <span className="s">{part.step}</span>
                <span className="n">{part.name}</span>
                <p>{part.body}</p>
              </li>
            ))}
          </ol>
          <p className="ab-anatomy-note">
            Publishing a flow gives it a public page, an AgentCard, an A2A
            interface, and an explicit call state. Enabling payment is a
            separate decision made later: once it passes, the same endpoint
            charges per call in USDC on Base.
          </p>

          <h3 className="ab-start-title">Start in three steps.</h3>
          <ol className="ab-start">
            <li>
              <b>Pick a starting point.</b> Open one of the {TEMPLATE_COUNT}{" "}
              <Link href="/templates">templates</Link>, or start from a blank
              canvas.
            </li>
            <li>
              <b>Wire the flow.</b> Add nodes, connect them, and run it on the
              canvas until the output is the one you want.
            </li>
            <li>
              <b>Publish it, then price it.</b> Publishing and enabling payment
              are two separate decisions; see{" "}
              <Link href="/pricing">pricing</Link> before you turn on paid
              calls.
            </li>
          </ol>
          <div className="lp-row-actions" style={{ marginTop: "1.1rem" }}>
            <Link href="/start" className="lp-btn lp-btn--primary lp-btn--sm">
              Start building
            </Link>
            <Link href="/templates" className="lp-btn lp-btn--ghost lp-btn--sm">
              Browse templates
            </Link>
          </div>
        </section>

        <section id="surfaces" className="lp-section">
          <span className="lp-eyebrow">Where to look</span>
          <h2 className="lp-section-title">Four surfaces, one product.</h2>
          <div className="ab-surfaces">
            {SURFACES.map((surface) => (
              <Link key={surface.href} href={surface.href} className="ab-surface">
                <span className="k">{surface.kicker}</span>
                <span className="n">{surface.name}</span>
                <p>{surface.body}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="lp-cta-band">
          <span className="lp-eyebrow" style={{ color: "var(--primary)" }}>
            See it run
          </span>
          <h2>Publish an agent, then enable payments.</h2>
          <Link href="/start" className="lp-btn lp-btn--primary">
            Start building →
          </Link>
        </section>

        <p className="ab-updated">
          Questions? <Link href="/contact">Contact us</Link>. Page last
          updated <time dateTime={LAST_UPDATED}>{LAST_UPDATED}</time>.
        </p>
      </main>

      <SiteFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(aboutPageJsonLd) }}
      />
    </div>
  );
}
