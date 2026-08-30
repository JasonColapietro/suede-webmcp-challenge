/**
 * /firm: Suede Visibility, the credibility / reputation / AI-search practice
 * from Suede Labs, sold as a capped five-cohort engagement.
 *
 * The cohort board renders from COHORT_BOARD below. Statuses are flipped by
 * hand when an engagement signs or wraps; nothing on this page counts down,
 * fills automatically, or simulates demand.
 */
import type { Metadata } from "next";
import Link from "next/link";
import SiteFooter from "@/components/site/SiteFooter";
import SiteNav from "@/components/site/SiteNav";
import { OG_IMAGE, SITE_URL } from "@/lib/site";
import "../chrome.css";
import "../site.css";
import "./firm.css";

const PAGE_URL = `${SITE_URL}/firm`;
const APPLY_EMAIL = "support@suedeai.ai";
const BOARD_OPENED = "2026-08-18";
const LAST_UPDATED = "2026-08-18";

export const metadata: Metadata = {
  title: { absolute: "AEO + GEO Marketing Firm | Suede Agent Studio" },
  description:
    "Suede Visibility is the credibility, reputation, and AI search firm from Suede Labs. Five client cohorts at a time. Schema, proof, and a citation ledger across ChatGPT, Perplexity, and Google AI Overviews.",
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: PAGE_URL,
    siteName: "Suede Agent Studio",
    title: "AEO + GEO Marketing Firm | Suede Agent Studio",
    description:
      "The credibility, reputation, and AI search firm from Suede Labs. Five cohorts at a time, founder-reviewed intake, and a share-of-voice ledger per engine.",
    images: [{ url: OG_IMAGE }],
  },
  twitter: {
    card: "summary_large_image",
    title: "AEO + GEO Marketing Firm | Suede Agent Studio",
    description:
      "Five cohorts at a time. Schema, proof, and citation tracking across ChatGPT, Perplexity, and Google AI Overviews. No guaranteed placements, ever.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
    images: [OG_IMAGE],
  },
};

type CohortStatus = "open" | "in-review" | "engaged";

/** Hand-edited roster. Flip a status when an engagement signs or wraps. */
const COHORT_BOARD: readonly { id: string; label: string; status: CohortStatus }[] = [
  { id: "01", label: "Founding intake", status: "open" },
  { id: "02", label: "Founding intake", status: "open" },
  { id: "03", label: "Founding intake", status: "open" },
  { id: "04", label: "Founding intake", status: "open" },
  { id: "05", label: "Founding intake", status: "open" },
] as const;

const STATUS_COPY: Record<CohortStatus, string> = {
  open: "Open",
  "in-review": "In review",
  engaged: "Engaged",
};

const PAGE_CAPS: readonly string[] = [
  "Five cohorts, hard cap",
  "A person reviews every application",
  "Fixed query set, tracked per engine",
  "Schema and proof work shipped",
  "No guaranteed citations",
] as const;

const OUTCOMES = [
  {
    number: "01 · Credibility",
    title: "Make the record provable",
    detail:
      "Answer engines cite sources they can verify. The firm builds your entity graph, claims your profiles, aligns your organization data, and ships proof pages that hold up when a model checks who you are.",
  },
  {
    number: "02 · Reputation",
    title: "Audit what the engines say about you",
    detail:
      "Ask each engine about your brand by name and you get an answer today, good or bad. The firm baselines that answer, fixes the sources it draws from, and tracks how it moves.",
  },
  {
    number: "03 · Visibility",
    title: "Appear where your category is asked",
    detail:
      "When a buyer asks for the best option in your category, the answer names someone. The firm works a fixed set of those buyer prompts and reports your share of them, engine by engine.",
  },
] as const;

const DISCIPLINES = [
  {
    name: "SEO",
    surface: "The ranked results page",
    win: "Your page holds a position a person can click.",
  },
  {
    name: "AEO",
    surface: "The direct answer box",
    win: "Your content is the answer an engine extracts and shows.",
  },
  {
    name: "GEO",
    surface: "The generated response",
    win: "Your brand is named and cited inside the answer an AI writes.",
  },
] as const;

const METHOD = [
  {
    number: "01",
    label: "Baseline",
    detail:
      "We fix a query set of real buyer prompts for your category, then capture timestamped evidence of which brands each engine names today.",
    artifact: "Artifact: the baseline ledger, dated, yours to keep.",
  },
  {
    number: "02",
    label: "Structure",
    detail:
      "We ship the structural work on your site: schema, entity markup, literal-question headers, and answer-shaped pages engines can extract.",
    artifact: "Artifact: deployed markup and pages on your domain.",
  },
  {
    number: "03",
    label: "Authority",
    detail:
      "We build the proof the engines look for: consistent third-party surfaces, claimed profiles, and citable reference material, all owned by you.",
    artifact: "Artifact: an authority checklist with every credential under your email.",
  },
  {
    number: "04",
    label: "Ledger",
    detail:
      "Every month we re-run the query set and report your share of voice per engine against the baseline, with the misses listed next to the wins.",
    artifact: "Artifact: the monthly ledger, wins and misses both.",
  },
] as const;

const LIMITS = [
  {
    head: "No guaranteed citations.",
    body: "Nobody controls what a model answers. The firm improves your odds through structure, proof, and authority, and reports the result honestly. Anyone promising placement is selling something else.",
  },
  {
    head: "No fake proof.",
    body: "No purchased reviews, no invented testimonials, no borrowed logos. This practice is new and says so. The founding cohorts become the case studies.",
  },
  {
    head: "No hostage accounts.",
    body: "Every profile, property, and schema deployment is claimed under your domain and your email. If we part ways, you keep everything.",
  },
  {
    head: "No manufactured urgency.",
    body: "The board on this page fills by hand and empties by hand. There are no countdown timers, no seat tickers, and no deadline that quietly resets.",
  },
] as const;

const APPLICATION_FIELDS = [
  {
    head: "Company and domain",
    body: "Who you are and the site the work would land on.",
  },
  {
    head: "Three buyer prompts",
    body: "The three questions you most want to be the answer for. Real phrasing beats keywords.",
  },
  {
    head: "Current standing",
    body: "Links that represent you today: press, docs, profiles, anything an engine might already be reading.",
  },
  {
    head: "The trigger",
    body: "What made this urgent. A lost deal, a wrong answer about your brand, a competitor cited in your place.",
  },
  {
    head: "Timeline",
    body: "When you want the baseline captured and any date the engagement must respect.",
  },
] as const;

const FAQS = [
  {
    question: "How long until AI engines cite my brand?",
    answer:
      "Structural work lands in the first weeks: schema, entity cleanup, and answer-shaped pages. Citation movement is slower and typically takes months, because engines re-crawl and re-weigh sources on their own schedule. The monthly ledger shows movement or its absence honestly, so you are never guessing.",
  },
  {
    question: "Do you guarantee citations or placement?",
    answer:
      "No. Nobody controls what a model answers, and a guarantee in this category is a red flag rather than a promise. The firm commits to the work and the reporting: a dated baseline, shipped structure and proof, and a monthly share-of-voice ledger per engine against a fixed query set.",
  },
  {
    question: "Which AI engines does the firm track?",
    answer:
      "The baseline set is ChatGPT, Perplexity, and Google AI Overviews. Gemini, Claude, and Copilot are added when your buyers are there. Share of voice is reported per engine because the same brand can be strong in one engine and absent from another.",
  },
  {
    question: "What does an engagement cost?",
    answer:
      "Pricing is quoted in the cohort proposal after a person reviews your application. No payment is collected with the application, and the free scan costs nothing. The quote names the retainer, the term, and exactly what ships each month.",
  },
  {
    question: "Why does the firm only take five cohorts?",
    answer:
      "Every cohort gets founder-level review of the work that ships under its name. Five is the ceiling where that attention holds without diluting into account management. The cap is an operating constraint, not a marketing device, and the board on this page is its public record.",
  },
  {
    question: "What happens if the board is full when I apply?",
    answer:
      "Applications stay open and queue in order. When an engagement wraps, the next application in line gets the review. The board statuses are set by hand and dated, so what you see on this page is the actual state of the roster.",
  },
] as const;

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": `${PAGE_URL}#webpage`,
      url: PAGE_URL,
      name: "Suede Visibility: AEO + GEO Marketing Firm",
      description:
        "The credibility, reputation, and AI search firm from Suede Labs. Five client cohorts at a time, founder-reviewed intake, and a monthly share-of-voice ledger per engine.",
      datePublished: "2026-08-18",
      dateModified: `${LAST_UPDATED}`,
      inLanguage: "en-US",
      breadcrumb: { "@id": `${PAGE_URL}#breadcrumb` },
      mainEntity: { "@id": `${PAGE_URL}#service` },
    },
    {
      "@type": "BreadcrumbList",
      "@id": `${PAGE_URL}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Suede Agent Studio", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Suede Visibility", item: PAGE_URL },
      ],
    },
    {
      "@type": "Service",
      "@id": `${PAGE_URL}#service`,
      name: "Suede Visibility",
      serviceType:
        "Answer engine optimization (AEO), generative engine optimization (GEO), and brand credibility services",
      url: PAGE_URL,
      provider: { "@id": "https://suedeai.ai/#organization" },
      areaServed: "Worldwide",
      availableChannel: {
        "@type": "ServiceChannel",
        serviceUrl: PAGE_URL,
        availableLanguage: ["English"],
      },
    },
    {
      "@type": "FAQPage",
      "@id": `${PAGE_URL}#faq`,
      mainEntity: FAQS.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    },
  ],
};

const applyHref = `mailto:${APPLY_EMAIL}?subject=${encodeURIComponent(
  "Visibility cohort application",
)}`;

export default function FirmPage(): React.JSX.Element {
  return (
    <div className="lp fm-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <SiteNav />
      <main id="main-content">
        <header className="lp-shell fm-hero">
          <div className="fm-hero__copy">
            <span className="lp-eyebrow">
              Suede Visibility · Credibility, reputation, AI search
            </span>
            <h1 className="fm-hero__title">
              When buyers ask AI, be the brand in the answer.
            </h1>
            <p className="fm-hero__lede">
              Suede Visibility is the marketing firm from Suede Labs for the
              questions buyers now ask engines instead of search bars. We ship
              the structure, proof, and authority work that makes ChatGPT,
              Perplexity, and Google AI Overviews cite you, and we report share
              of voice engine by engine. The firm holds five client cohorts at
              a time. A person reviews every application.
            </p>
            <div className="fm-caps" aria-label="What this engagement includes">
              <span className="fm-caps__kicker">The offer</span>
              {PAGE_CAPS.map((cap) => (
                <span key={cap} className="lp-pill">
                  {cap}
                </span>
              ))}
            </div>
            <div className="fm-actions">
              <a href="#apply" className="lp-btn lp-btn--primary">
                Apply for a cohort seat →
              </a>
            </div>
          </div>

          <aside className="fm-board" aria-labelledby="cohort-board-title">
            <div className="fm-board__head">
              <span>Cohort board</span>
              <strong id="cohort-board-title">Capacity: five</strong>
            </div>
            <ol className="fm-board__list">
              {COHORT_BOARD.map((slot) => (
                <li key={slot.id} className="fm-board__slot">
                  <span className="fm-board__id">C-{slot.id}</span>
                  <span className="fm-board__label">{slot.label}</span>
                  <span className={`fm-board__status fm-board__status--${slot.status}`}>
                    {STATUS_COPY[slot.status]}
                  </span>
                </li>
              ))}
            </ol>
            <p className="fm-board__foot">
              Statuses are set by hand when an engagement signs or wraps.
              Nothing here counts down or fills on its own. Board opened{" "}
              <time dateTime={BOARD_OPENED}>{BOARD_OPENED}</time>.
            </p>
          </aside>
        </header>

        <section className="lp-shell fm-section" aria-labelledby="what-the-firm-works-on">
          <div className="fm-section__intro">
            <span className="lp-eyebrow">The work</span>
            <h2 id="what-the-firm-works-on">Three outcomes, one desk</h2>
            <p>
              Credibility, reputation, and visibility are usually sold as three
              engagements by three vendors. In AI search they are one problem:
              what an engine can verify about you decides what it says about
              you, and what it says decides whether you appear.
            </p>
          </div>
          <div className="fm-outcomes">
            {OUTCOMES.map((outcome) => (
              <article key={outcome.title}>
                <span>{outcome.number}</span>
                <h3>{outcome.title}</h3>
                <p>{outcome.detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="lp-shell fm-section" aria-labelledby="seo-aeo-geo">
          <div className="fm-section__intro fm-section__intro--wide">
            <span className="lp-eyebrow">Definitions</span>
            <h2 id="seo-aeo-geo">SEO, AEO, and GEO are different jobs</h2>
            <p>
              SEO earns a ranked link a person clicks. AEO wins the direct
              answer an engine extracts. GEO gets your brand named and cited
              inside the response an AI writes. The firm works all three, and
              reports them separately, because a brand can win one surface and
              be invisible on another.
            </p>
          </div>
          <div className="fm-table-wrap">
            <table className="fm-table">
              <thead>
                <tr>
                  <th scope="col">Discipline</th>
                  <th scope="col">The surface</th>
                  <th scope="col">What winning looks like</th>
                </tr>
              </thead>
              <tbody>
                {DISCIPLINES.map((row) => (
                  <tr key={row.name}>
                    <th scope="row">{row.name}</th>
                    <td>{row.surface}</td>
                    <td>{row.win}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="lp-shell fm-section fm-method" aria-labelledby="method-title">
          <div className="fm-section__intro">
            <span className="lp-eyebrow">The method</span>
            <h2 id="method-title">Four phases, each with an artifact</h2>
            <p>
              Every phase ends in something you can hold: a dated ledger, a
              deployed page, a checklist of credentials you own. If a month
              produces no artifact, the month failed and the ledger says so.
            </p>
          </div>
          <ol className="fm-method__steps">
            {METHOD.map((step) => (
              <li key={step.number}>
                <span>{step.number}</span>
                <div>
                  <strong>{step.label}</strong>
                  <p>{step.detail}</p>
                  <em>{step.artifact}</em>
                </div>
              </li>
            ))}
          </ol>
          <div className="fm-engines" aria-label="Engines tracked by the ledger">
            <p>
              <strong>ChatGPT</strong>
              <span>Baseline engine</span>
            </p>
            <p>
              <strong>Perplexity</strong>
              <span>Baseline engine</span>
            </p>
            <p>
              <strong>AI Overviews</strong>
              <span>Baseline engine</span>
            </p>
          </div>
        </section>

        <section className="lp-shell fm-section" aria-labelledby="why-five">
          <div className="fm-why">
            <span className="lp-eyebrow">The cap</span>
            <h2 id="why-five">Why five cohorts, and not fifty</h2>
            <p>
              Every cohort gets founder-level review of the work that ships
              under its name: the query set, the schema, the proof pages, the
              monthly ledger. <strong>Five is the ceiling where that attention
              holds.</strong> Past it, review turns into account management and
              the quality claim on this page stops being true.
            </p>
            <p>
              When the board is full, it is full. Applications stay open and
              queue in order, and the next opening goes to the front of the
              line. The board above is the public record of the roster, set by
              hand, dated, and honest about the fact that a new firm starts
              with five open seats.
            </p>
            <p>
              The firm runs its own checks on the rails this site documents.
              The node catalog behind the monitoring flows is public at{" "}
              <Link href="/docs/nodes">/docs/nodes</Link>, and the agent
              directory this studio publishes is at{" "}
              <Link href="/agents">/agents</Link>. Nothing in the method
              depends on tooling you cannot inspect.
            </p>
          </div>
        </section>

        <section className="lp-shell fm-section" aria-labelledby="will-not-do">
          <div className="fm-section__intro">
            <span className="lp-eyebrow">Useful limits</span>
            <h2 id="will-not-do">What the firm will not do</h2>
          </div>
          <ul className="fm-limits">
            {LIMITS.map((limit) => (
              <li key={limit.head}>
                <strong>{limit.head}</strong>
                <span>{limit.body}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="lp-shell fm-section fm-apply" id="apply" aria-labelledby="apply-title">
          <div className="fm-section__intro">
            <span className="lp-eyebrow">Apply</span>
            <h2 id="apply-title">Apply for a cohort seat</h2>
            <p>
              The application is an email, not a form. Five things, in your own
              words. A person reads it and replies within one business day
              with either a review call or a straight no.
            </p>
            <div className="fm-actions fm-apply__cta">
              <a href={applyHref} className="lp-btn lp-btn--primary">
                Apply by email →
              </a>
            </div>
            <p className="fm-apply__terms">
              No payment is collected with an application. Pricing and terms
              are quoted in the cohort proposal after review. Questions before
              applying go to the same address:{" "}
              <a href={`mailto:${APPLY_EMAIL}`}>{APPLY_EMAIL}</a>.
            </p>
          </div>
          <ol className="fm-apply__fields" aria-label="What to include in the application">
            {APPLICATION_FIELDS.map((field) => (
              <li key={field.head}>
                <div>
                  <strong>{field.head}</strong>
                  <p>{field.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="lp-shell fm-section fm-faq" id="faq" aria-labelledby="faq-title">
          <div className="fm-section__intro">
            <span className="lp-eyebrow">FAQ</span>
            <h2 id="faq-title">Before you apply</h2>
          </div>
          <div className="fm-faq__list">
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
