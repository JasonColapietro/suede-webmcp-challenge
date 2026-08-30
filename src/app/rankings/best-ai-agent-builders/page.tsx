/**
 * SEO acquisition page: best AI agent builders 2026 ranked list.
 * Targets high-intent comparison searchers evaluating builder platforms.
 * Competitor claims verified against public sources 2026-07-24; absence
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
import "./rankings.css";

const PAGE_URL = `${SITE_URL}/rankings/best-ai-agent-builders`;

export const metadata: Metadata = {
  title: { absolute: "Best AI Agent Builders 2026 | Suede Agent Studio Rankings" },
  description:
    "The best AI agent builders in 2026, ranked: Suede Agent Studio, Gumloop, Lindy, Relevance AI, n8n, Make, Zapier, and StackAI compared by verified capabilities.",
  alternates: { canonical: PAGE_URL },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: PAGE_URL,
    siteName: "Suede Agent Studio",
    title: "Best AI Agent Builders 2026 | Suede Agent Studio Rankings",
    description:
      "The best AI agent builders in 2026, ranked: Suede Agent Studio, Gumloop, Lindy, Relevance AI, n8n, Make, Zapier, and StackAI compared by verified capabilities.",
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "Best AI Agent Builders 2026 | Suede Agent Studio Rankings",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Best AI Agent Builders 2026 | Suede Agent Studio Rankings",
    description:
      "The best AI agent builders in 2026, ranked: Suede Agent Studio, Gumloop, Lindy, Relevance AI, n8n, Make, Zapier, and StackAI compared by verified capabilities.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
    images: [OG_IMAGE],
  },
};

interface Builder {
  readonly rank: number;
  readonly name: string;
  readonly url: string;
  readonly tagline: string;
  readonly description: string;
  readonly strength: string;
  readonly weakness: string;
  readonly payPerCall: boolean;
  readonly highlight: boolean;
}

function buildRankings(
  nodeTypeCount: number,
  templateCount: number,
  companyCount: number,
  companySeats: number,
): readonly Builder[] {
  return [
    {
      rank: 1,
      name: "Suede Agent Studio",
      url: "https://agents.suedeai.ai",
      tagline: "The org chart that builds, runs, and can monetize",
      description:
        `The org chart is the product: build each seat's flow on a visual canvas with ${nodeTypeCount} node types, give departments budgets and approval gates, direct the whole company from CEO chat, and publish machine-readable preview, payment-enabled, or unavailable state. Ordinary standalone services may preview; company services require paid-call readiness. Start from ${templateCount} agent templates or ${companyCount} company org charts that staff ${companySeats} seats out of the box. Payment-enabled services expose x402 terms, and settled calls route USDC straight to the creator's wallet. We could not find that combination (an editable org-chart operating model plus native opt-in per-call selling) at any other platform ranked here as of July 2026.`,
      strength:
        "Structure, execution, and optional monetization on one surface: org-chart operating model + native payment-enabled x402",
      weakness: "Newer platform; smaller integration catalog than the incumbents",
      payPerCall: true,
      highlight: true,
    },
    {
      rank: 2,
      name: "Gumloop",
      url: "https://www.gumloop.com",
      tagline: "Clean no-code AI automation",
      description:
        "Polished visual builder used by teams at Shopify, Ramp, and Instacart. Natural-language workflow generation, self-cloning subagents with specialist routing, workflow checkpoints with rollback, and a deep enterprise governance stack.",
      strength:
        "Excellent drag-and-drop UX; natural-language flow generation; strong enterprise governance",
      weakness:
        "Billing points at the builder. No native way to charge callers per run or route earnings to the creator found as of July 2026",
      payPerCall: false,
      highlight: false,
    },
    {
      rank: 3,
      name: "Lindy",
      url: "https://www.lindy.ai",
      tagline: "AI agents for knowledge workers",
      description:
        "Natural-language agent builder selling a cross-department agent workforce, with agent-to-agent handoffs, task traces, test mode, and human approval steps. Strongest for email, calendar, and document workflows.",
      strength:
        "Easiest setup for non-technical users; deep Gmail/Calendar integrations; built-in approvals and task traces",
      weakness:
        "Built for running agents on your own work. No mechanism found to sell an agent's output per call as of July 2026",
      payPerCall: false,
      highlight: false,
    },
    {
      rank: 4,
      name: "Relevance AI",
      url: "https://relevanceai.com",
      tagline: "AI workforce canvas for enterprise",
      description:
        "The closest analog to a company-of-agents canvas: its Workforce view arranges multi-agent teams visually, and a marketplace lets builders sell agents and tools as one-time listings. Enterprise-grade credential isolation and human-in-the-loop approvals.",
      strength:
        "Visual multi-agent Workforce canvas; marketplace where builders sell agents as one-time listings",
      weakness:
        "Marketplace sales are one-time purchases. No usage-metered pay-per-call endpoint found as of July 2026",
      payPerCall: false,
      highlight: false,
    },
    {
      rank: 5,
      name: "n8n",
      url: "https://n8n.io",
      tagline: "Open-source workflow automation",
      description:
        "The developer favorite, now firmly in the multi-agent lane: documented supervisor trees, agent teams, human approval steps, evaluations, and MCP support, with 10k+ templates. Self-hostable with full code access.",
      strength:
        "Self-hostable; full code access; documented multi-agent orchestration patterns and a huge template library",
      weakness:
        "Charging callers for an agent's work is assembled by hand today via community add-ons. Nothing native found as of July 2026",
      payPerCall: false,
      highlight: false,
    },
    {
      rank: 6,
      name: "Make",
      url: "https://www.make.com",
      tagline: "Visual scenarios with AI agents",
      description:
        "Mature scenario builder with next-gen AI agents that reason in-canvas, an auto-generated Grid map of scenarios and agents, and a library of free deployable agents and reusable blueprints.",
      strength:
        "In-canvas agent reasoning; auto-generated dependency map; free agent library and blueprints",
      weakness:
        "Cloud-only; the agent library deploys free agents. No per-call seller monetization found as of July 2026",
      payPerCall: false,
      highlight: false,
    },
    {
      rank: 7,
      name: "Zapier",
      url: "https://zapier.com",
      tagline: "The original automation platform",
      description:
        "The incumbent, with the deepest app catalog of any platform here (thousands of apps and tens of thousands of actions) plus Agents, Pods for grouping them by function, and a Canvas for mapping agents, people, and workflows.",
      strength:
        "Deepest integration catalog; most tutorials and community support; visual grouping via Pods and Canvas",
      weakness:
        "Usage spreads across separate meters, and no operator-wallet pay-per-call mechanism found as of July 2026",
      payPerCall: false,
      highlight: false,
    },
    {
      rank: 8,
      name: "StackAI",
      url: "https://www.stack-ai.com",
      tagline: "Enterprise agents inside Asana",
      description:
        "Acquired by Asana in May 2026 and now sells human-agent teams with shared context, approvals, and handoffs inside the work-management suite, using manager-orchestrator and specialist sub-agent patterns.",
      strength: "Enterprise human-agent teaming with shared context inside an incumbent suite",
      weakness:
        "Free tier jumps straight to custom enterprise plans. No self-serve middle, and no endpoint monetization found as of July 2026",
      payPerCall: false,
      highlight: false,
    },
  ];
}

const METHOD = [
  {
    label: "Builder completeness",
    detail: "How much of a working agent the canvas, nodes, and templates cover.",
  },
  {
    label: "Operating model",
    detail: "Whether multiple agents run under visible structure, budgets, and approvals.",
  },
  {
    label: "Pricing legibility",
    detail: "Whether the cost of a run is visible before and after it happens.",
  },
  {
    label: "Native per-call selling",
    detail:
      "Whether a finished agent can natively charge callers per run, with earnings settled to the builder.",
  },
] as const;

const PROOF_LINKS = [
  {
    href: "/compare/gumloop-alternative",
    tag: "Compare",
    label: "Suede vs Gumloop vs Make →",
  },
  { href: "/agents", tag: "Inspect", label: "Browse published agents →" },
  { href: "/docs/architecture", tag: "Verify", label: "Read the architecture →" },
  { href: "/templates", tag: "Start", label: "Open the template catalog →" },
  { href: "/pricing", tag: "Budget", label: "Read the pricing model →" },
  { href: "/start", tag: "Build", label: "Publish your first agent →" },
] as const;

export default function BestAIAgentBuildersPage(): React.JSX.Element {
  const stats = buildTemplateCatalogStats();
  const builders = buildRankings(
    NODE_META.length,
    stats.total,
    stats.companyCount,
    stats.companySeats,
  );

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${PAGE_URL}#webpage`,
        url: PAGE_URL,
        name: "Best AI Agent Builders 2026",
        description:
          "Eight AI agent builder platforms ranked by builder quality, multi-agent operating model, pricing legibility, and native agent monetization, verified against public sources as of July 24, 2026.",
        inLanguage: "en-US",
        breadcrumb: { "@id": `${PAGE_URL}#breadcrumb` },
        mainEntity: { "@id": `${PAGE_URL}#list` },
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${PAGE_URL}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Suede Agent Studio", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Best AI Agent Builders 2026", item: PAGE_URL },
        ],
      },
      {
        "@type": "ItemList",
        "@id": `${PAGE_URL}#list`,
        name: "Best AI Agent Builders 2026",
        description:
          "Eight AI agent builder platforms ranked by builder quality, multi-agent operating model, pricing legibility, and native agent monetization, verified against public sources as of July 24, 2026.",
        itemListOrder: "https://schema.org/ItemListOrderAscending",
        numberOfItems: builders.length,
        itemListElement: builders.map((b) => ({
          "@type": "ListItem",
          position: b.rank,
          item: {
            "@type": "SoftwareApplication",
            name: b.name,
            url: b.url,
            applicationCategory: "DeveloperApplication",
            description: b.description,
          },
        })),
      },
    ],
  };

  return (
    <div className="lp rk-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <SiteNav active="/rankings/best-ai-agent-builders" />
      <main id="main-content">
        <header className="lp-shell rk-hero">
          <span className="lp-eyebrow">Rankings · Verified July 2026</span>
          <h1 className="rk-hero__title">
            Best AI agent builders ranked by what&apos;s actually live
          </h1>
          <p className="rk-hero__lede">
            Eight platforms evaluated on builder quality, multi-agent operating
            model, pricing legibility, and whether a finished agent can earn.
            Every claim checked against public documentation, first-party
            releases, and user reviews as of July 24, 2026. Rankings reflect
            what&apos;s live today, not roadmap promises.
          </p>
          <div className="rk-method" role="group" aria-label="Ranking methodology">
            {METHOD.map((m) => (
              <div key={m.label}>
                <strong>{m.label}</strong>
                <span>{m.detail}</span>
              </div>
            ))}
          </div>
        </header>

        <section className="lp-shell rk-section" aria-labelledby="the-rankings">
          <div className="rk-section__intro">
            <span className="lp-eyebrow">The list</span>
            <h2 id="the-rankings">Eight builders, one sourcing standard</h2>
            <p>
              &ldquo;Native per-call selling&rdquo; marks platforms where a builder can
              separately enable payment for a finished agent, with settled-call
              earnings routed to the builder. One platform ranked here clears
              that bar today.
            </p>
          </div>

          <ol className="rk-list">
            {builders.map((b) => (
              <li key={b.name} className={b.highlight ? "rk-card rk-card--top" : "rk-card"}>
                <div className="rk-card__head">
                  <div className="rk-card__id">
                    <span className="rk-rank" aria-hidden="true">
                      {b.rank}
                    </span>
                    <div>
                      <h3 className="rk-card__name">
                        <span className="sr-only">{`Rank ${b.rank}: `}</span>
                        {b.name}
                      </h3>
                      <span className="rk-card__tagline">{b.tagline}</span>
                    </div>
                  </div>
                  <span className={b.payPerCall ? "rk-chip rk-chip--earns" : "rk-chip"}>
                    Per-call selling: {b.payPerCall ? "Native" : "Not found"}
                  </span>
                </div>

                <p className="rk-card__desc">{b.description}</p>

                <div className="rk-card__facts">
                  <div className="rk-fact rk-fact--strength">
                    <span className="rk-fact__label">Key strength</span>
                    <p>{b.strength}</p>
                  </div>
                  <div className="rk-fact">
                    <span className="rk-fact__label">Key weakness</span>
                    <p>{b.weakness}</p>
                  </div>
                </div>

                {b.highlight ? (
                  <p className="rk-card__cta">
                    <Link href="/start" className="lp-btn lp-btn--primary">
                      Publish your first agent →
                    </Link>
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
          <p className="rk-footnote">
            &ldquo;Not found&rdquo; reflects public documentation and first-party
            releases as of July 24, 2026, not a promise about what any platform
            ships next. Suede-side counts (node types, templates, company org
            charts) are read from the live catalogs at build time.
          </p>
        </section>

        <section className="lp-shell rk-section" aria-labelledby="walk-the-argument">
          <div className="rk-section__intro">
            <span className="lp-eyebrow">Walk the argument</span>
            <h2 id="walk-the-argument">Check the #1 claim yourself</h2>
            <p>
              The case for the top spot rests on surfaces you can open right
              now: the head-to-head comparison, the live agent directory, and
              the architecture that settles a payment before a paid run.
            </p>
          </div>
          <div className="rk-proof__links">
            {PROOF_LINKS.map((link) => (
              <Link key={link.href} href={link.href}>
                <span>{link.tag}</span>
                <strong>{link.label}</strong>
              </Link>
            ))}
          </div>
        </section>

        <div className="lp-shell">
          <section className="rk-cta" aria-labelledby="rk-cta-title">
            <span className="lp-eyebrow">See the full breakdown</span>
            <h2 id="rk-cta-title">How does Suede Agent Studio stack up head-to-head?</h2>
            <p>
              See a feature-by-feature comparison of Suede Agent Studio vs
              Gumloop vs Make, including the org-chart operating model,
              pay-per-call endpoints, and marketplace support.
            </p>
            <div className="rk-cta__actions">
              <Link href="/compare/gumloop-alternative" className="lp-btn lp-btn--primary">
                See how Suede Agent Studio compares →
              </Link>
              <Link href="/agents" className="lp-btn lp-btn--ghost">
                Browse published agents
              </Link>
            </div>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
