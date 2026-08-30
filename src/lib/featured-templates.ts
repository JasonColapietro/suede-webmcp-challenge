/**
 * The template slugs that also have a dedicated long-form /templates/<route>
 * landing page (SEO cluster pages) — see src/app/templates/<route>/page.tsx.
 * Shared by the template gallery (to link cards → their cluster page) and
 * tests/templates.test.ts (to assert the mapping never drifts from the
 * underlying SEED_TEMPLATES slugs), so the two never fall out of sync.
 */
export const FEATURED_TEMPLATE_PAGES: { route: string; templateSlug: string }[] = [
  // Order is display order on the templates hub: lead with the universal
  // business jobs a first-time visitor recognizes; Agentix Rebuilder assumes
  // the visitor already knows the grader, so it sits later in the row.
  { route: "lead-qualifier", templateSlug: "lead-qualifier" },
  { route: "competitor-tracker", templateSlug: "competitor-tracker" },
  { route: "review-responder", templateSlug: "review-responder" },
  { route: "invoice-chaser", templateSlug: "invoice-chaser" },
  { route: "meeting-prep", templateSlug: "meeting-prep" },
  { route: "grade-rebuilder", templateSlug: "grade-rebuilder" },
];
