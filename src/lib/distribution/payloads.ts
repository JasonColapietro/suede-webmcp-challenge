/**
 * Generated submission assets for the discovery venues.
 *
 * Everything here is built from LIVE `buildCatalog()` data (slug, price, real
 * `payTo`) so a generated payload never drifts from what the agent actually
 * advertises — the exact failure mode of the old hand-maintained
 * `docs/distribution/*.md` drafts, which hardcoded two example agents and a
 * zero-address `payTo`. No claim about listing status is ever manufactured
 * here: counts, prices, and names come from the catalog the studio is really
 * serving.
 *
 * Server-only. This file reads `SITE_URL` and operates on catalog entries; it
 * must never be imported into a client component. The DiscoveryConsole gets
 * these strings from the API route, not by importing this module.
 */
import type { CatalogEntry } from "../catalog";
import { ZERO_ADDRESS } from "../payout";
import { SITE_URL } from "../site";
import {
  USDC_TOKEN_ADDRESS,
  X402_FACILITATOR_NETWORK,
  X402_PROTOCOL_VERSION,
  X402_SCHEME,
} from "../rails/x402-verify";

/** Legacy CAIP-style label some venues still key on. The wire network is {@link X402_FACILITATOR_NETWORK}. */
const BASE_MAINNET_LABEL = "base-mainnet";

/** Studio-level maintainer handle used in outreach copy. */
const MAINTAINER = "@JasonColapietro";

/**
 * Thrown when a submission asset would embed the zero address as `payTo`.
 * Submitting a listing with no real payout wallet would route callers' USDC to
 * the burn address, so the builders refuse rather than publish it. The UI reads
 * the `code` and tells the owner to add a payout wallet first.
 */
export class NoPayoutWalletError extends Error {
  public readonly code = "NO_PAYOUT_WALLET" as const;

  constructor(message = "Add a payout wallet before submitting.") {
    super(message);
    this.name = "NoPayoutWalletError";
  }
}

/** True when an entry has no real payout wallet saved (routes would burn). */
export function hasPayoutWallet(entry: CatalogEntry): boolean {
  return entry.payTo.toLowerCase() !== ZERO_ADDRESS.toLowerCase();
}

function requirePayoutWallet(entry: CatalogEntry): void {
  if (!hasPayoutWallet(entry)) throw new NoPayoutWalletError();
}

function absolute(path: string): string {
  return path.startsWith("http") ? path : `${SITE_URL}${path}`;
}

/** Studio-level, agent-independent identity every draft shares. */
export interface ServiceDescriptor {
  name: string;
  url: string;
  description: string;
  site: string;
  discoveryUrl: string;
  catalogUrl: string;
  protocol: "x402";
  x402Version: number;
  network: string;
  asset: string;
  scheme: string;
  maintainer: string;
}

export function buildServiceDescriptor(): ServiceDescriptor {
  return {
    name: "Suede Agent Studio",
    url: SITE_URL,
    description:
      "Visual agent flows published as pay-per-call x402 endpoints (USDC on Base). " +
      "Machine-readable catalog at /api/catalog; each agent exposes /.well-known/x402, " +
      "/.well-known/agent-card, and /a2a.",
    site: SITE_URL,
    discoveryUrl: `${SITE_URL}/.well-known/x402`,
    catalogUrl: `${SITE_URL}/api/catalog`,
    protocol: "x402",
    x402Version: X402_PROTOCOL_VERSION,
    network: X402_FACILITATOR_NETWORK,
    asset: USDC_TOKEN_ADDRESS,
    scheme: X402_SCHEME,
    maintainer: MAINTAINER,
  };
}

/** POST body for the free x402Scout / Bazaar discovery API `/register` endpoint. */
export interface X402ScoutRegisterBody {
  name: string;
  url: string;
  price_usd: number;
  category: string;
  description: string;
  network: string;
}

export function buildX402ScoutRegisterBody(entry: CatalogEntry): X402ScoutRegisterBody {
  requirePayoutWallet(entry);
  return {
    name: entry.name,
    url: absolute(entry.urls.x402),
    price_usd: entry.priceUsdc,
    category: "agent",
    description: `${entry.name} — ${entry.summary}. Pay-per-call x402 agent from Suede Agent Studio (USDC on Base).`,
    network: BASE_MAINNET_LABEL,
  };
}

/** JSON body for Satring's paid `POST /api/v1/services` submission. */
export interface SatringPayload {
  name: string;
  url: string;
  description: string;
  pricing: { amount: string; currency: "USDC"; model: "per-request" };
  protocols: ["x402"];
  categories: number[];
  discovery_url: string;
  catalog_url: string;
}

export function buildSatringPayload(entry: CatalogEntry): SatringPayload {
  requirePayoutWallet(entry);
  return {
    name: entry.name,
    url: absolute(entry.urls.public),
    description: `${entry.name} — ${entry.summary}. A Suede Agent Studio flow callable per-call over x402 (USDC on Base). Each agent exposes /.well-known/x402, /.well-known/agent-card, and /a2a.`,
    pricing: { amount: entry.priceUsdc.toFixed(2), currency: "USDC", model: "per-request" },
    protocols: ["x402"],
    // 1 = ai-ml, 9 = tools (confirmed live from Satring GET /api/v1/categories).
    categories: [1, 9],
    discovery_url: absolute(entry.urls.x402),
    catalog_url: `${SITE_URL}/api/catalog`,
  };
}

function agentRowsMarkdown(entries: readonly CatalogEntry[]): string {
  return entries
    .map((e) => {
      const wallet = hasPayoutWallet(e) ? e.payTo : "(payout wallet not set)";
      return `| ${e.name} | ${e.priceUsdc.toFixed(2)} USDC | ${wallet} | ${absolute(e.urls.run)} |`;
    })
    .join("\n");
}

/** One curated-list line for the awesome-x402 READMEs. Studio-level. */
export function buildAwesomeListLine(service: ServiceDescriptor): string {
  return (
    `- [${service.name}](${service.url}) - Visual agent-flow builder publishing flows as ` +
    `pay-per-call x402 endpoints (USDC on Base). Machine-readable catalog at ` +
    `[/api/catalog](${service.catalogUrl}); per-agent /.well-known/x402, ` +
    `/.well-known/agent-card, and /a2a. Maintainer: ${service.maintainer}.`
  );
}

/** GitHub issue body for the x402-index discovery-index listing. Studio-level. */
export function buildDiscoveryIssueBody(
  service: ServiceDescriptor,
  entries: readonly CatalogEntry[],
): string {
  const count = entries.length;
  const agentSection =
    count > 0
      ? `### Live agents (${count})\n\n` +
        `| Agent | Price | payTo | Run endpoint |\n|---|---|---|---|\n${agentRowsMarkdown(entries)}\n`
      : "### Live agents\n\nNo public agents are listed yet.\n";
  return [
    `## Service: ${service.name}`,
    "",
    `**Site:** ${service.site}`,
    `**Service discovery manifest:** ${service.discoveryUrl}`,
    `**Catalog API:** ${service.catalogUrl}`,
    "",
    "### What it does",
    "",
    service.description,
    "",
    agentSection,
    "### Payment details",
    "",
    `- **x402 version:** ${service.x402Version}`,
    `- **Network:** ${service.network}`,
    `- **Asset:** ${service.asset} (USDC on Base)`,
    `- **Scheme:** ${service.scheme}`,
    "- **payTo:** the creator's wallet per agent (shown in the table above).",
    "",
    "### Maintainer",
    "",
    `GitHub: ${service.maintainer}`,
  ].join("\n");
}

/** Outreach message for Agentic.Market (no public API — human sends this). */
export function buildPaymarketOutreach(
  service: ServiceDescriptor,
  entries: readonly CatalogEntry[],
): string {
  const count = entries.length;
  const agentSection =
    count > 0
      ? `**Live agents (${count}):**\n\n` +
        `| Agent | Price | payTo | Run endpoint |\n|---|---|---|---|\n${agentRowsMarkdown(entries)}`
      : "No public agents are listed yet.";
  return [
    `Hi — I'd like to list ${service.name} in your catalog.`,
    "",
    `**Service:** ${service.name}`,
    `**URL:** ${service.url}`,
    `**Protocol:** x402 v${service.x402Version}, USDC on Base`,
    "",
    "**What it does:**",
    service.description,
    "",
    `**Discovery:** ${service.discoveryUrl}`,
    `**Catalog API:** ${service.catalogUrl}`,
    "",
    agentSection,
    "",
    `Happy to provide any additional metadata you need. GitHub: ${service.maintainer}`,
  ].join("\n");
}

/** Provider YAML spec for pay.sh (validated locally, then sent to maintainers). */
export function buildPaymarketYaml(entries: readonly CatalogEntry[]): string {
  const site = SITE_URL;
  const priced = entries.find((e) => e.priceUsdc > 0) ?? entries[0];
  const tierPrice = priced ? priced.priceUsdc.toFixed(2) : "0.10";
  const lines: string[] = [
    "name: suede-agent-studio",
    "subdomain: suede-agent-studio",
    "title: 'Suede Agent Studio'",
    "description: 'Visual agent flows published as pay-per-call x402 endpoints (USDC on Base). Each agent exposes /.well-known/x402, /.well-known/agent-card, and /a2a.'",
    "category: ai_ml",
    "version: v1",
    "",
    "routing:",
    "  type: proxy",
    `  upstream: ${site}`,
    "",
    "operator:",
    "  currencies:",
    "    usd: ['USDC']",
    `  network: ${BASE_MAINNET_LABEL}`,
    "  fee_payer: false",
    "",
    "endpoints:",
    "  - method: GET",
    "    path: '.well-known/x402'",
    "    description: 'Service-level x402 discovery manifest (free).'",
    "  - method: GET",
    "    path: 'api/catalog'",
    "    description: 'Machine-readable JSON catalog of all published agents (free).'",
    "  - method: GET",
    "    path: 'api/agents/{slug}/.well-known/x402'",
    "    description: 'Per-agent x402 payment manifest — scheme, network, price, asset, payTo.'",
    "  - method: POST",
    "    path: 'api/agents/{agentId}/run'",
    "    description: 'Invoke a published agent flow. Returns 402 until valid USDC payment proof is provided.'",
    "    metering:",
    "      dimensions:",
    "        - direction: usage",
    "          unit: requests",
    "          scale: 1",
    "          tiers:",
    `            - price_usd: ${tierPrice}`,
  ];
  return lines.join("\n");
}
