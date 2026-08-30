/**
 * SEO acquisition page: Gumloop alternative comparison.
 * Targets searchers evaluating visual agent builders with monetization.
 * Competitive claims verified against public sources 2026-07-24; absence
 * claims are phrased as "not found as of" and never as proven absence.
 * Suede-side catalog numbers (node types, templates, company org charts)
 * are derived from the live catalogs at render time so they cannot go stale.
 */
import type { Metadata } from "next";
import Link from "next/link";
import SiteFooter from "@/components/site/SiteFooter";
import SiteNav from "@/components/site/SiteNav";
import { NODE_META } from "@/lib/flow/node-meta";
import { OG_IMAGE, SITE_URL } from "@/lib/site";
import { buildTemplateCatalogStats } from "@/lib/template-summaries";
import "../../chrome.css";
import "../../site.css";
import "./compare.css";

const PAGE_URL = `${SITE_URL}/compare/gumloop-alternative`;

export const metadata: Metadata = {
  title: { absolute: "Gumloop Alternative | Suede Agent Studio" },
  description:
    "A Gumloop alternative for agents that can earn: build on a visual canvas, run departments with budgets and approval gates, and payment-enable eligible published agents.",
  alternates: { canonical: PAGE_URL },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: PAGE_URL,
    siteName: "Suede Agent Studio",
    title: "Gumloop Alternative | Suede Agent Studio",
    description:
      "A Gumloop alternative for agents that can earn: build on a visual canvas, run departments with budgets and approval gates, and payment-enable eligible published agents.",
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "Suede Agent Studio: Gumloop Alternative",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Gumloop Alternative | Suede Agent Studio",
    description:
      "A Gumloop alternative for agents that can earn: build on a visual canvas, run departments with budgets and approval gates, and payment-enable eligible published agents.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
    images: [OG_IMAGE],
  },
};

const PAGE_CAPS: { kicker: string; caps: readonly string[] } = {
  kicker: "Sourced comparison",
  caps: [
    "Feature-by-feature table",
    "Suede vs Gumloop vs Make",
    "Two verified differences",
    "Live proof links",
    "Switching FAQ",
  ],
};

type Verdict = "yes" | "no" | "partial";

interface ComparisonCell {
  readonly val: string;
  readonly note: string;
  readonly verdict: Verdict;
}

interface ComparisonRow {
  readonly feature: string;
  readonly suede: ComparisonCell;
  readonly gumloop: ComparisonCell;
  readonly make: ComparisonCell;
}

function buildComparison(
  nodeTypeCount: number,
  templateCount: number,
  companyCount: number,
): readonly ComparisonRow[] {
  return [
    {
      feature: "Org-chart operating model",
      suede: {
        val: "Native",
        note: "Editable org chart: each seat carries its own flow, budget, and approval gates",
        verdict: "yes",
      },
      gumloop: {
        val: "Not found",
        note: "Multi-agent runs as Agent nodes on workflow canvases; no org-chart surface found as of July 2026",
        verdict: "no",
      },
      make: {
        val: "Partial",
        note: "Grid auto-maps scenarios and agents. A dependency view, not an editable operating chart",
        verdict: "partial",
      },
    },
    {
      feature: "Sell your agent per call",
      suede: {
        val: "Native",
        note: "Eligible published agents can be payment-enabled; settled x402 v2 calls route to the configured payout wallet",
        verdict: "yes",
      },
      gumloop: {
        val: "Not found",
        note: "Creator program offers distribution; no native per-call seller payout found as of July 2026",
        verdict: "no",
      },
      make: {
        val: "Not found",
        note: "Agent library deploys free agents; no per-call seller monetization found as of July 2026",
        verdict: "no",
      },
    },
    {
      feature: "Agent marketplace",
      suede: {
        val: "Live",
        note: "Publish and list in minutes with machine-readable discovery",
        verdict: "yes",
      },
      gumloop: {
        val: "Partial",
        note: "Template gallery and creator/affiliate program: distribution without per-call settlement",
        verdict: "partial",
      },
      make: {
        val: "Partial",
        note: "Library of free deployable agents and blueprints, not a paid seller marketplace",
        verdict: "partial",
      },
    },
    {
      feature: "No-code builder",
      suede: {
        val: "Yes",
        note: `Visual node canvas with ${nodeTypeCount} node types across LLM reasoning, branching, scheduling, and payments`,
        verdict: "yes",
      },
      gumloop: {
        val: "Yes",
        note: "Polished drag-and-drop plus natural-language workflow generation",
        verdict: "yes",
      },
      make: {
        val: "Yes",
        note: "Mature scenario builder with in-canvas AI agent reasoning",
        verdict: "yes",
      },
    },
    {
      feature: "Ready-made templates",
      suede: {
        val: "Yes",
        note: `${templateCount} agent templates plus ${companyCount} company org charts that staff whole departments`,
        verdict: "yes",
      },
      gumloop: {
        val: "Yes",
        note: "Template gallery distributed through the creator program",
        verdict: "yes",
      },
      make: {
        val: "Yes",
        note: "Reusable blueprints and a library of free deployable agents",
        verdict: "yes",
      },
    },
    {
      feature: "Free to start",
      suede: {
        val: "Yes",
        note: "Dry-run mode: build, test, and publish before anything settles",
        verdict: "yes",
      },
      gumloop: { val: "Yes", note: "Free plan with starter credits", verdict: "yes" },
      make: {
        val: "Limited",
        note: "Free tier with a monthly operations cap",
        verdict: "partial",
      },
    },
    {
      feature: "API access",
      suede: {
        val: "Yes",
        note: "Every published agent is discoverable; call and payment availability are advertised separately",
        verdict: "yes",
      },
      gumloop: {
        val: "Yes",
        note: "Webhook, API, and SDK triggers plus MCP connectors",
        verdict: "yes",
      },
      make: { val: "Yes", note: "Full API + webhook support", verdict: "yes" },
    },
  ];
}

const FAQ = [
  {
    q: "What makes Suede Agent Studio different from Gumloop?",
    a: "Gumloop is a polished workflow automation builder where the builder pays for usage. Suede Agent Studio adds a company operating model on top of the canvas (departments, per-seat budgets, approval gates, and a CEO chat). Eligible published agents can then be separately payment-enabled for x402 v2 caller settlement in USDC on Base.",
  },
  {
    q: "Can agents built on Gumloop or Make charge callers per run?",
    a: "Not natively, as far as public documentation showed when we checked in July 2026. Gumloop's creator program distributes templates without per-call settlement, and Make's agent library deploys free agents. Builders on either platform assemble payment plumbing by hand today; on Suede Agent Studio payment enablement is a separate opt-in after publish.",
  },
  {
    q: "Do I need a crypto wallet to try Suede Agent Studio?",
    a: "No. Dry-run mode lets you build, test, and publish agents without connecting a wallet. Going Live alone does not move money; eligible agents can enable payments separately when they are ready to charge callers.",
  },
] as const;

const PROOF_LINKS = [
  { href: "/agents", tag: "Inspect", label: "Browse agents and payment state →" },
  { href: "/docs/architecture", tag: "Verify", label: "Read the architecture →" },
  { href: "/docs/nodes", tag: "Count", label: "See every node type →" },
  { href: "/templates", tag: "Start", label: "Open the template catalog →" },
  { href: "/pricing", tag: "Budget", label: "Read the pricing model →" },
  {
    href: "/rankings/best-ai-agent-builders",
    tag: "Survey",
    label: "Rank all eight builders →",
  },
] as const;

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": `${PAGE_URL}#webpage`,
      url: PAGE_URL,
      name: "Gumloop Alternative",
      description:
        "A verified feature-by-feature comparison of Suede Agent Studio, Gumloop, and Make for builders who want their agents to earn per call.",
      inLanguage: "en-US",
      breadcrumb: { "@id": `${PAGE_URL}#breadcrumb` },
      mainEntity: { "@id": `${PAGE_URL}#faq` },
    },
    {
      "@type": "BreadcrumbList",
      "@id": `${PAGE_URL}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Suede Agent Studio", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Gumloop Alternative", item: PAGE_URL },
      ],
    },
    {
      "@type": "FAQPage",
      "@id": `${PAGE_URL}#faq`,
      mainEntity: FAQ.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ],
};

function VerdictBadge({ cell }: { cell: ComparisonCell }): React.JSX.Element {
  const cls =
    cell.verdict === "yes"
      ? "cmp-badge cmp-badge--yes"
      : cell.verdict === "no"
        ? "cmp-badge cmp-badge--no"
        : "cmp-badge cmp-badge--partial";
  return <span className={cls}>{cell.val}</span>;
}

function Cell({ cell, us }: { cell: ComparisonCell; us?: boolean }): React.JSX.Element {
  return (
    <td className={us ? "cmp-cell--us" : undefined}>
      <div className="cmp-cell">
        <VerdictBadge cell={cell} />
        <p className="cmp-cell__note">{cell.note}</p>
      </div>
    </td>
  );
}

export default function GumloopAlternativePage(): React.JSX.Element {
  const stats = buildTemplateCatalogStats();
  const comparison = buildComparison(NODE_META.length, stats.total, stats.companyCount);

  return (
    <div className="lp cmp-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <SiteNav active="/compare/gumloop-alternative" />
      <main id="main-content">
        <header className="lp-shell cmp-hero">
          <div className="cmp-hero__copy">
            <span className="lp-eyebrow">Compare · Verified July 2026</span>
            <h1 className="cmp-hero__title">The Gumloop alternative for agents that can earn</h1>
            <p className="cmp-hero__lede">
              Gumloop automates your work. Suede Agent Studio runs it like a
              company. Build each agent on a visual canvas, organize them into
              departments with budgets and approval gates, and publish each with
              an explicit preview, payment-enabled, or unavailable state. Eligible
              agents can then be payment-enabled;
              settled x402 v2 calls route to the configured payout wallet.
            </p>
            <p className="cmp-hero__plain">
              New to visual builders? A flow is a graph: each node does one job —
              fetch, reason, branch, send — and the edges carry data between them.
              The finished graph becomes one endpoint you can price per call.
            </p>
            <div className="cmp-caps" aria-label="What this page covers">
              <span className="cmp-caps-kicker">{PAGE_CAPS.kicker}</span>
              {PAGE_CAPS.caps.map((cap) => (
                <span key={cap} className="lp-pill">
                  {cap}
                </span>
              ))}
            </div>
            <div className="cmp-actions">
              <Link href="/start" className="lp-btn lp-btn--primary">
                Build your first payment-enabled agent →
              </Link>
              <Link href="/agents" className="lp-btn lp-btn--ghost">
                See agents and payment state
              </Link>
            </div>
            <p className="cmp-hero__note">
              Every competitor claim below was checked against public
              documentation and first-party releases on July 24, 2026. Nothing
              here relies on a roadmap.
            </p>
          </div>

          <aside className="cmp-verdict" aria-labelledby="verdict-title">
            <div className="cmp-verdict__head">
              <span>The verdict, up front</span>
              <strong id="verdict-title">Two verified differences</strong>
            </div>
            <ul className="cmp-verdict__list">
              <li className="cmp-verdict__item">
                <span className="cmp-verdict__mark" aria-hidden="true">
                  01
                </span>
                <div>
                  <strong>Native creator payouts</strong>
                  <p>
                    Publish an eligible agent, enable payments, and settled calls
                    route to the configured payout wallet. We could not find a
                    native seller-payout rail on Gumloop or Make as of July 2026.
                  </p>
                </div>
              </li>
              <li className="cmp-verdict__item">
                <span className="cmp-verdict__mark" aria-hidden="true">
                  02
                </span>
                <div>
                  <strong>x402 v2 caller settlement in USDC</strong>
                  <p>
                    A payment-enabled endpoint returns payment terms, the caller
                    authorizes USDC on Base, and the platform settles before the
                    flow runs.
                  </p>
                </div>
              </li>
            </ul>
            <p className="cmp-verdict__foot">
              Both are inspectable live in the{" "}
              <Link href="/agents">agent directory</Link> and specified in the{" "}
              <Link href="/docs/architecture">architecture docs</Link>.
            </p>
          </aside>
        </header>

        <section className="lp-shell cmp-section" aria-labelledby="feature-table">
          <div className="cmp-section__intro">
            <span className="lp-eyebrow">Feature by feature</span>
            <h2 id="feature-table">Suede Agent Studio vs Gumloop vs Make</h2>
            <p>
              Same categories, same date, same sourcing standard for all three
              columns. Where a capability was not found in public sources, the
              table says exactly that.
            </p>
          </div>
          <div className="cmp-table-wrap">
            <table className="cmp-table">
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  <th scope="col" className="cmp-table__us">
                    Suede Agent Studio
                  </th>
                  <th scope="col">Gumloop</th>
                  <th scope="col">Make</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((row) => (
                  <tr key={row.feature}>
                    <th scope="row">{row.feature}</th>
                    <Cell cell={row.suede} us />
                    <Cell cell={row.gumloop} />
                    <Cell cell={row.make} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="cmp-table-note">
            Competitor capabilities checked against public documentation and
            first-party releases as of July 24, 2026. &ldquo;Not found&rdquo;
            means we could not locate the capability in public sources, not that
            it can never ship. The Suede column is inspectable live:{" "}
            <Link href="/agents">browse published agents and their explicit payment state</Link>.
          </p>
        </section>

        <section className="lp-shell cmp-section" aria-labelledby="key-differences">
          <div className="cmp-section__intro">
            <span className="lp-eyebrow">Why builders switch</span>
            <h2 id="key-differences">Three differences you can verify today</h2>
          </div>
          <div className="cmp-diffs">
            <article>
              <span style={{ color: "var(--text-success)" }}>01 · Earnings</span>
              <h3>Agents that pay you back</h3>
              <p>
                On every platform we checked in July 2026, billing points one
                way: the builder pays. Builders who want to charge for an
                agent&apos;s work assemble payment plumbing by hand today. On
                Suede Agent Studio it&apos;s a built-in opt-in after publish:
                eligible agents can enable payments, and settled x402 v2 calls
                route to the configured payout wallet. No invoices, no payment
                gateway to wire up, no subscription tiers to manage. <Link href="/pricing">See how pricing works</Link>.
              </p>
            </article>
            <article>
              <span style={{ color: "var(--text-info)" }}>02 · Structure</span>
              <h3>An org chart you operate, not a diagram you admire</h3>
              <p>
                Plenty of tools now render multi-agent workflows. Suede&apos;s
                org chart is the operating surface itself: departments you
                create, budgets and approval gates on each seat, a CEO chat that
                directs the whole company. Every seat opens into the canvas
                where its flow is built and priced, so structure, execution, and
                earnings live on one surface.{" "}
                <Link href="/templates">Start from a company template</Link>.
              </p>
            </article>
            <article>
              <span style={{ color: "var(--primary)" }}>03 · On-ramp</span>
              <h3>No wallet required to start</h3>
              <p>
                Start in dry-run mode. Build, test, and publish your agent
                without connecting a wallet. Going Live does not move money;
                eligible agents enable payments separately when they are ready
                to charge callers. The flow stays the same, with one visible
                price per call, itemized per node. <Link href="/docs/architecture">Read the architecture</Link>.
              </p>
            </article>
          </div>
        </section>

        <section className="lp-shell cmp-section cmp-proof" aria-labelledby="walk-the-proof">
          <div className="cmp-section__intro">
            <span className="lp-eyebrow">Walk the proof</span>
            <h2 id="walk-the-proof">Don&apos;t take the table&apos;s word for it</h2>
            <p>
              Every Suede claim on this page links to a live surface you can
              open right now.
            </p>
          </div>
          <div className="cmp-proof__links">
            {PROOF_LINKS.map((link) => (
              <Link key={link.href} href={link.href}>
                <span>{link.tag}</span>
                <strong>{link.label}</strong>
              </Link>
            ))}
          </div>
        </section>

        <section className="lp-shell cmp-section cmp-faq" aria-labelledby="faq-title">
          <div className="cmp-section__intro">
            <span className="lp-eyebrow">Common questions</span>
            <h2 id="faq-title">Before you switch</h2>
          </div>
          <div className="cmp-faq__list">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <div className="lp-shell">
          <section className="cmp-cta" aria-labelledby="cta-title">
            <span className="lp-eyebrow">Ready to switch?</span>
            <h2 id="cta-title">Build an agent. Enable payments when ready.</h2>
            <p>
              Connect your nodes and publish its current call state. If the
              agent is eligible, enable payments separately when it is ready to sell.
            </p>
            <Link href="/start" className="lp-btn lp-btn--primary">
              Start building →
            </Link>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
