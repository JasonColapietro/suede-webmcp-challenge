import type { CatalogEntry } from "@/lib/catalog";
import { slugify } from "@/lib/slug";

export interface DocsExampleDefinition {
  who: string;
  agentName: string;
  templateSlug: string;
  what: string;
}

export interface DocsExampleListing {
  href: string;
  name: string;
  priceUsdc: number;
  slug: string;
}

export interface ResolvedDocsExample extends DocsExampleDefinition {
  listing: DocsExampleListing | null;
}

export const DOCS_EXAMPLES: readonly DocsExampleDefinition[] = [
  {
    who: "A freelancer chasing late payments, as the owner",
    agentName: "Invoice Chaser",
    templateSlug: "invoice-chaser",
    what:
      "Built from the template and run as their own scheduled job, so it's their own free monthly token allowance covering it, not a per-call fee. It runs on its own every Monday and drafts a follow-up per invoice, polite the first week and firmer by the third.",
  },
  {
    who: "A legal-ops team, running its own copy",
    agentName: "Contract Red-Flag Scan",
    templateSlug: "contract-redflag-scan",
    what:
      "The team builds its own copy from the template and runs it in the studio as the owner, no wallet needed at normal volume. Paste a new vendor agreement in before it's routed to an attorney: every red flag ranked by severity, with a suggested redline for each.",
  },
  {
    who: "An e-commerce seller, running its own copy",
    agentName: "Listing Quality QA Gate",
    templateSlug: "listing-quality-qa",
    what:
      "The seller runs their own copy in the studio as the owner, not as a per-call buyer. Every new SKU gets checked before publish: a score from 0 to 100 and the exact fixes, the kind of gap that kills conversion or gets a listing suppressed.",
  },
  {
    who: "A CI bot, not a person, as the caller",
    agentName: "PR Diff Digest",
    templateSlug: "pr-diff-digest",
    what:
      "A GitHub Action posts the raw diff on every opened pull request, with no human in the loop, and a reviewer-ready summary comes back as the PR comment. The caller here is a bot, not someone logged into Suede.",
  },
  {
    who: "A support team, running its own copy",
    agentName: "Support Ticket Triage",
    templateSlug: "support-ticket-triage",
    what:
      "The team runs its own copy as the owner, not as a per-call buyer. Every inbound ticket is piped through the instant it lands: category, priority, the right queue, and a drafted first reply. The team's own reply still ships; this only drafts the starting point.",
  },
  {
    who: "One agent paying another agent, no humans involved",
    agentName: "Lead Qualifier",
    templateSlug: "lead-qualifier",
    what:
      "A sales-ops pipeline agent calls this for every inbound lead, pays in USDC over x402 automatically, and only routes leads above a score threshold to a rep. Machine calls machine, machine pays machine, no dashboard involved. This is the one example above where the caller genuinely needs a wallet.",
  },
];

function matchingListing(
  definition: DocsExampleDefinition,
  catalog: readonly CatalogEntry[],
): CatalogEntry | null {
  const normalizedName = slugify(definition.agentName);
  const candidates = catalog.filter(
    (entry) =>
      slugify(entry.name) === normalizedName ||
      entry.slug.startsWith(`${definition.templateSlug}-`),
  );

  return (
    candidates.sort(
      (a, b) => b.calls - a.calls || b.createdAt - a.createdAt,
    )[0] ?? null
  );
}

/**
 * Resolve examples against the authoritative public catalog. The sitemap and
 * this page both consume CatalogEntry.urls.public, so a docs link can never be
 * manufactured from a template name or a retired launch suffix.
 */
export function resolveDocsExamples(
  catalog: readonly CatalogEntry[],
): ResolvedDocsExample[] {
  return DOCS_EXAMPLES.map((definition) => {
    const match = matchingListing(definition, catalog);
    return {
      ...definition,
      listing: match
        ? {
            href: match.urls.public,
            name: match.name,
            priceUsdc: match.priceUsdc,
            slug: match.slug,
          }
        : null,
    };
  });
}
