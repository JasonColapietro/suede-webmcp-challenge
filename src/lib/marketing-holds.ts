import { isPublicDiscoverableSuedeEndpointId } from "@/lib/rails/suede-endpoints";

/**
 * A marketing hold keeps a template or endpoint out of public discovery and
 * guided recommendations without removing compatibility data from the product.
 *
 * The Registry workflow hold was lifted on 2026-08-04 because ip.suedeai.ai is
 * live. Gateway-route marketing has an additional truth gate: only the explicit
 * public/discoverable allowlist may be public. A live Registry does not make the
 * retired /v1/chain-chat gateway profile operational.
 */
const HELD_TEMPLATE_SLUGS = new Set<string>();

const HELD_ENDPOINT_IDS = new Set<string>();

export function isPublicTemplateMarketingAllowed(slug: string): boolean {
  return !HELD_TEMPLATE_SLUGS.has(slug);
}

export function isPublicEndpointMarketingAllowed(id: string): boolean {
  return isPublicDiscoverableSuedeEndpointId(id) && !HELD_ENDPOINT_IDS.has(id);
}
