/**
 * Docs navigation data — the single source of truth for the docs shell.
 *
 * DOCS_SECTIONS drives the sidebar (grouped, with the current page
 * highlighted); DOCS_READING_PATH drives the prev/next pager at the foot of
 * every page. Pure data: safe to import from client and server components.
 */

export interface DocsNavPage {
  readonly href: string;
  readonly label: string;
  /** One line shown in the pager cards and index grid. */
  readonly description: string;
}

export interface DocsNavSection {
  readonly title: string;
  readonly pages: readonly DocsNavPage[];
}

const PAGE = {
  reference: {
    href: "/docs",
    label: "Quick reference",
    description: "Quickstarts, the SDK surface, and the endpoint price list on one page.",
  },
  overview: {
    href: "/docs/overview",
    label: "Overview",
    description: "What Agent Studio is: canvas, contract, engine, runtime, and what it is not.",
  },
  examples: {
    href: "/docs/examples",
    label: "Examples",
    description: "Six real workflow patterns, from invoice chasing to one agent paying another.",
  },
  buildingFlows: {
    href: "/docs/building-flows",
    label: "Building flows",
    description: "Nodes, edges, and testing: from a blank canvas to a working agent.",
  },
  nodes: {
    href: "/docs/nodes",
    label: "Node reference",
    description: "Every node in the catalog: group, dry-run behavior, effects, and cost.",
  },
  architecture: {
    href: "/docs/architecture",
    label: "Architecture",
    description: "The machine under the canvas: engine semantics, versioning, and the runtime.",
  },
  launching: {
    href: "/docs/launching",
    label: "Launching",
    description: "Publishing as an x402 endpoint: validation, the one-time webhook secret, stable slugs.",
  },
  payments: {
    href: "/docs/payments",
    label: "Payments",
    description: "The full money model: your costs, the caller's price, payouts, and the caveats.",
  },
  api: {
    href: "/docs/api",
    label: "API for callers",
    description: "Discovery, the run endpoint, the 402 handshake, and every status code.",
  },
  mcp: {
    href: "/docs/mcp",
    label: "MCP endpoint",
    description: "Every published agent as an MCP tool, billed to pre-funded workspace credit.",
  },
  reliability: {
    href: "/docs/reliability",
    label: "Reliability",
    description: "What the status surface measures and what we refuse to fabricate.",
  },
  troubleshooting: {
    href: "/docs/troubleshooting",
    label: "Troubleshooting",
    description: "Symptom, cause, fix for launch, calling, run, and webhook failures.",
  },
  faq: {
    href: "/docs/faq",
    label: "FAQ",
    description: "Short, direct answers on wallets, costs, privacy, and failure behavior.",
  },
} as const satisfies Record<string, DocsNavPage>;

export const DOCS_SECTIONS: readonly DocsNavSection[] = [
  { title: "Start here", pages: [PAGE.reference, PAGE.overview, PAGE.examples] },
  { title: "Build", pages: [PAGE.buildingFlows, PAGE.nodes, PAGE.architecture] },
  { title: "Sell", pages: [PAGE.launching, PAGE.payments] },
  { title: "Call", pages: [PAGE.api, PAGE.mcp, PAGE.reliability] },
  { title: "Help", pages: [PAGE.troubleshooting, PAGE.faq] },
];

/** The linear reading order the prev/next pager walks. */
export const DOCS_READING_PATH: readonly DocsNavPage[] = [
  // Order matches the sidebar's "Start here" grouping below, so the prev/next
  // pager never disagrees with the section a reader is sitting in.
  PAGE.reference,
  PAGE.overview,
  PAGE.examples,
  PAGE.buildingFlows,
  PAGE.nodes,
  PAGE.architecture,
  PAGE.launching,
  PAGE.payments,
  PAGE.api,
  PAGE.mcp,
  PAGE.examples,
  PAGE.reliability,
  PAGE.troubleshooting,
  PAGE.faq,
];

export function findDocsPage(pathname: string): DocsNavPage | undefined {
  return DOCS_READING_PATH.find((page) => page.href === pathname);
}
