import { Fragment } from "react";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import HeroGraph from "@/components/landing/HeroGraph";
import RailsTicker from "@/components/landing/RailsTicker";
import AgentOrgCard from "@/components/landing/AgentOrgCard";
import { AgentMark } from "@/components/landing/AgentMarks";
import CompanyPreviewCard from "@/components/landing/CompanyPreviewCard";
import TemplateGallery from "@/components/landing/TemplateGallery";
import JourneyAltitudes from "@/components/landing/JourneyAltitudes";
import ReliabilityBand from "@/components/landing/ReliabilityBand";
import SystemMap from "@/components/landing/SystemMap";
import { buildTemplateSummaries } from "@/lib/template-summaries";
import { COMPANY_TEMPLATES } from "@/lib/company/templates";
import { buildCatalog, type CatalogEntry } from "@/lib/catalog";
import { buildLiveSlugByTemplate } from "@/lib/live-template-map";
import { BLUEPRINT_LIST } from "@/lib/site/blueprint-meta";
import { TOPUP_TIERS } from "@/lib/gateway/topup-handler";
import { Faq, FAQ_ITEMS } from "@/components/landing/Faq";
import TonightsCard from "@/components/landing/TonightsCard";
import { SITE_URL, SITE_LAST_UPDATED } from "@/lib/site";
import "./chrome.css";
import "./site.css";

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": `${SITE_URL}/#faq`,
  mainEntity: FAQ_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: { "@type": "Answer", text: item.answer },
  })),
};

const HOMEPAGE_DATE_PUBLISHED = "2026-06-11T00:00:00Z";
// One shared freshness date (src/lib/site.ts) also drives the footer's
// visible line and the sitemap's "/" entry.
const HOMEPAGE_DATE_MODIFIED = `${SITE_LAST_UPDATED}T00:00:00Z`;

const webPageJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  "@id": `${SITE_URL}/#webpage`,
  url: SITE_URL,
  name: "Suede Agent Studio: agents that earn, not just run",
  isPartOf: { "@id": `${SITE_URL}/#website` },
  about: { "@id": `${SITE_URL}/#app` },
  datePublished: HOMEPAGE_DATE_PUBLISHED,
  dateModified: HOMEPAGE_DATE_MODIFIED,
};

// The settled-service strip reads the public catalog; refresh it every 2 minutes.
export const revalidate = 120;

const RAILS = [
  "x402 v2 settlement",
  "USDC on Base",
  "A2A 1.0 interface",
  "MCP tools",
  "AgentCards",
  "OpenAPI 3.1",
  "Stripe builder credit",
  "Dry-run previews",
  "Signed receipts",
];

const NODE_CHIPS: { label: string; price?: string; color: string }[] = [
  { label: "Input", color: "var(--text-muted)" },
  { label: "LLM (Claude)", color: "var(--primary)" },
  { label: "Branch", color: "var(--text-warning)" },
  { label: "Schedule", color: "var(--primary)" },
  { label: "Extract PDF Text", color: "var(--text-info)" },
  { label: "Slack Message", color: "var(--text-success)" },
  { label: "Generate Invoice PDF", color: "var(--text-warning)" },
  { label: "Output", color: "var(--text-muted)" },
  { label: "Generate Song", price: "$0.50", color: "var(--text-info)" },
];

const AGENT_LOGOS = ["Claude", "Codex", "Gemini", "Cursor", "Hermes", "OpenClaw", "Pi", "OpenCode"];

// A first-time visitor's first question is "what am I actually building?".
// This answers it in the canvas's own three words — node, wire, run — before
// any of the org-chart or settlement framing arrives.
const FLOW_PRIMER: { no: string; title: string; body: string; color: string }[] = [
  {
    no: "01",
    title: "A node is one step.",
    body: "Read an email, ask Claude, check a condition, post to Slack, write an invoice. Each step is a labeled block you drag onto the canvas. No code, no API keys.",
    color: "var(--primary)",
  },
  {
    no: "02",
    title: "A wire is the order.",
    body: "Connect the blocks and you have said what happens first, what happens next, and what happens only when a condition is met. That connected picture is the flow, and the flow is the agent.",
    color: "var(--text-info)",
  },
  {
    no: "03",
    title: "Run it, then publish it.",
    body: "Test runs light up every node and show what each one cost. Publish and the flow gets a URL that people and other agents can call, with its preview, payment-enabled, or unavailable state stated up front.",
    color: "var(--text-success)",
  },
];

const FEATURES: { no: string; title: string; body: string; color: string }[] = [
  {
    no: "01",
    title: "The tools come wired",
    body: "The palette includes metered Suede endpoints plus optional IP registration and royalty-split nodes. Build without wiring every integration from scratch; connect the required payout and payment configuration only when an eligible priced Live service is ready to sell.",
    color: "var(--primary)",
  },
  {
    no: "02",
    title: "See every step and every cent",
    body: "Run a flow in Test and watch each node light up while the run streams a live per-node cost ledger. Promote a saved checkpoint to Live only after you have watched it work. Nothing ships, or spends, by accident.",
    color: "var(--text-info)",
  },
  {
    no: "03",
    title: "A workforce that earns",
    body: "A flow you price and launch can become an endpoint other agents pay to call. When payment is enabled, x402 settles exact USDC on Base before the work runs and routes it to the configured payout wallet.",
    color: "var(--text-success)",
  },
];

const STACK_PILLARS: { no: string; title: string; body: string; color: string }[] = [
  {
    no: "01",
    title: "Hire agents.",
    body: "Found a company from a first-party template, or hire one specialist at a time. Every hire is a real agent: a role, a budget, and its own flow, reporting into a department you control.",
    color: "var(--primary)",
  },
  {
    no: "02",
    title: "Equip them with tools.",
    body: "Every agent launches with real, first-party tools already wired in: Slack, GitHub, invoicing, document parsing, live web data, and more. Not simulated, and not a marketplace of someone else's connectors.",
    color: "var(--text-info)",
  },
  {
    no: "03",
    title: "Settle directly.",
    body: "Payment-enabled Live calls use x402 v2 to settle exact USDC on Base. A2A is the agent interface, and Stripe separately funds builder gateway credit; neither is presented as a caller-settlement rail.",
    color: "var(--text-success)",
  },
];

// The company section's before/after ledger: what the owner used to hold, and
// what the company holds instead once it is founded.
const COMPANY_SHIFT: { before: string; detail: string; after: string }[] = [
  {
    before: "Wiring every job by hand",
    detail:
      "Open a canvas, place the nodes, connect them, then start over for the next job.",
    after: "Pick a template",
  },
  {
    before: "Being the operator",
    detail:
      "Trigger each run, watch it finish, and remember to do it again tomorrow.",
    after: "Runs on schedule",
  },
  {
    before: "Holding the roadmap in your head",
    detail:
      "You decide what every agent does next, one prompt and one tab at a time.",
    after: "Approve the plan",
  },
  {
    before: "Invoicing for the work",
    detail:
      "Send it, track it, follow it up, then wait for the transfer to clear.",
    after: "Can settle per call",
  },
];

const RELAY: { no: string; role: string; desc: string; color: string }[] = [
  { no: "01", role: "Reads the input", desc: "trigger · context", color: "var(--primary)" },
  { no: "02", role: "Makes the decision", desc: "reasoning · logic", color: "var(--primary)" },
  { no: "03", role: "Takes the action", desc: "execute · route", color: "var(--text-success)" },
  { no: "04", role: "Publishes its state", desc: "preview · x402 when ready", color: "var(--primary)" },
];

const SCALE_LADDER: { title: string; body: string; cta: string; href: string }[] = [
  {
    title: "The solo founder.",
    body: "Describe the job in a sentence tonight and a working agent is live before you sleep. No API keys, no servers, and launch is free. Top up a dollar and the model is handled too.",
    cta: "Start with a sentence →",
    href: "/start",
  },
  {
    title: "The growing team.",
    body: "Put a department's repeat work on one canvas: leads scored, invoices chased, reports filed. That is the throughput of a team you have not hired. Each agent hands off to the next, and every run shows its steps and what they cost.",
    cta: "Browse the templates →",
    href: "#templates",
  },
  {
    title: "The enterprise.",
    body: "Treat agents like software. Immutable saved versions, separate Test and Live environments, release-style promotion, and a per-call USDC cost ledger finance can read. Export any flow to TypeScript, so your engineers own the code.",
    cta: "Read the docs →",
    href: "/docs",
  },
];

// Rows with a SUEDE_ENDPOINTS-style path mirror src/lib/rails/suede-endpoints.ts,
// the same endpoint table /pricing and /docs render. The last row mirrors the
// launched-agent run route (src/lib/catalog.ts). Never invent rows here.
const ENDPOINTS: { name: string; path: string; price: string }[] = [
  { name: "LLM reasoning call", path: "Claude gateway", price: "per 1M tokens" },
  { name: "Branch + schedule nodes", path: "platform side", price: "$0.000" },
  { name: "Generate a still image", path: "POST /agent/image", price: "$0.15" },
  { name: "Generate a full-length song", path: "POST /create-music", price: "$0.50" },
  { name: "Your published agent", path: "POST /api/agents/<id>/run", price: "state reported" },
];

const BUSINESS_JOBS: { name: string; desc: string; cadence: string }[] = [
  {
    name: "Lead qualifier",
    desc: "Scores inbound leads against your criteria and routes the hot ones to a human.",
    cadence: "per lead",
  },
  {
    name: "Footprint watch",
    desc: "Checks your listings, hours, and reviews for drift and flags what changed.",
    cadence: "runs nightly",
  },
  {
    name: "Morning report",
    desc: "Pulls the numbers you care about and files one readable brief before you sit down.",
    cadence: "runs daily",
  },
  {
    name: "Inbox triage",
    desc: "Sorts routine requests from the ones that need you, and drafts the routine replies.",
    cadence: "always on",
  },
  {
    name: "Competitor delta",
    desc: "Watches competitor pages for price, offer, and copy changes worth knowing about.",
    cadence: "runs nightly",
  },
  {
    name: "Invoice chaser",
    desc: "Follows up on unpaid invoices on a schedule, politely and without forgetting.",
    cadence: "runs weekly",
  },
];

const TEMPLATES = buildTemplateSummaries();

async function loadCatalog(): Promise<CatalogEntry[]> {
  try {
    return await buildCatalog();
  } catch {
    // The landing must render even when the catalog store is unreachable.
    return [];
  }
}

export default async function Home(): Promise<React.JSX.Element> {
  const catalog = await loadCatalog();
  const settledServices = catalog
    .filter((entry) => entry.acceptsPayment && entry.settledCalls > 0)
    .slice(0, 6);
  // Links each template card to a genuinely-launched /a/<slug> agent, so the
  // pillar page isn't limited to linking only the settled services shown below.
  const liveSlugByTemplate = buildLiveSlugByTemplate(catalog);
  return (
    <div className="lp">
      <SiteNav active="/" />
      <main id="main-content">

      {/* Hero */}
      <header className="lp-hero">
        <div className="lp-shell lp-hero-grid">
          <div>
            {/* Two reveal beats, not six: the statement (kicker, h1, lede)
                lands first, everything actionable (CTAs, stats, note) lands
                as one second beat. A per-block stagger reads as mechanical
                repetition and flattens the hierarchy. */}
            <span className="lp-kicker reveal">Agents that earn</span>
            <h1 className="lp-h1 reveal" style={{ animationDelay: "0.06s" }}>
              An agent in every seat. <em>Revenue on paid calls.</em>
            </h1>
            <p className="lp-lede reveal" style={{ animationDelay: "0.06s" }}>
              Drag the steps of a job onto a canvas, wire them in order, and
              publish. That flow is an agent, and it works nights and weekends
              without a salary. Fill every seat on your org chart and you have
              launched a company that runs itself. Each published agent reports
              whether it is available for preview, payment-enabled, or
              unavailable. When payment is enabled, callers pay over x402 v2 and
              settled USDC routes to your configured wallet.
              Stripe is available separately for builder gateway credit.
            </p>
            {/* One primary action, one quiet alternative. Any third path
                belongs below the fold, not in this row. Generic creation CTAs
                route to /start (Guided): the beginner-safe door that still
                offers templates, website intake, and the blank canvas. */}
            <div className="lp-hero-actions reveal" style={{ animationDelay: "0.18s" }}>
              <Link href="/start" className="lp-btn lp-btn--primary">
                Start building →
              </Link>
              <Link href="/pricing#split" className="lp-btn lp-btn--ghost">
                See how the payout works
              </Link>
            </div>
            <div className="lp-hero-meta reveal" style={{ animationDelay: "0.18s" }}>
              {/* Non-breaking spaces glue the last pair of words so the mono
                  microcopy never wraps into a single orphaned word. */}
              <div className="lp-stat">
                <b>Minutes</b>
                <span>from template to published&nbsp;service</span>
              </div>
              <div className="lp-stat">
                <b>24/7</b>
                <span>works while you&nbsp;sleep</span>
              </div>
              <div className="lp-stat">
                <b>One caller rail</b>
                <span>x402 v2 · USDC on&nbsp;Base</span>
              </div>
            </div>
            <p className="lp-hero-note reveal" style={{ animationDelay: "0.18s" }}>
              Have a website?{" "}
              <Link href="/from-website">Turn it into an agent →</Link>
            </p>
          </div>
          <HeroGraph />
        </div>

      </header>

      {/* Rails ticker: its own quiet band between the hero and the first
          section, not a third horizontal strip inside the hero itself. */}
      <div className="lp-shell">
        <RailsTicker rails={RAILS} />
      </div>

      {/* What a flow is — the plain-language primer. A first-time visitor
          should not have to read four business sections before learning what
          actually gets built on this canvas. */}
      <section id="what-is-a-flow" className="lp-section">
        <div className="lp-shell">
          <span className="lp-eyebrow">New here? Read this first</span>
          <h2 className="lp-section-title" style={{ maxWidth: 720 }}>
            An agent here is a flow: blocks on a canvas, wired in order.
          </h2>
          <p className="lp-section-sub" style={{ maxWidth: 680 }}>
            No repo, no servers, no prompt engineering. You drag the steps of
            a job onto a canvas, connect them in the order they should happen,
            and press Run. The picture stays readable long after the agent is
            working, so anyone can see what it does and change it.
          </p>
          <div className="lp-bento">
            {FLOW_PRIMER.map((s) => (
              <article
                key={s.no}
                className="lp-feature"
                style={{ ["--feat" as string]: s.color }}
              >
                <span className="lp-feature-no">{s.no}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </article>
            ))}
          </div>
          <div className="lp-hero-actions">
            <Link href="/start" className="lp-btn lp-btn--primary">
              Build your first flow →
            </Link>
            <Link href="#templates" className="lp-btn lp-btn--ghost">
              See a finished one first
            </Link>
          </div>
        </div>
      </section>

      {/* From your website — first beat after the hero: the lowest-friction
          way in, before the bigger autonomous-company story. */}
      <section id="from-website" className="lp-section">
        <div className="lp-shell">
          <span className="lp-eyebrow">Turn your work into agents</span>
          <h2 className="lp-section-title" style={{ maxWidth: 720 }}>
            Everything you have already published is an agent waiting to get
            paid.
          </h2>
          <p className="lp-section-sub" style={{ maxWidth: 660 }}>
            Your site, your product pages, your docs, your FAQ. That knowledge
            is already answering customer questions for free, one visitor at a
            time. Paste the URL and Suede reads those pages, shows you every
            page and fact it pulled, and drafts an agent grounded in exactly
            that. It answers in your words, and when your site doesn&apos;t
            cover something it says so instead of guessing, so it can face
            customers on day one. Paste, review, launch. From there it answers
            every caller at once, and a payment-enabled version can charge
            other agents per call in USDC.
          </p>
          <div className="lp-band">
            {BLUEPRINT_LIST.map((blueprint) => (
              <Link key={blueprint.id} href="/from-website" className="lp-band-card">
                <h3>{blueprint.label}</h3>
                <p>{blueprint.pitch}</p>
                <span className="lp-band-cta tabular">
                  From ${blueprint.suggestedPriceUsdc.toFixed(2)} per call →
                </span>
              </Link>
            ))}
          </div>
          <div className="lp-hero-actions">
            <Link href="/from-website" className="lp-btn lp-btn--primary">
              Turn your website into an agent →
            </Link>
          </div>
        </div>
      </section>

      {/* Autonomous company */}
      <section id="autonomous-company" className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-shell lp-boya-grid">
          <div>
            <span className="lp-eyebrow reveal">Autonomous company</span>
            <h2 className="lp-section-title reveal" style={{ animationDelay: "0.06s" }}>
              One agent is an employee. A company is the whole business.
            </h2>
            <p className="lp-section-sub reveal" style={{ animationDelay: "0.12s" }}>
              Manage the mission, not the plumbing. Pick a first-party template
              and Suede stands up the whole company: a mission, its departments,
              and a specialist agent in every seat, each a real flow with a role
              and a budget. That is an org chart most companies spend a year
              hiring into. Yours stands up in an afternoon. You approve the
              plan, then run a department or the whole roster from one board.
              Every published seat reports the same preview,
              payment-enabled, or unavailable state as any other agent. A
              payment-enabled seat can settle paid calls after its Live and
              payout gates pass.
            </p>
            <div className="lp-company-steps reveal" style={{ animationDelay: "0.18s" }}>
              <div className="lp-company-step">
                <h3>Found the company.</h3>
                <p>
                  Choose a first-party template. Suede seeds the mission and
                  stands up the org: departments, and a specialist agent in each
                  seat with its own flow and budget.
                </p>
              </div>
              <div className="lp-company-step">
                <h3>Approve the plan.</h3>
                <p>
                  Every company opens in draft. Turning on live selling, or
                  firing a publisher or a costly employee, waits on your explicit
                  approval, with the cost shown before you decide.
                </p>
              </div>
              <div className="lp-company-step">
                <h3>Watch it run and earn.</h3>
                <p>
                  Run a department or the whole company from one board. A
                  priced employee can settle USDC per call over x402 after its
                  Live payment and payout gates are enabled.
                </p>
              </div>
            </div>
          </div>
          <CompanyPreviewCard />
        </div>

        {/* What changes: the responsibility inversion, stated as a before/after
            ledger. This is the section's payoff beat, so it runs full-width
            below the grid rather than inside the narrow text column. */}
        <div className="lp-shell" style={{ marginTop: "clamp(2rem, 5vw, 3.5rem)" }}>
          <span className="lp-eyebrow">What changes</span>
          <h2 className="lp-section-title" style={{ maxWidth: 720 }}>
            You stop running the agents. You start running the company.
          </h2>
          <div className="lp-rows">
            {COMPANY_SHIFT.map((row) => (
              <div key={row.before} className="lp-row">
                <div className="grow">
                  <div className="name">{row.before}</div>
                  <div className="sub">{row.detail}</div>
                </div>
                <span className="lp-pill lp-pill--live">{row.after}</span>
              </div>
            ))}
          </div>
          <p className="lp-section-sub" style={{ marginTop: "1.25rem", maxWidth: 680 }}>
            None of it is a black box. Every seat opens into the same flow you
            would have wired by hand: readable, editable, and exportable to
            TypeScript the day you want the controls back.
          </p>
          <div className="lp-hero-actions">
            <Link href="/company" className="lp-btn lp-btn--primary">
              Found your company →
            </Link>
          </div>
          <p className="lp-company-proof">
            {COMPANY_TEMPLATES.length} first-party templates ship today, each a
            full company you can found and run under your wallet.
          </p>
        </div>
      </section>

      {/* The full stack: hire agents, equip them with tools, settle directly */}
      <section id="stack" className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-shell">
          <span className="lp-eyebrow">The full stack</span>
          <h2 className="lp-section-title">
            Hire agents. Equip them with tools. Settle directly.
          </h2>
          <p className="lp-section-sub">
            This is the same studio underneath every agent on this page: real
            hires, real first-party tools, and an x402 payment path built into
            eligible Live calls when settlement is enabled.
          </p>
          <div className="lp-bento">
            {STACK_PILLARS.map((p) => (
              <article
                key={p.no}
                className="lp-feature"
                style={{ ["--feat" as string]: p.color }}
              >
                <span className="lp-feature-no">{p.no}</span>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Bring your own agent */}
      <section id="byoa" className="lp-section">
        <div className="lp-shell lp-boya-grid">
          <div>
            <span className="lp-pill reveal">Model-agnostic</span>
            <h2 className="lp-section-title reveal" style={{ animationDelay: "0.06s" }}>
              Bring your own agent.
            </h2>
            <p className="lp-section-sub reveal" style={{ animationDelay: "0.12s" }}>
              Claude, Codex, Cursor, or code you wrote yourself. Wire it into a
              flow, give it a role, and a payment-enabled Live call can settle
              USDC to your payout wallet before the work runs.
            </p>
            <span className="lp-eyebrow lp-boya-eyebrow reveal" style={{ animationDelay: "0.16s" }}>
              Works with any agent
            </span>
            <div className="lp-agent-grid reveal" style={{ animationDelay: "0.2s" }}>
              {AGENT_LOGOS.map((name) => (
                <div key={name} className="lp-agent-chip">
                  <span className="mark">
                    <AgentMark name={name} />
                  </span>
                  <span className="label">{name}</span>
                </div>
              ))}
            </div>
          </div>
          <AgentOrgCard />
        </div>
      </section>

      {/* Business jobs */}
      <section id="for-business" className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-shell">
          <span className="lp-eyebrow">For businesses</span>
          <h2 className="lp-section-title">The work that keeps slipping to tomorrow.</h2>
          <p className="lp-section-sub">
            Every job on this list leaks money somewhere: a lead that cooled
            off, an invoice nobody chased, a competitor move you heard about
            late. Each one is a single seat on your org chart: a trigger, a few
            nodes, a schedule. Staff it once and it clocks in every morning,
            including the mornings you don&apos;t.
          </p>
          <div className="lp-rows">
            {BUSINESS_JOBS.map((job) => (
              <div key={job.name} className="lp-row">
                <div className="grow">
                  <div className="name">{job.name}</div>
                  <div className="sub">{job.desc}</div>
                </div>
                <span className="lp-pill lp-pill--sched tabular">{job.cadence}</span>
              </div>
            ))}
          </div>
          <p className="lp-section-sub" style={{ marginTop: "1.25rem" }}>
            If you would rather hand it off,{" "}
            <a href="https://suedeai.ai/footprint">Suede Footprint</a> is the
            managed version: human strategists on promotion, these agents on
            watch.
          </p>
        </div>
      </section>

      {/* Money block — the bring-nothing pitch */}
      <section className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-shell">
          <div className="lp-money-block">
            <h2>Bring nothing. Connect a wallet when it&apos;s time to get paid.</h2>
            <p>
              Most agent platforms charge your agents to run. Suede wires them
              to earn. No API keys: Suede meters the model. No servers: Suede
              hosts the endpoint. Connect a payout wallet and enable settlement
              when you are ready for priced Live calls; verified x402 payments
              then route to that wallet. Building and launching are free; the
              model runs on builder credit, from ${TOPUP_TIERS[0]}. You set the
              price per call.
            </p>
          </div>
        </div>
      </section>

      {/* Audience ladder */}
      <section id="who-its-for" className="lp-section">
        <div className="lp-shell">
          <span className="lp-eyebrow">Who it&apos;s for</span>
          <h2 className="lp-section-title">From one founder to a full org.</h2>
          <p className="lp-section-sub" style={{ maxWidth: 640 }}>
            The same studio carries you from your first agent to a fleet your
            whole company relies on. Nothing gets rebuilt on the way up.
          </p>
          <div className="lp-band">
            {SCALE_LADDER.map((rung) => (
              <Link key={rung.title} href={rung.href} className="lp-band-card">
                <h3>{rung.title}</h3>
                <p>{rung.body}</p>
                <span className="lp-band-cta">{rung.cta}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Orchestration */}
      <section id="orchestration" className="lp-section">
        <div className="lp-shell">
          <span className="lp-eyebrow">The orchestration layer</span>
          <h2 className="lp-section-title">One conductor. A whole workforce.</h2>
          <p className="lp-section-sub">
            Point dozens of specialized agents at a single goal and let them hand
            off down the line. No managers, no meetings, no clock. You design the
            flow and set the guardrails; the workforce runs it on repeat, day and
            night.
          </p>
          <div className="lp-relay">
            {RELAY.map((s, i) => (
              <Fragment key={s.no}>
                <article className="lp-relay-step" style={{ ["--c" as string]: s.color }}>
                  <span className="num">{s.no}</span>
                  <div className="role">{s.role}</div>
                  <span className="desc">{s.desc}</span>
                </article>
                {i < RELAY.length - 1 && <span className="lp-relay-arrow">→</span>}
              </Fragment>
            ))}
          </div>
          <p className="lp-relay-caption">All on one canvas · all at once · all night</p>
        </div>
      </section>

      {/* The journey: org chart, canvas, code */}
      <section id="altitudes" className="lp-section">
        <div className="lp-shell">
          <span className="lp-eyebrow">The journey</span>
          <h2 className="lp-section-title">One company, every altitude.</h2>
          <p className="lp-section-sub" style={{ maxWidth: 680 }}>
            Start as a founder on the org chart. Go node-deep on the canvas the
            day you want the controls. Finish in code if that&apos;s where you
            live. It&apos;s one product the whole way down: the same agent is a
            seat, a flow, and a published service with an explicit call state.
          </p>
          <JourneyAltitudes />
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="lp-section">
        <div className="lp-shell">
          <span className="lp-eyebrow">How it works</span>
          <h2 className="lp-section-title">
            The plumbing is the point, and it&apos;s already done.
          </h2>
          <p className="lp-section-sub">
            Every other agent builder hands you an LLM and a blank file. Suede
            Agent Studio adds first-party service nodes and a publication
            layer: metered endpoints, machine discovery, optional registry and
            royalty tools, and x402 settlement only when payment is enabled.
          </p>
          <div className="lp-bento">
            {FEATURES.map((f) => (
              <article
                key={f.no}
                className="lp-feature"
                style={{ ["--feat" as string]: f.color }}
              >
                <span className="lp-feature-no">{f.no}</span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Reliability */}
      <ReliabilityBand />

      {/* System map */}
      <SystemMap />

      {/* Nodes */}
      <section id="nodes" className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-shell">
          <span className="lp-eyebrow">The palette</span>
          <h2 className="lp-section-title">Every block of the workday, as a node.</h2>
          <p className="lp-section-sub">
            Reasoning, logic, schedules, documents, comms, invoicing, and
            payment settlement. Music and IP live in their own palette group
            for the creative vertical: generation, registry writes, royalty
            splits. Color-coded by category, priced in USDC, ready to wire.
          </p>
          <div className="lp-nodes">
            {NODE_CHIPS.map((c) => (
              <span key={c.label} className="lp-chip" style={{ ["--c" as string]: c.color }}>
                <b>{c.label}</b>
                {c.price && <span>{c.price}</span>}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Muse cross-promo — a creator-vertical aside, placed with the palette
          section that names the creative vertical. Never the page's last
          element: the page must close on the CTA band, not another product. */}
      <section className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-shell">
          <TonightsCard />
        </div>
      </section>

      {/* Endpoints / pricing */}
      <section id="endpoints" className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-shell">
          <span className="lp-eyebrow">Pricing</span>
          <h2 className="lp-section-title">Pay-per-call when enabled. No keys, no lock-in.</h2>
          <p className="lp-section-sub">
            LLM calls meter through the Claude gateway per 1M tokens, and
            branch and schedule nodes cost nothing on the platform side. The
            fixed-price endpoints behind the other nodes settle over x402, the
            open standard for paying per HTTP call: the wallet signs, the
            endpoint delivers, and the ledger records the cost in USDC on
            Base.
          </p>
          <div className="lp-ledger">
            {ENDPOINTS.map((e) => (
              <div key={e.path} className="lp-ledger-row">
                <span className="name">{e.name}</span>
                <span className="m">{e.path}</span>
                <span className="price">{e.price}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Payment-enabled services with at least one settled external call. */}
      {settledServices.length > 0 && (
        <section className="lp-section" style={{ paddingTop: 0 }}>
          <div className="lp-shell">
            <span className="lp-eyebrow">Settled services</span>
            <h2 className="lp-section-title">Payment-enabled agents with settled calls.</h2>
            <div className="lp-rows">
              {settledServices.map((e) => (
                <Link key={e.id} href={e.urls.public} className="lp-row">
                  <div className="grow">
                    <div className="name">{e.name}</div>
                    <div className="sub">{e.summary}</div>
                  </div>
                  {e.schedule && (
                    <span className="lp-pill lp-pill--sched tabular">runs {e.schedule}</span>
                  )}
                  <span className="lp-pill lp-pill--calls tabular">
                    {e.settledCalls} settled {e.settledCalls === 1 ? "call" : "calls"}
                  </span>
                  <span className="lp-pill lp-pill--price tabular">
                    ${e.priceUsdc.toFixed(3)} / call
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Templates */}
      <section id="templates" className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-shell">
          <span className="lp-eyebrow">Templates</span>
          <h2 className="lp-section-title">Pick a business, not a template.</h2>
          <p className="lp-section-sub">
            Each card is a blueprint with its steps, schedule, and intended
            price loaded. Open one in Guided, Studio, or Code, then publish it
            with a preview, payment-enabled, or unavailable call state.
          </p>
          <TemplateGallery templates={TEMPLATES} liveSlugByTemplate={liveSlugByTemplate} />
        </div>
      </section>

      {/* FAQ answers the last objections before the ask. */}
      <Faq />
      <script
        type="application/ld+json"

        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      {/* CTA — the page closes on the ask. Keep this the final element. */}
      <section className="lp-shell">
        <div className="lp-cta-band">
          <span className="lp-eyebrow" style={{ color: "var(--primary)" }}>
            Dozens of agents, one conductor: you
          </span>
          <h2>Staff your first seat tonight.</h2>
          <Link href="/start" className="lp-btn lp-btn--primary">
            Start building →
          </Link>
        </div>
      </section>

      </main>
      <SiteFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(webPageJsonLd) }}
      />
    </div>
  );
}
