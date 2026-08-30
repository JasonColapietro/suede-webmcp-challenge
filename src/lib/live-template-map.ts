/**
 * Maps template slugs to a genuinely-launched live /a/<slug> agent, so the
 * homepage's template cards can link to real proof-of-work instead of only
 * the small settled-service proof row.
 *
 * The match is structural, not fabricated: `uniqueSlug()` (src/lib/slug.ts)
 * always mints a launched agent's slug as `${slugify(flowName)}-${suffix}`.
 * When a visitor launches a template without renaming the flow, the live
 * agent's slug is therefore always `${template.slug}-<suffix>`. We only ever
 * link a template to an /a/<slug> page that actually matches that pattern —
 * a template with no matching live launch gets no link, rather than a guess.
 *
 * As of this writing no two of the 87 SEED_TEMPLATES slugs are a hyphenated
 * prefix of one another (verified separately), so this prefix match cannot
 * misattribute one template's live agent to a different template.
 */
import type { CatalogEntry } from "@/lib/catalog";
import { SEED_TEMPLATES } from "@/lib/templates";

export function buildLiveSlugByTemplate(
  catalog: readonly CatalogEntry[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const template of SEED_TEMPLATES) {
    const prefix = `${template.slug}-`;
    let best: CatalogEntry | null = null;
    for (const entry of catalog) {
      if (!entry.slug.startsWith(prefix)) continue;
      // Prefer real proof-of-work (nonzero calls); break ties by newest launch.
      if (
        best === null ||
        entry.calls > best.calls ||
        (entry.calls === best.calls && entry.createdAt > best.createdAt)
      ) {
        best = entry;
      }
    }
    if (best) map[template.slug] = best.slug;
  }
  return map;
}
