export type EditorialVisualId =
  | "company-as-software"
  | "seat-flow-service"
  | "website-grounded-service"
  | "verified-product-inventory"
  | "draft-live-control"
  | "staff-company-sell-work";

export interface EditorialVisual {
  readonly id: EditorialVisualId;
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  readonly evidenceLabel: string;
  readonly caption: string;
  readonly sourceFilename: string;
  /** Where the label links when the visual is a checkable receipt. */
  readonly href?: string;
}

export const EDITORIAL_VISUALS: Readonly<Record<EditorialVisualId, EditorialVisual>> = {
  "company-as-software": {
    id: "company-as-software",
    src: "/creative/editorial-proof/company-as-software.jpg",
    width: 1200,
    height: 630,
    alt: "Agent Studio company view with a CEO, department leads, live service seats, and their reporting lines.",
    evidenceLabel: "Company view",
    caption: "Every seat opens into its flow.",
    sourceFilename: "Company as Software hero.jpg",
  },
  "seat-flow-service": {
    id: "seat-flow-service",
    src: "/creative/editorial-proof/seat-flow-service.jpg",
    width: 1200,
    height: 630,
    alt: "Three connected Agent Studio views showing one agent as an org-chart seat, a workflow, and a paid service endpoint.",
    evidenceLabel: "Seat, flow, service",
    caption: "The same agent as a seat, a flow, and a service.",
    sourceFilename: "Seat to flow to service.jpg",
  },
  "website-grounded-service": {
    id: "website-grounded-service",
    src: "/creative/editorial-proof/website-grounded-service.jpg",
    width: 1200,
    height: 630,
    alt: "Agent Studio website import review with bounded public-page reading, service choices, and per-call price controls.",
    evidenceLabel: "Website import",
    caption: "The pages it read, listed in the draft.",
    sourceFilename: "Website to grounded service.jpg",
  },
  "verified-product-inventory": {
    id: "verified-product-inventory",
    src: "/creative/editorial-proof/verified-product-inventory.jpg",
    width: 1200,
    height: 630,
    alt: "Dated Agent Studio inventory snapshot listing workflow templates, canonical node types, company starters, and priced public services.",
    evidenceLabel: "Snapshot · July 28, 2026",
    caption: "The catalog as it stood in July.",
    sourceFilename: "Verified product inventory.jpg",
    href: "/agents",
  },
  "draft-live-control": {
    id: "draft-live-control",
    src: "/creative/editorial-proof/draft-live-control.jpg",
    width: 1200,
    height: 630,
    alt: "Agent Studio draft workflow and public service screens connected by dry-run, version, promote, and service controls.",
    evidenceLabel: "Draft to live",
    caption: "Draft, test, and live are separate switches.",
    sourceFilename: "Draft to Live control.jpg",
  },
  "staff-company-sell-work": {
    id: "staff-company-sell-work",
    src: "/creative/editorial-proof/staff-company-sell-work.jpg",
    width: 1080,
    height: 1080,
    alt: "Agent Studio company org chart showing a CEO and specialist leads inside a reviewable operating view.",
    evidenceLabel: "Company view",
    caption: "Staff the company. Sell the work.",
    sourceFilename: "Staff the company. Sell the work.jpg",
  },
};

interface RouteRule {
  readonly prefixes: readonly string[];
  readonly visualId: EditorialVisualId;
}

const ROUTE_RULES: readonly RouteRule[] = [
  { prefixes: ["/from-website"], visualId: "website-grounded-service" },
  {
    prefixes: ["/launch", "/docs/launching", "/docs/reliability", "/security", "/runs"],
    visualId: "draft-live-control",
  },
  {
    prefixes: ["/pricing", "/agents", "/docs/nodes", "/rankings", "/status"],
    visualId: "verified-product-inventory",
  },
  {
    prefixes: ["/founder", "/about", "/contact", "/articles", "/firm", "/fit"],
    visualId: "staff-company-sell-work",
  },
  { prefixes: ["/company"], visualId: "company-as-software" },
] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function getEditorialVisualForPath(pathname: string | null | undefined): EditorialVisual {
  const cleanPath = pathname?.split(/[?#]/, 1)[0] || "/";
  const rule = ROUTE_RULES.find((candidate) =>
    candidate.prefixes.some((prefix) => matchesPrefix(cleanPath, prefix)),
  );
  return EDITORIAL_VISUALS[rule?.visualId ?? "seat-flow-service"];
}
