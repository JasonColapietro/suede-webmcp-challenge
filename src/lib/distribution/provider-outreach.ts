/**
 * Generated partnership outreach for the protocol providers.
 *
 * Same discipline as `payloads.ts`: every message is built from live values
 * (the service descriptor and current catalog stats), so a draft can never
 * claim an agent count, endpoint, or price the studio is not actually
 * serving. No listing status is manufactured; the message describes what is
 * implemented today and makes the registry's specific partnership ask.
 *
 * Server-only. Reads SITE_URL through the service descriptor; never import
 * into a client component. Public copy rule applies: no em dashes.
 */
import type { ProtocolProvider } from "./providers";
import type { ServiceDescriptor } from "./payloads";

/** Live catalog stats the caller computes from `buildCatalog()` entries. */
export interface CatalogStats {
  /** Number of published agents currently in the public catalog. */
  liveAgents: number;
  /** Subset whose complete paid-call contract is ready right now. */
  paymentEnabled: number;
}

export interface ProviderPartnerOutreach {
  providerId: string;
  /** Where the message goes, straight from the registry. */
  channelKind: ProtocolProvider["partnerChannel"]["kind"];
  channelUrl: string;
  subject: string;
  body: string;
}

function absoluteEndpoints(provider: ProtocolProvider, site: string): readonly string[] {
  return provider.endpoints.map((path) => `${site}${path}`);
}

/**
 * Build the partnership message for one provider from live data. The body is
 * plain text so it pastes cleanly into an email, a GitHub issue, or a form.
 */
export function buildProviderPartnerOutreach(
  provider: ProtocolProvider,
  service: ServiceDescriptor,
  stats: CatalogStats,
): ProviderPartnerOutreach {
  const endpoints = absoluteEndpoints(provider, service.site);
  const surfaceLines =
    endpoints.length > 0
      ? ["Live surfaces you can check right now:", ...endpoints.map((url) => `- ${url}`)]
      : [
          "This integration runs in the visitor's browser session rather than at an HTTP path.",
          `The machine catalog behind it is ${service.catalogUrl}.`,
        ];
  const statsLine =
    stats.liveAgents > 0
      ? `The public catalog currently lists ${stats.liveAgents} published ${
          stats.liveAgents === 1 ? "agent" : "agents"
        }, ${stats.paymentEnabled} of which accept x402 payment on Base today.`
      : "The public catalog is live; agent listings vary as creators publish and unpublish.";
  const body = [
    `Hi ${provider.steward} team,`,
    "",
    `I run Suede Agent Studio (${service.site}), a visual agent builder that publishes user-built flows as pay-per-call services other agents can discover and buy.`,
    "",
    `We have ${provider.protocol} implemented in production:`,
    "",
    provider.implemented,
    "",
    ...surfaceLines,
    "",
    statsLine,
    `Machine-readable provider metadata: ${service.site}/api/providers`,
    "",
    `We would like to partner: ${provider.partnerAsk}.`,
    "",
    "Happy to adjust the implementation to whatever serves your adopters best, and to be a public reference deployment.",
    "",
    "Jason Colapietro",
    "Founder, Suede Labs AI",
    `GitHub: ${service.maintainer}`,
    service.site,
  ].join("\n");
  return {
    providerId: provider.id,
    channelKind: provider.partnerChannel.kind,
    channelUrl: provider.partnerChannel.url,
    subject: `${provider.protocol} in production at Suede Agent Studio: partnership?`,
    body,
  };
}
