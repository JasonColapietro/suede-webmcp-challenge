/**
 * Derived template detail pages — one indexable page for every marketing-allowed
 * template that does NOT already have a hand-authored /templates/<route>
 * directory (those six static dirs take precedence over this dynamic route).
 * Every fact renders from the seed graph via getTemplateDetail; nothing here is
 * authored per template, so the pages can never drift from the catalog.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import TemplateFacts from "../TemplateFacts";
import {
  getRelatedTemplates,
  getTemplateDetail,
  listTemplateDetailPageSlugs,
} from "@/lib/template-summaries";
import { buildTemplateMetadataDescription } from "@/lib/metadata-copy";
import "../../chrome.css";
import "../../site.css";
import "../template-pages.css";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams(): { slug: string }[] {
  return listTemplateDetailPageSlugs().map((slug) => ({ slug }));
}

/** Capitalized fallback when a business template carries no department tag. */
function categoryLabel(detail: { category: string; department: string | null }): string {
  return (
    detail.department ?? detail.category.charAt(0).toUpperCase() + detail.category.slice(1)
  );
}

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { slug } = await params;
  const detail = getTemplateDetail(slug);
  if (!detail) return {};
  const title = `${detail.name} Agent Template | Suede Agent Studio`;
  const description = buildTemplateMetadataDescription(detail);
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: `/templates/${detail.slug}` },
    openGraph: {
      type: "website",
      locale: "en_US",
      url: `/templates/${detail.slug}`,
      siteName: "Suede Agent Studio",
      title,
      description,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      site: "@AISUEDE",
      creator: "@johnnysuede",
    },
  };
}

export default async function TemplateDetailPage({
  params,
}: RouteParams): Promise<React.JSX.Element> {
  const { slug } = await params;
  const detail = getTemplateDetail(slug);
  if (!detail) notFound();
  const related = getRelatedTemplates(detail.slug, 3);
  const label = categoryLabel(detail);
  const unitNoun = detail.unit ?? "call";

  const HOW_IT_RUNS = [
    detail.cadence
      ? {
          color: "var(--violet)",
          label: `Runs ${detail.cadence}`,
          body: `A schedule step drives this agent on its own cron, so it runs ${detail.cadence} without anyone pressing a button. When preview is available, those runs are free and have no side effects.`,
        }
      : {
          color: "var(--primary)",
          label: "Runs on demand",
          body: `Each accepted caller request triggers the ${detail.steps.length}-step flow once. Ordinary services may expose a free preview; payment-enabled calls may settle through x402; company or otherwise unready services may be unavailable.`,
        },
    {
      color: "var(--text-success)",
      label: `$${detail.priceUsdc.toFixed(2)} per ${unitNoun}, suggested`,
      body: `The template opens with this intended price loaded. Launch publishes the service and its current call state. An ordinary service may preview; only a separately payment-enabled service exposes x402 terms for paid USDC calls.`,
    },
    detail.coreNodes
      ? {
          color: "var(--text-warning)",
          label: "Built on core nodes",
          body: "The wired flow uses built-in nodes only. Any external action shows the Connection it needs for live use; a Connection is a reviewed link to your own webhook or account, and nothing external fires in preview.",
        }
      : {
          color: "var(--text-warning)",
          label: "Built on Suede rails",
          body: "Beyond the core nodes, this flow taps Suede's paid media and workflow endpoints. Per-step costs are itemized in the run ledger, so you always see what a call spends before you price it.",
        },
  ];

  return (
    <div className="lp">
      <SiteNav active="/templates" />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">{label} template</span>
          <h1>{detail.name}</h1>
          <p>{detail.pitchProse}</p>
          <p className="tg-detail-desc">{detail.description}</p>
        </header>

        <TemplateFacts slug={detail.slug} />

        <section
          style={{
            marginTop: "3.5rem",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "1.25rem",
          }}
          aria-label={`How the ${detail.name} template runs`}
        >
          <div style={{ gridColumn: "1 / -1", marginBottom: "0.25rem" }}>
            <span className="lp-eyebrow">How it runs</span>
          </div>
          {HOW_IT_RUNS.map((item) => (
            <div key={item.label} className="card" style={{ padding: "1.5rem" }}>
              <span className="eyebrow" style={{ color: item.color }}>
                {item.label}
              </span>
              <p
                style={{
                  color: "var(--text-muted)",
                  lineHeight: 1.65,
                  fontSize: "var(--text-sm)",
                  marginTop: "0.6rem",
                }}
              >
                {item.body}
              </p>
            </div>
          ))}
        </section>

        {related.length > 0 && (
          <section style={{ marginTop: "3.5rem" }} aria-label="Related templates">
            {/* Same-department peers first, then same-category fills, so the
                heading stays generic rather than overclaiming the department. */}
            <span className="lp-eyebrow">Related templates</span>
            <div className="tg-related-grid">
              {related.map((r) => (
                <Link key={r.slug} href={r.href} className="card tg-related-card">
                  <h3>{r.name}</h3>
                  <p>{r.pitchProse}</p>
                  <span className="lp-pill lp-pill--price tabular">
                    ${r.priceUsdc.toFixed(2)} / call suggested
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section
          style={{
            marginTop: "4rem",
            padding: "3rem",
            background: "var(--canvas-bg)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--hairline)",
            textAlign: "center",
          }}
        >
          <span className="lp-eyebrow">Start building</span>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              fontSize: "var(--text-h2)",
              marginTop: "0.75rem",
              marginBottom: "1rem",
            }}
          >
            Open {detail.name} in the studio
          </h2>
          <p
            style={{
              color: "var(--text-muted)",
              maxWidth: "44ch",
              marginInline: "auto",
              marginBottom: "1.75rem",
              lineHeight: 1.6,
            }}
          >
            The {detail.steps.length}-step flow arrives wired, with its suggested
            price loaded, and ready for a free builder preview. Make it yours,
            then launch with its public call state reported.
          </p>
          <Link
            href={`/build/new?template=${detail.slug}`}
            className="lp-btn lp-btn--primary"
          >
            Open this template →
          </Link>
          <div className="tg-detail-back">
            <Link href="/templates" className="lp-tpl-more-link">
              Browse all templates →
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
