/**
 * Server-side derivations for the /agents directory shell. Every number the
 * storefront shows is computed here from the live catalog or the seeded
 * template list; nothing is hand-typed, so the shelf can never claim
 * inventory it does not have.
 */
import type { CatalogEntry } from "@/lib/catalog";
import type { TemplateSummary } from "@/components/landing/TemplateGallery";
import { buildTemplateSummaries } from "@/lib/template-summaries";
import { buildLiveSlugByTemplate } from "@/lib/live-template-map";

export interface DirectoryStats {
  /** Every catalog entry is live by construction (repo.listLiveAgents). */
  liveCount: number;
  /**
   * External machine calls across every live agent. These are calls made,
   * not calls settled: dry-runs and unsettled calls count here too.
   */
  totalCalls: number;
  /** Calls that actually settled on-chain (settled_at set). Never inflated by dry-runs. */
  totalSettled: number;
  /** Agents that also run themselves on a cron. */
  scheduledCount: number;
  /** Agents priced at zero. */
  freeCount: number;
  /** Cheapest nonzero per-call price, when any agent charges. */
  minPriceUsdc: number | null;
  /** Priciest nonzero per-call price, when any agent charges. */
  maxPriceUsdc: number | null;
}

export function deriveDirectoryStats(
  entries: readonly CatalogEntry[],
): DirectoryStats {
  let totalCalls = 0;
  let totalSettled = 0;
  let scheduledCount = 0;
  let freeCount = 0;
  let minPriceUsdc: number | null = null;
  let maxPriceUsdc: number | null = null;
  for (const entry of entries) {
    totalCalls += entry.calls;
    totalSettled += entry.settledCalls;
    if (entry.schedule) scheduledCount += 1;
    if (entry.priceUsdc === 0) {
      freeCount += 1;
    } else {
      minPriceUsdc = minPriceUsdc === null
        ? entry.priceUsdc
        : Math.min(minPriceUsdc, entry.priceUsdc);
      maxPriceUsdc = maxPriceUsdc === null
        ? entry.priceUsdc
        : Math.max(maxPriceUsdc, entry.priceUsdc);
    }
  }
  return {
    liveCount: entries.length,
    totalCalls,
    totalSettled,
    scheduledCount,
    freeCount,
    minPriceUsdc,
    maxPriceUsdc,
  };
}

/** "$0.008"-style USDC price with trailing noise trimmed ("$0.01", not "$0.010"). */
export function formatUsdc(value: number): string {
  const trimmed = value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `$${trimmed}`;
}

/** Below this many live listings the shelf backfills with labeled templates. */
export const SPARSE_DIRECTORY_THRESHOLD = 6;

/**
 * Launch-ready templates to back a sparse shelf, always labeled as blueprints
 * rather than live inventory. Templates that already have a genuine live
 * launch in this catalog are skipped so nothing appears twice, and templates
 * with a dedicated guide page lead because they are the most finished.
 */
export function pickLaunchableTemplates(
  entries: readonly CatalogEntry[],
  limit = 6,
): TemplateSummary[] {
  const liveByTemplate = buildLiveSlugByTemplate(entries);
  const launchable = buildTemplateSummaries().filter(
    (template) => !(template.slug in liveByTemplate),
  );
  const featured = launchable.filter((t) => t.featuredRoute !== null);
  const rest = launchable.filter((t) => t.featuredRoute === null);
  return [...featured, ...rest].slice(0, Math.max(0, limit));
}
