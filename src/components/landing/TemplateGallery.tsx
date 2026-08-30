"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { trackEvent } from "@/lib/analytics";
import "./template-gallery.css";

export type TemplateSummary = {
  slug: string;
  name: string;
  blurb: string;
  whoPays: string;
  price: number;
  /** Per-unit noun for the price chip ("lead" → "$0.05 / lead"); "call" when absent. */
  unit?: string | null;
  monthly: number | null;
  coreNodes: boolean;
  cadence: string | null;
  dots: string[];
  category: "business" | "personal" | "creator";
  /** Department sub-classification within "business", if tagged. */
  department: string | null;
  /** How many wired steps the template's flow graph ships with. */
  nodeCount?: number;
  /** Human labels for each step, parallel to `dots`. */
  stepLabels?: string[];
  /** Route segment of this template's dedicated /templates/<route> page, if any. */
  featuredRoute: string | null;
};

type CategoryFilter = "all" | "business" | "personal" | "creator";
type DepartmentFilter = "all" | string;

const CATS: { key: CategoryFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "business", label: "Business" },
  { key: "personal", label: "Personal" },
  { key: "creator", label: "Creator" },
];

const CATEGORY_KEYS = new Set<string>(["business", "personal", "creator"]);

/** URL-hash slug for a department name ("Finance" → "dept-finance"). */
function deptHash(department: string): string {
  return `dept-${department.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** The filter pair a URL hash addresses, when it addresses one. */
type HashSelection = { category: CategoryFilter; department: DepartmentFilter };

/**
 * Deep-linkable filters: #business / #personal / #creator selects a category,
 * #dept-<name> selects a business department. #all-templates is the plain
 * scroll anchor on /templates and never touches the filter.
 */
function parseHashSelection(
  hash: string,
  departments: string[],
): HashSelection | null {
  const raw = hash.replace(/^#/, "").toLowerCase();
  if (!raw || raw === "all-templates") return null;
  if (raw === "all") return { category: "all", department: "all" };
  if (CATEGORY_KEYS.has(raw)) {
    return { category: raw as CategoryFilter, department: "all" };
  }
  if (raw.startsWith("dept-")) {
    const match = departments.find((dept) => deptHash(dept) === raw);
    if (match) return { category: "business", department: match };
  }
  return null;
}

/** Subscribe to hash changes so server-rendered anchor rails drive the filter. */
function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const getHashSnapshot = (): string => window.location.hash;
const getServerHashSnapshot = (): string => "";

const PAGE_SIZE = 12;

export default function TemplateGallery({
  templates,
  liveSlugByTemplate = {},
}: {
  templates: TemplateSummary[];
  /** template slug → a matching live /a/<slug> agent, when one has been launched. */
  liveSlugByTemplate?: Record<string, string>;
}): React.JSX.Element {
  const [selection, setSelection] = useState<HashSelection | null>(null);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const hash = useSyncExternalStore(subscribeToHash, getHashSnapshot, getServerHashSnapshot);
  const [seenHash, setSeenHash] = useState(hash);
  if (hash !== seenHash) {
    // A new deep link arrived (anchor rail click, back/forward): let the hash
    // win over any prior chip selection and restart pagination.
    setSeenHash(hash);
    setSelection(null);
    setVisibleCount(PAGE_SIZE);
  }
  const departments = useMemo(() => {
    const found = new Set<string>();
    for (const t of templates) {
      if (t.category === "business" && t.department) found.add(t.department);
    }
    return Array.from(found).sort((a, b) => a.localeCompare(b));
  }, [templates]);
  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      all: templates.length,
      business: 0,
      personal: 0,
      creator: 0,
    };
    for (const t of templates) counts[t.category] += 1;
    return counts;
  }, [templates]);
  const departmentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of templates) {
      if (t.category === "business" && t.department) {
        counts.set(t.department, (counts.get(t.department) ?? 0) + 1);
      }
    }
    return counts;
  }, [templates]);

  const hashSelection = useMemo(
    () => parseHashSelection(hash, departments),
    [hash, departments],
  );
  const active: CategoryFilter = selection?.category ?? hashSelection?.category ?? "all";
  const activeDept: DepartmentFilter =
    selection?.department ?? hashSelection?.department ?? "all";

  /** Chip click: apply the filter, restart pagination, mirror it into the URL. */
  const applySelection = (next: HashSelection, hashKey: string | null): void => {
    setSelection(next);
    setVisibleCount(PAGE_SIZE);
    const base = window.location.pathname + window.location.search;
    const nextHash = hashKey ? `#${hashKey}` : "";
    window.history.replaceState(null, "", base + nextHash);
    setSeenHash(nextHash);
  };
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return templates.filter((template) => {
      if (active !== "all" && template.category !== active) return false;
      if (active === "business" && activeDept !== "all" && template.department !== activeDept) return false;
      if (!normalizedQuery) return true;
      return [template.name, template.blurb, template.whoPays, template.category]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [active, activeDept, query, templates]);
  const visible = filtered.slice(0, visibleCount);
  const resetFilters = (): void => {
    setQuery("");
    applySelection({ category: "all", department: "all" }, null);
  };

  return (
    <>
      <div className="lp-catalog-controls">
        <label className="lp-catalog-search">
          <span className="sr-only">Search templates</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setVisibleCount(PAGE_SIZE);
            }}
            placeholder="Search templates"
            autoComplete="off"
          />
        </label>
        <fieldset className="lp-cat-fieldset">
          <legend className="sr-only">Filter templates by category</legend>
          <div className="lp-cat-chips">
            {CATS.map((c) => (
              <button
                key={c.key}
                type="button"
                className="lp-cat-chip"
                data-active={active === c.key ? "true" : "false"}
                aria-pressed={active === c.key}
                onClick={() =>
                  applySelection(
                    { category: c.key, department: "all" },
                    c.key === "all" ? null : c.key,
                  )
                }
              >
                {c.label}
                <span className="tg-chip-count tabular" aria-hidden="true">
                  {categoryCounts[c.key]}
                </span>
                <span className="sr-only">{categoryCounts[c.key]} templates</span>
              </button>
            ))}
          </div>
        </fieldset>
        {active === "business" && departments.length > 0 && (
          <fieldset className="lp-cat-fieldset">
            <legend className="sr-only">Filter business templates by department</legend>
            <div className="lp-cat-chips lp-cat-chips--dept">
              <button
                type="button"
                className="lp-cat-chip lp-cat-chip--dept"
                data-active={activeDept === "all" ? "true" : "false"}
                aria-pressed={activeDept === "all"}
                onClick={() =>
                  applySelection({ category: "business", department: "all" }, "business")
                }
              >
                All departments
              </button>
              {departments.map((dept) => (
                <button
                  key={dept}
                  type="button"
                  className="lp-cat-chip lp-cat-chip--dept"
                  data-active={activeDept === dept ? "true" : "false"}
                  aria-pressed={activeDept === dept}
                  onClick={() =>
                    applySelection(
                      { category: "business", department: dept },
                      deptHash(dept),
                    )
                  }
                >
                  {dept}
                  <span className="tg-chip-count tabular" aria-hidden="true">
                    {departmentCounts.get(dept) ?? 0}
                  </span>
                  <span className="sr-only">
                    {departmentCounts.get(dept) ?? 0} templates
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
        )}
      </div>
      <p className="lp-filter-summary" role="status" aria-live="polite">
        Showing {Math.min(visibleCount, filtered.length)} of {filtered.length}{" "}
        {filtered.length === 1 ? "template" : "templates"}.
      </p>
      <div className="lp-templates">
        {visible.map((t) => {
          const liveSlug = liveSlugByTemplate[t.slug];
          return (
            <div key={t.slug} className="lp-tpl-cell">
              <Link
                href={`/build/new?template=${t.slug}`}
                className="lp-tpl"
                onClick={() => trackEvent("template_viewed", { slug: t.slug, category: t.category })}
              >
                <div className="lp-tpl-head">
                  <div
                    className="lp-tpl-flow"
                    title={t.stepLabels?.join(" › ")}
                    role="img"
                    aria-label={
                      t.stepLabels && t.stepLabels.length > 0
                        ? `Flow: ${t.stepLabels.join(", then ")}`
                        : "Flow steps"
                    }
                  >
                    {t.dots.map((d, i) => (
                      <span
                        key={i}
                        style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                      >
                        <span className="lp-tpl-dot" style={{ ["--d" as string]: d }} />
                        {i < t.dots.length - 1 && <span className="lp-tpl-arrow">›</span>}
                      </span>
                    ))}
                  </div>
                  <span
                    className={`lp-tpl-tag lp-tpl-tag--${t.coreNodes ? "core" : "rails"}`}
                    title={
                      t.coreNodes
                        ? "Uses built-in nodes. External actions require a reviewed Connection before live deployment."
                        : "Taps Suede's paid endpoints (audio, rights, registry)."
                    }
                  >
                    {t.coreNodes ? "Core" : "Suede rails"}
                  </span>
                </div>
                <h3>{t.name}</h3>
                <p>{t.blurb}</p>
                {/* The dot strip above is a shape; this spells the same chain
                    out in words. aria-hidden because that strip's accessible
                    name already reads the steps in order. */}
                {t.stepLabels && t.stepLabels.length > 0 && (
                  <p className="tg-tpl-steps" aria-hidden="true">
                    {t.stepLabels.join(" › ")}
                  </p>
                )}
                <p className="lp-tpl-who">
                  <span className="lp-tpl-who-k">Who pays</span> {t.whoPays}
                </p>
                <div className="lp-dir-meta" style={{ margin: "0.5rem 0 0.7rem" }}>
                  <span className="lp-pill lp-pill--price tabular">
                    ${t.price.toFixed(2)} / {t.unit ?? "call"}
                  </span>
                  {typeof t.nodeCount === "number" && (
                    <span
                      className="lp-pill tg-pill-steps tabular"
                      title={t.stepLabels?.join(" › ")}
                    >
                      {t.nodeCount} {t.nodeCount === 1 ? "step" : "steps"}
                    </span>
                  )}
                  {t.cadence && (
                    <span className="lp-pill lp-pill--sched tabular">runs {t.cadence}</span>
                  )}
                  {t.monthly !== null && (
                    <span className="lp-tpl-est tabular" title="Illustrative: price × 50 calls/day × 30 days.">
                      ~${t.monthly.toLocaleString()}/mo est. at 50/day
                    </span>
                  )}
                </div>
                <span className="lp-tpl-go">Open this template →</span>
              </Link>
              <div className="lp-tpl-more">
                {t.featuredRoute ? (
                  <Link href={`/templates/${t.featuredRoute}`} className="lp-tpl-more-link">
                    Read the guide →
                  </Link>
                ) : (
                  <Link href={`/templates/${t.slug}`} className="lp-tpl-more-link">
                    Details →
                  </Link>
                )}
                {liveSlug && (
                  <Link href={`/a/${liveSlug}`} className="lp-tpl-more-link">
                    See it running →
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {filtered.length === 0 ? (
        <div className="lp-empty">
          {templates.length === 0 ? (
            <>
              <b>No templates are available yet.</b>
              Start from a blank flow while the catalog is empty.
            </>
          ) : (
            <>
              <b>No templates match this search.</b>
              Try another phrase or reset the category filter.
              <div style={{ marginTop: "1.1rem" }}>
                <button type="button" className="lp-btn lp-btn--ghost" onClick={resetFilters}>
                  Clear search and filters
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
      {visible.length < filtered.length ? (
        <div className="lp-load-more">
          <button
            type="button"
            className="lp-btn lp-btn--ghost lp-btn--sm"
            onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
          >
            Show {Math.min(PAGE_SIZE, filtered.length - visible.length)} more
          </button>
        </div>
      ) : null}
    </>
  );
}
