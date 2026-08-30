/**
 * The single machine-readable registry of x402 discovery venues.
 *
 * This replaces the hand-maintained `docs/distribution/*.md` playbook as the
 * source of truth for WHERE and HOW a launched agent gets discovered. Each
 * entry states its real mechanism honestly — most "indexes" have no self-serve
 * publish API, so the copy never promises a one-click publish that the venue
 * doesn't actually support.
 *
 * Pure data. Client-safe: no server imports, no Node APIs. The DiscoveryConsole
 * client component may import this file directly; every other value the console
 * needs (readiness, generated payloads, recorded listings) comes from the API
 * route instead.
 */

/**
 * How a venue actually accepts a listing:
 * - `auto`        — the venue indexes you on its own; there is nothing to submit.
 * - `push-github` — a GitHub PR or issue we can open programmatically (needs a token).
 * - `paid`        — submission costs money; blocked behind human payment approval.
 * - `manual`      — no public API; a human sends the generated draft to a maintainer.
 */
export type VenueMechanism = "auto" | "push-github" | "paid" | "manual";

export interface DiscoveryVenueGithub {
  /** owner/repo the PR or issue targets. */
  repo: string;
  kind: "pr" | "issue";
  /** README section a PR appends its line to (kind "pr" only). */
  section?: string;
  /** File a PR edits (kind "pr" only; defaults to README.md). */
  file?: string;
}

export interface DiscoveryVenue {
  id: string;
  name: string;
  url: string;
  mechanism: VenueMechanism;
  /** Honest one-liner shown in the UI — states exactly what the mechanism does. */
  status: string;
  /** True when submitting requires an x402-v2 payment (Satring). */
  requiresPaymentV2?: boolean;
  /** Listing fee in USDC, when the venue charges one. */
  costUsdc?: number;
  github?: DiscoveryVenueGithub;
}

export const DISCOVERY_VENUES: readonly DiscoveryVenue[] = [
  {
    id: "awesome-x402-xpaysh",
    name: "awesome-x402 (xpaysh)",
    url: "https://github.com/xpaysh/awesome-x402",
    mechanism: "push-github",
    status: "Opens a pull request to the community list.",
    github: {
      repo: "xpaysh/awesome-x402",
      kind: "pr",
      section: "Production Implementations",
      file: "README.md",
    },
  },
  {
    id: "awesome-x402-index",
    name: "awesome-x402 (x402-index)",
    url: "https://github.com/x402-index/awesome-x402",
    mechanism: "push-github",
    status: "Opens a pull request to the second curated list.",
    github: {
      repo: "x402-index/awesome-x402",
      kind: "pr",
      section: "Production Implementations",
      file: "README.md",
    },
  },
  {
    id: "x402-index-discovery",
    name: "x402-index Discovery Index",
    url: "https://github.com/x402-index/x402-discovery-index",
    mechanism: "push-github",
    status: "Files a listing issue. Maintainers verify within ~24h.",
    github: {
      repo: "x402-index/x402-discovery-index",
      kind: "issue",
    },
  },
  {
    id: "bazaar",
    name: "Coinbase Bazaar",
    url: "https://docs.cdp.coinbase.com/x402/seller/get-discovered",
    mechanism: "auto",
    status:
      "Declare Bazaar metadata and complete one paid call through the CDP Facilitator. No registration form.",
  },
  {
    id: "satring",
    name: "Satring",
    url: "https://satring.com",
    mechanism: "paid",
    requiresPaymentV2: true,
    costUsdc: 0.5,
    status: "Paid listing (0.50 USDC). Requires x402-v2 payment support.",
  },
  {
    id: "paysh",
    name: "pay.sh",
    url: "https://pay.sh",
    mechanism: "manual",
    status: "Provider YAML: send the generated spec to the maintainers.",
  },
  {
    id: "agentic-market",
    name: "Agentic.Market",
    url: "https://agentic.market",
    mechanism: "auto",
    status:
      "Indexes services automatically when the CDP Facilitator processes a payment with Bazaar discovery enabled. No manual registration.",
  },
] as const;

/** Look up a venue by id, or null when the id is unknown. */
export function getVenue(id: string): DiscoveryVenue | null {
  return DISCOVERY_VENUES.find((venue) => venue.id === id) ?? null;
}
