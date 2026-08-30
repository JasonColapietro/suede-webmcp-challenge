/**
 * Shared facts band for /templates/<slug> detail pages: the flow the template
 * ships (one chip per wired step, colored by node group), its commercial facts
 * (per-call price, cadence, category), and the launch CTA. Everything renders
 * from the seed graph via getTemplateDetail — nothing here is hand-typed, so
 * the pages can never drift from the templates they describe.
 */
import Link from "next/link";
import { Fragment } from "react";
import { getTemplateDetail } from "@/lib/template-summaries";
import "./template-pages.css";

export default function TemplateFacts({ slug }: { slug: string }): React.JSX.Element | null {
  const detail = getTemplateDetail(slug);
  if (!detail) return null;
  const categoryLabel =
    detail.department ?? detail.category.charAt(0).toUpperCase() + detail.category.slice(1);
  return (
    <section className="tg-facts" aria-label={`${detail.name} template facts`}>
      <span className="tg-facts-eyebrow">The flow this template ships</span>
      <div className="tg-facts-flow" role="list">
        {detail.steps.map((step, i) => (
          <Fragment key={`${step.label}-${i}`}>
            <span className="tg-step-chip" role="listitem">
              <span className="tg-step-dot" style={{ background: step.color }} aria-hidden="true" />
              {step.label}
            </span>
            {i < detail.steps.length - 1 && (
              <span className="tg-step-arrow" aria-hidden="true">
                ›
              </span>
            )}
          </Fragment>
        ))}
      </div>
      {/* One fact vocabulary sitewide: state, then schedule, then price,
          then the neutral facts — the same order the /start quick-pick rows
          speak, so a visitor reads one chip language across surfaces. */}
      <div className="tg-facts-meta">
        <span
          className={`lp-tpl-tag lp-tpl-tag--${detail.coreNodes ? "core" : "rails"}`}
          title={
            detail.coreNodes
              ? "Uses built-in nodes. External actions require a reviewed Connection before live deployment."
              : "Taps Suede's paid media and workflow endpoints."
          }
        >
          {detail.coreNodes ? "Core" : "Suede rails"}
        </span>
        {detail.cadence && (
          <span className="lp-pill lp-pill--sched tabular">runs {detail.cadence}</span>
        )}
        <span className="lp-pill lp-pill--price tabular">
          ${detail.priceUsdc.toFixed(2)} / call
        </span>
        <span className="lp-pill tabular">
          {detail.steps.length} {detail.steps.length === 1 ? "step" : "steps"} wired
        </span>
        <span className="lp-pill">{categoryLabel}</span>
      </div>
      <p className="tg-facts-who">
        <b>Who pays:</b> {detail.whoPays}
      </p>
      <div className="tg-facts-cta">
        <Link href={`/build/new?template=${detail.slug}`} className="lp-btn lp-btn--primary">
          Open this template →
        </Link>
      </div>
    </section>
  );
}
