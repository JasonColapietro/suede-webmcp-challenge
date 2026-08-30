/**
 * Shared builder for the TemplateGallery's card data — derives the
 * category-filterable summary list from SEED_TEMPLATES so the homepage
 * (`/`) and the templates hub (`/templates`) never drift out of sync.
 */
import { SEED_TEMPLATES, type SeedTemplate } from "@/lib/templates";
import { COMPANY_TEMPLATES } from "@/lib/company/templates";
import { getNodeMeta } from "@/lib/flow/node-meta";
import { describeCron } from "@/lib/cron";
import { FEATURED_TEMPLATE_PAGES } from "@/lib/featured-templates";
import { isPublicTemplateMarketingAllowed } from "@/lib/marketing-holds";
import type { TemplateSummary } from "@/components/landing/TemplateGallery";

/** template slug → its dedicated /templates/<route> cluster page, if any. */
const FEATURED_ROUTE_BY_SLUG = new Map(
  FEATURED_TEMPLATE_PAGES.map((p) => [p.templateSlug, p.route]),
);

/** Node-group → category color, so template cards render from the real graphs. */
const GROUP_COLORS: Record<string, string> = {
  Triggers: "var(--violet)",
  "I/O": "var(--text-muted)",
  "Music & IP": "var(--registry-cyan)",
  "Docs & Data": "var(--registry-cyan)",
  "Comms & CRM": "var(--verified-emerald)",
  "Finance & Ops": "var(--amber)",
  "Dev & Infra": "var(--violet)",
  AI: "var(--primary)",
  Rails: "var(--verified-emerald)",
  Logic: "var(--amber)",
};

// Illustrative earnings frame for on-demand agents: a modest 50 calls/day.
const CALLS_PER_DAY = 50;

/**
 * Trailing price fragment most seed pitches carry ("…: $0.05 per lead." /
 * "… $0.06 a run."). Cards already state the price in a chip, so showing it
 * in the prose too says the same number twice (QA round-2 finding 8). The
 * seed pitches themselves stay untouched (they are snapshot-pinned and used
 * verbatim elsewhere); this is presentation-layer only.
 */
const PITCH_PRICE_TAIL = /[\s:,.]*\$\d+(?:\.\d+)?\s+(?:per|a)\s+([A-Za-z][A-Za-z-]*(?: [A-Za-z][A-Za-z-]*)?)\.?$/;

/**
 * Split a pitch into price-free prose plus the per-unit noun for the price
 * chip ("$0.05 / lead"). Pitches without a parseable price tail pass through
 * unchanged with a null unit (the chip then reads "/ call").
 */
export function splitPitchPrice(pitch: string): { prose: string; unit: string | null } {
  const match = pitch.match(PITCH_PRICE_TAIL);
  if (!match || match.index === undefined || match.index === 0) {
    return { prose: pitch, unit: null };
  }
  const prose = pitch.slice(0, match.index).trimEnd();
  return { prose: prose.endsWith(".") ? prose : `${prose}.`, unit: match[1] ?? null };
}

/** Public (marketing-allowed) slice of the seed catalog — the shared base list. */
function publicSeedTemplates(): SeedTemplate[] {
  return SEED_TEMPLATES.filter((t) => isPublicTemplateMarketingAllowed(t.slug));
}

function templateCadence(t: SeedTemplate): string | null {
  const scheduleNode = t.graph.nodes.find((n) => n.type === "schedule");
  const cron = typeof scheduleNode?.params.cron === "string" ? scheduleNode.params.cron : null;
  return cron ? describeCron(cron) : null;
}

/** "Core" = runs on the built-in nodes alone; otherwise it taps Suede's paid rails. */
function usesCoreNodesOnly(t: SeedTemplate): boolean {
  return t.graph.nodes.every((n) => !n.type.startsWith("suede."));
}

export function buildTemplateSummaries(): TemplateSummary[] {
  return publicSeedTemplates().map((t) => {
    const scheduleNode = t.graph.nodes.find((n) => n.type === "schedule");
    const coreNodes = usesCoreNodesOnly(t);
    const { prose, unit } = splitPitchPrice(t.pitch);
    // Only on-demand (paid-call) agents get a per-call earnings estimate; scheduled
    // ones are framed by their cadence pill instead.
    const monthly = scheduleNode
      ? null
      : Math.round(t.suggestedPriceUsdc * CALLS_PER_DAY * 30);
    return {
      slug: t.slug,
      name: t.name,
      blurb: prose,
      unit,
      whoPays: t.whoPays,
      price: t.suggestedPriceUsdc,
      monthly,
      coreNodes,
      cadence: templateCadence(t),
      category: t.category,
      department: t.department ?? null,
      nodeCount: t.graph.nodes.length,
      stepLabels: t.graph.nodes.map((n) => getNodeMeta(n.type)?.label ?? n.type),
      dots: t.graph.nodes.map(
        (n) => GROUP_COLORS[getNodeMeta(n.type)?.group ?? ""] ?? "var(--text-muted)",
      ),
      featuredRoute: FEATURED_ROUTE_BY_SLUG.get(t.slug) ?? null,
    };
  });
}

/** Derived headline numbers for the template surfaces — never hand-typed. */
export interface TemplateCatalogStats {
  /** Public agent templates (marketing holds excluded). */
  total: number;
  business: number;
  personal: number;
  creator: number;
  /** Business departments present in the catalog, with per-department counts. */
  departments: { name: string; count: number }[];
  /** Templates that run themselves on a cron. */
  scheduled: number;
  /** Templates triggered per paid call. */
  onDemand: number;
  minPriceUsdc: number;
  maxPriceUsdc: number;
  /** Company templates (multi-agent org charts) and their total staffed seats. */
  companyCount: number;
  companySeats: number;
}

export function buildTemplateCatalogStats(): TemplateCatalogStats {
  const templates = publicSeedTemplates();
  const deptCounts = new Map<string, number>();
  let scheduled = 0;
  for (const t of templates) {
    if (t.category === "business" && t.department) {
      deptCounts.set(t.department, (deptCounts.get(t.department) ?? 0) + 1);
    }
    if (t.graph.nodes.some((n) => n.type === "schedule")) scheduled += 1;
  }
  const prices = templates.map((t) => t.suggestedPriceUsdc);
  return {
    total: templates.length,
    business: templates.filter((t) => t.category === "business").length,
    personal: templates.filter((t) => t.category === "personal").length,
    creator: templates.filter((t) => t.category === "creator").length,
    departments: Array.from(deptCounts, ([name, count]) => ({ name, count })).sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    ),
    scheduled,
    onDemand: templates.length - scheduled,
    minPriceUsdc: prices.length > 0 ? Math.min(...prices) : 0,
    maxPriceUsdc: prices.length > 0 ? Math.max(...prices) : 0,
    companyCount: COMPANY_TEMPLATES.length,
    companySeats: COMPANY_TEMPLATES.reduce(
      (seats, company) =>
        seats + company.departments.reduce((n, d) => n + d.employees.length, 0),
      0,
    ),
  };
}

/** Card facts for the /templates featured grid, derived from the seed graphs. */
export interface FeaturedTemplateCard {
  route: string;
  slug: string;
  name: string;
  /** Price-free pitch prose — the card's chip carries the price. */
  pitch: string;
  priceUsdc: number;
  /** Per-unit noun for the price chip ("lead"), when the pitch names one. */
  unit: string | null;
  coreNodes: boolean;
  cadence: string | null;
  nodeCount: number;
}

export function buildFeaturedTemplateCards(): FeaturedTemplateCard[] {
  const bySlug = new Map(publicSeedTemplates().map((t) => [t.slug, t]));
  return FEATURED_TEMPLATE_PAGES.flatMap((page) => {
    const t = bySlug.get(page.templateSlug);
    if (!t) return [];
    const { prose, unit } = splitPitchPrice(t.pitch);
    return [
      {
        route: page.route,
        slug: t.slug,
        name: t.name,
        pitch: prose,
        priceUsdc: t.suggestedPriceUsdc,
        unit,
        coreNodes: usesCoreNodesOnly(t),
        cadence: templateCadence(t),
        nodeCount: t.graph.nodes.length,
      },
    ];
  });
}

/** Everything a /templates/<slug> detail page needs, derived from the seed graph. */
export interface TemplateDetail {
  slug: string;
  name: string;
  pitch: string;
  /** Pitch with any trailing price fragment stripped (the facts band owns the price). */
  pitchProse: string;
  /** Per-unit noun the pitch prices by ("lead"), when it names one. */
  unit: string | null;
  description: string;
  whoPays: string;
  priceUsdc: number;
  cadence: string | null;
  category: "business" | "personal" | "creator";
  department: string | null;
  coreNodes: boolean;
  steps: { label: string; color: string; group: string | null }[];
}

export function getTemplateDetail(slug: string): TemplateDetail | null {
  const t = publicSeedTemplates().find((candidate) => candidate.slug === slug);
  if (!t) return null;
  const { prose, unit } = splitPitchPrice(t.pitch);
  return {
    slug: t.slug,
    name: t.name,
    pitch: t.pitch,
    pitchProse: prose,
    unit,
    description: t.description,
    whoPays: t.whoPays,
    priceUsdc: t.suggestedPriceUsdc,
    cadence: templateCadence(t),
    category: t.category,
    department: t.department ?? null,
    coreNodes: usesCoreNodesOnly(t),
    steps: t.graph.nodes.map((n) => {
      const meta = getNodeMeta(n.type);
      return {
        label: meta?.label ?? n.type,
        color: GROUP_COLORS[meta?.group ?? ""] ?? "var(--text-muted)",
        group: meta?.group ?? null,
      };
    }),
  };
}

/**
 * Slugs served by the derived /templates/[slug] detail route: every
 * marketing-allowed template EXCEPT those whose URL segment is already
 * claimed by a hand-authored static directory (Next gives static dirs
 * precedence, so the dynamic route must never generate a colliding page).
 */
export function listTemplateDetailPageSlugs(): string[] {
  const staticSegments = new Set(FEATURED_TEMPLATE_PAGES.map((p) => p.route));
  return publicSeedTemplates()
    .map((t) => t.slug)
    .filter((slug) => !staticSegments.has(slug));
}

/** Compact, alphabetized entries for the server-rendered guide index. */
export function buildTemplateDetailIndex(): Array<Pick<TemplateDetail, "slug" | "name">> {
  return listTemplateDetailPageSlugs()
    .map((slug) => getTemplateDetail(slug))
    .filter((detail): detail is TemplateDetail => detail !== null)
    .map(({ slug, name }) => ({ slug, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A related-template card on a detail page: name, price-free pitch, link. */
export interface RelatedTemplateCard {
  slug: string;
  name: string;
  pitchProse: string;
  priceUsdc: number;
  /** /templates/<segment> to link (the hand-authored route when one exists). */
  href: string;
}

/**
 * Related templates for a detail page: same business department first, falling
 * back to same category, in catalog order, never the template itself.
 */
export function getRelatedTemplates(slug: string, limit = 3): RelatedTemplateCard[] {
  const templates = publicSeedTemplates();
  const self = templates.find((t) => t.slug === slug);
  if (!self) return [];
  const sameDept = self.department
    ? templates.filter((t) => t.slug !== slug && t.department === self.department)
    : [];
  const sameCategory = templates.filter(
    (t) => t.slug !== slug && t.category === self.category && !sameDept.includes(t),
  );
  return [...sameDept, ...sameCategory].slice(0, limit).map((t) => ({
    slug: t.slug,
    name: t.name,
    pitchProse: splitPitchPrice(t.pitch).prose,
    priceUsdc: t.suggestedPriceUsdc,
    href: `/templates/${FEATURED_ROUTE_BY_SLUG.get(t.slug) ?? t.slug}`,
  }));
}
