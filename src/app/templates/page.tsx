/**
 * Templates hub — indexes the dedicated template landing pages. Each one was
 * previously reachable only by direct URL (they were in the sitemap but
 * linked from nowhere in the app). This is the discoverable home for them,
 * plus a pointer to the full in-product gallery and the live agent directory.
 */
import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import TemplateGallery from "@/components/landing/TemplateGallery";
import {
  buildFeaturedTemplateCards,
  buildTemplateCatalogStats,
  buildTemplateDetailIndex,
  buildTemplateSummaries,
} from "@/lib/template-summaries";
import "../chrome.css";
import "../site.css";
import "./template-pages.css";

const PAGE_TITLE = "Templates | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Ready-to-build agent templates: score leads, chase invoices, track competitors, and more. Open one in the studio, publish its state, and enable payments separately when eligible.";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/templates" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/templates",
    siteName: "Suede Agent Studio",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

/** URL-hash slug for a department name ("Finance" → "#dept-finance") — must
 * match the gallery's deep-link vocabulary in TemplateGallery.tsx. */
function deptHash(department: string): string {
  return `dept-${department.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export default function TemplatesPage(): React.JSX.Element {
  const allTemplates = buildTemplateSummaries();
  const featured = buildFeaturedTemplateCards();
  const detailIndex = buildTemplateDetailIndex();
  const stats = buildTemplateCatalogStats();
  return (
    <div className="lp">
      <SiteNav active="/templates" />
      <main id="main-content" className="lp-shell lp-page">
        <div className="lp-page-rail">
        <header className="lp-page-head">
          <span className="lp-eyebrow">Templates</span>
          <h1>Pick a business, not a blank canvas.</h1>
          <p>
            A template is a finished flow: a chain of steps, each one reading,
            deciding, or acting, wired end to end with its schedule set and a
            suggested price loaded. Open one in the studio, make it yours,
            then publish it with a preview, payment-enabled, or unavailable
            call state. {featured.length} featured picks below, or jump
            straight to the{" "}
            <Link href="#all-templates" style={{ color: "var(--primary)" }}>
              full catalog of {allTemplates.length}
            </Link>
            .
          </p>
          {/* Capabilities strip: what this page is for and what you can do
              here, readable before the first scroll. Same kicker + pills
              pattern as /pricing and /docs. */}
          <div
            role="list"
            aria-label="What you can do on this page"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0.5rem",
              marginTop: "var(--space-4)",
            }}
          >
            <span
              className="mono"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-label)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--text-secondary)",
              }}
            >
              The template catalog
            </span>
            {[
              "Browse the full catalog",
              "Filter by department",
              "Open one in the studio",
              "Publish its call state",
            ].map((item) => (
              <span key={item} role="listitem" className="lp-pill">
                {item}
              </span>
            ))}
          </div>
          <nav className="tg-anchor-rail" aria-label="Jump to a department">
            <Link href="#business" className="tg-anchor">
              Business <span className="tg-anchor-count">{stats.business}</span>
            </Link>
            {stats.departments.map((dept) => (
              <Link key={dept.name} href={`#${deptHash(dept.name)}`} className="tg-anchor">
                {dept.name} <span className="tg-anchor-count">{dept.count}</span>
              </Link>
            ))}
            <Link href="#personal" className="tg-anchor">
              Personal <span className="tg-anchor-count">{stats.personal}</span>
            </Link>
            <Link href="#creator" className="tg-anchor">
              Creator <span className="tg-anchor-count">{stats.creator}</span>
            </Link>
          </nav>
        </header>

        <section className="lp-featured-grid" aria-labelledby="featured-templates-title">
          <h2 id="featured-templates-title" className="sr-only">Featured templates</h2>
          {/* The card opens the template in the builder — same primary action
              as every catalog card — with the guide as the secondary read
              (QA round-2 finding 14). */}
          {featured.map((t) => (
            <div key={t.route} className="lp-featured-cell">
              <Link
                href={`/build/new?template=${t.slug}`}
                className="card lp-featured-template"
              >
                <span
                  className={`lp-tpl-tag lp-tpl-tag--${t.coreNodes ? "core" : "rails"}`}
                  title={
                    t.coreNodes
                      ? "Uses built-in nodes. External actions require a reviewed Connection before live deployment."
                      : "Taps Suede's paid media and workflow endpoints."
                  }
                >
                  {t.coreNodes ? "Core" : "Suede rails"}
                </span>
                <h3>{t.name}</h3>
                <p>{t.pitch}</p>
                <span className="tg-featured-pills">
                  <span className="lp-pill lp-pill--price tabular">
                    ${t.priceUsdc.toFixed(2)} suggested / {t.unit ?? "call"}
                  </span>
                  <span className="lp-pill tabular">
                    {t.nodeCount} {t.nodeCount === 1 ? "step" : "steps"}
                  </span>
                  {t.cadence && (
                    <span className="lp-pill lp-pill--sched tabular">runs {t.cadence}</span>
                  )}
                </span>
                <span className="lp-featured-template__meta">
                  <span className="lp-featured-template__action">Open this template →</span>
                </span>
              </Link>
              <div className="lp-tpl-more">
                <Link href={`/templates/${t.route}`} className="lp-tpl-more-link">
                  Read the guide →
                </Link>
              </div>
            </div>
          ))}
        </section>

        <section style={{ marginTop: "3.5rem" }} id="all-templates">
          {/* Scroll targets for the department anchor rail above: the hash both
              scrolls here and drives the gallery's filter via its hashchange
              listener, so #dept-finance lands on the catalog pre-filtered. */}
          <div aria-hidden="true">
            <span id="business" />
            <span id="personal" />
            <span id="creator" />
            {stats.departments.map((dept) => (
              <span key={dept.name} id={deptHash(dept.name)} />
            ))}
          </div>
          <span className="lp-eyebrow">The full catalog</span>
          <h2 className="lp-section-title" style={{ maxWidth: 680 }}>
            All {allTemplates.length} templates, by category.
          </h2>
          <p className="lp-section-sub" style={{ maxWidth: 640 }}>
            Filter by business, personal, or creator, then narrow business
            templates by department. Each card is a blueprint with its steps,
            schedule, and suggested price ready to customize.
          </p>
          <nav
            className="card"
            aria-labelledby="template-guide-index-title"
            style={{ marginTop: "1.5rem", padding: "1.5rem" }}
          >
            <h3 id="template-guide-index-title" style={{ margin: 0 }}>
              Browse every template guide
            </h3>
            <p style={{ color: "var(--text-muted)", lineHeight: 1.6, marginTop: "0.5rem" }}>
              Open a detailed, server-rendered guide for any of these {detailIndex.length} templates,
              or use the interactive gallery below to filter and launch one directly.
            </p>
            <ul
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "0.65rem 1.25rem",
                listStyle: "none",
                margin: "1.25rem 0 0",
                padding: 0,
              }}
            >
              {detailIndex.map((template) => (
                <li key={template.slug}>
                  <Link href={`/templates/${template.slug}`} style={{ color: "var(--primary)" }}>
                    {template.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <TemplateGallery templates={allTemplates} />
          {/* Catalog metrics are supporting context, not the task — they sit
              after the inventory so search and browsing come first. */}
          <div
            className="tg-stats"
            role="group"
            aria-label="Template catalog at a glance"
            style={{ marginTop: "2.5rem" }}
          >
            <div className="tg-stat">
              <span className="tg-stat-num">{stats.total}</span>
              <span className="tg-stat-label">agent templates</span>
            </div>
            <div className="tg-stat">
              <span className="tg-stat-num">{stats.departments.length}</span>
              <span className="tg-stat-label">business departments</span>
            </div>
            <div className="tg-stat">
              <span className="tg-stat-num">{stats.scheduled}</span>
              <span className="tg-stat-label">run on a schedule</span>
            </div>
            <div className="tg-stat">
              <span className="tg-stat-num">{stats.companyCount}</span>
              <span className="tg-stat-label">
                company templates, {stats.companySeats} seats
              </span>
            </div>
          </div>
        </section>

        <section style={{ marginTop: "3rem" }} className="card">
          <div style={{ padding: "1.75rem" }}>
            <span className="lp-eyebrow">Need a whole team, not one agent?</span>
            <p style={{ color: "var(--text-muted)", lineHeight: 1.6, marginTop: "0.6rem" }}>
              Beyond single agents, {stats.companyCount} company templates each
              staff a working org chart, {stats.companySeats} seats in total,
              organized into departments with every role&apos;s flow wired. Start one at{" "}
              <Link href="/company" style={{ color: "var(--primary)" }}>
                /company
              </Link>
              .
            </p>
          </div>
        </section>

        <section style={{ marginTop: "1.5rem" }} className="card">
          <div style={{ padding: "1.75rem" }}>
            <span className="lp-eyebrow">Looking for something else?</span>
            <p style={{ color: "var(--text-muted)", lineHeight: 1.6, marginTop: "0.6rem" }}>
              The{" "}
              <Link href="/agents" style={{ color: "var(--primary)" }}>
                agent directory
              </Link>{" "}
              lists every published agent with an explicit preview,
              payment-enabled, or unavailable state. Active x402 terms appear
              only when payment is enabled. Or start from a blank canvas at{" "}
              <Link href="/build/new" style={{ color: "var(--primary)" }}>
                /build/new
              </Link>
              .
            </p>
          </div>
        </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
