/**
 * Client-safe catalog of the agents a website can become.
 *
 * Split out from blueprints.ts for the same reason node-meta.ts is split from
 * registry.ts (see AGENTS.md): the picker on /from-website needs these labels
 * and prices in the browser bundle, while the compiler next door imports the
 * manifest schema and must never be pulled client-side. Pure data — no
 * imports, no node builtins.
 */

export const SITE_AGENT_BLUEPRINTS = ["concierge", "lead-qualifier", "brand-writer"] as const;
export type SiteAgentBlueprint = (typeof SITE_AGENT_BLUEPRINTS)[number];

/**
 * Graph-meta markers for site-drafted agents. The client stamps both at
 * launch; the catalog gate (lib/catalog.ts) keeps agents carrying the
 * template prefix unlisted until a site_verifications row exists for
 * (owner, siteHost). Pure strings so both sides of the bundle can share
 * them without dragging node builtins across the client/server split.
 */
export const SITE_AGENT_TEMPLATE_PREFIX = "site-agent:";
export const SITE_HOST_META_KEY = "siteHost";

export const DEFAULT_BLUEPRINT: SiteAgentBlueprint = "concierge";

export interface BlueprintMeta {
  readonly id: SiteAgentBlueprint;
  readonly label: string;
  /** One line, shown on the picker card. */
  readonly pitch: string;
  /** Who pays to call it and why. */
  readonly whoPays: string;
  /**
   * The blueprint's MINIMUM per-call price — the "From $X" shown on cards.
   * The actual drafted price is derived per site from what a call costs to
   * run (the crawled text rides in the system prompt, so cost scales with
   * site size; see lib/site/pricing.ts) and is never below this or below
   * the cost floor. A full six-page read typically drafts around $0.13.
   */
  readonly suggestedPriceUsdc: number;
}

export const BLUEPRINT_META: Readonly<Record<SiteAgentBlueprint, BlueprintMeta>> = {
  concierge: {
    id: "concierge",
    label: "Answer questions about the business",
    pitch: "Answers anything your site already answers, in your words, and says so when your site doesn't.",
    whoPays: "Support tools, shopping agents, and directories that need a straight answer about you.",
    suggestedPriceUsdc: 0.05,
  },
  "lead-qualifier": {
    id: "lead-qualifier",
    label: "Qualify inbound leads",
    pitch: "Scores an inbound lead against what you actually sell, with a reason and a next step.",
    whoPays: "CRMs, form handlers, and sales agents routing leads before a human sees them.",
    suggestedPriceUsdc: 0.08,
  },
  "brand-writer": {
    id: "brand-writer",
    label: "Write in the brand's voice",
    pitch: "Drafts copy that sounds like your site, using only claims your site already makes.",
    whoPays: "Marketing agents and content tools that need on-brand copy without a style call.",
    suggestedPriceUsdc: 0.06,
  },
};

export const BLUEPRINT_LIST: readonly BlueprintMeta[] = SITE_AGENT_BLUEPRINTS.map(
  (id) => BLUEPRINT_META[id],
);

export function isSiteAgentBlueprint(value: string): value is SiteAgentBlueprint {
  return (SITE_AGENT_BLUEPRINTS as readonly string[]).includes(value);
}
