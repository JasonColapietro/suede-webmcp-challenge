import type { CatalogEntry } from "@/lib/catalog";
import {
  RESOURCE_CONTRACT_EXTENSION_URI,
  type PublicResourceContractExtension,
} from "@/lib/public-service-contract";
import { parsePublicJobContract } from "@/lib/resources/public-contract";
import type { ResourceJobContract } from "@/lib/resources/types";
import { SITE_URL } from "@/lib/site";
import {
  isWebMcpBuyable,
  WEBMCP_BUY_TOOL_NAME,
} from "@/lib/webmcp/buy-contract";

export const MOBILE_RESOURCE_PACK_CATALOG_VERSION = "resource-packs.v1";

export interface MobileResourcePackPurchaseHandoff {
  readonly kind: "external_webmcp_agent";
  /** Open this canonical page only after a user-initiated handoff. */
  readonly url: string;
  readonly requiresWebMcpAgentBrowser: true;
  readonly requiresAuthenticatedBrowserSession: true;
  readonly requiresUserInitiatedNavigation: true;
  readonly catalogExecutesPurchase: false;
  /** Existing page-registered WebMCP tool; iOS must never call its backing route. */
  readonly webMcp: {
    readonly tool: typeof WEBMCP_BUY_TOOL_NAME;
  };
}

export interface MobileResourcePackCatalogEntry {
  readonly resourceProductId: string;
  readonly packVersionId: string;
  readonly semanticHash: string;
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly description: string | null;
  readonly freshness: PublicResourceContractExtension["freshness"];
  readonly priceUsdc: number;
  readonly availability: {
    readonly publishedLive: boolean;
    readonly acceptsPayment: boolean;
    readonly previewAvailable: boolean;
    readonly paymentState: CatalogEntry["paymentState"];
  };
  readonly jobContract: ResourceJobContract;
  readonly urls: {
    readonly public: string;
    readonly run: string;
    readonly x402: string;
    readonly agentCard: string;
    readonly a2a: string;
  };
  readonly purchaseHandoff: MobileResourcePackPurchaseHandoff | null;
}

export interface MobileResourcePackCatalog {
  readonly schemaVersion: typeof MOBILE_RESOURCE_PACK_CATALOG_VERSION;
  readonly service: "Suede Resource Foundry";
  readonly site: string;
  readonly count: number;
  readonly packs: readonly MobileResourcePackCatalogEntry[];
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Readonly<Record<string, unknown>>;
}

function absoluteSiteUrl(value: string): string {
  return new URL(value, `${SITE_URL}/`).toString();
}

function parseExtension(entry: CatalogEntry): {
  readonly resourceProductId: string;
  readonly packVersionId: string;
  readonly semanticHash: string;
  readonly freshness: PublicResourceContractExtension["freshness"];
  readonly jobContract: ResourceJobContract;
} | null {
  const extension = plainRecord(entry.extensions?.[RESOURCE_CONTRACT_EXTENSION_URI]);
  if (!extension || extension.extensionUri !== RESOURCE_CONTRACT_EXTENSION_URI ||
      typeof extension.resourceProductId !== "string" || extension.resourceProductId.length === 0 ||
      typeof extension.resourceVersion !== "string" || extension.resourceVersion.length === 0 ||
      typeof extension.semanticHash !== "string" || !/^[a-f0-9]{64}$/u.test(extension.semanticHash) ||
      !["fresh", "stale", "mixed"].includes(String(extension.freshness))) return null;

  const access = plainRecord(extension.access);
  if (!access || access.discovery !== "public" ||
      !["free", "paid"].includes(String(access.execution))) return null;
  const job = plainRecord(extension.jobContract);
  if (!job) return null;

  try {
    const parsed = parsePublicJobContract({
      resourceProductId: extension.resourceProductId,
      packVersionId: extension.resourceVersion,
      semanticHash: extension.semanticHash,
      ...job,
    }, {
      resourceProductId: extension.resourceProductId,
      packVersionId: extension.resourceVersion,
      semanticHash: extension.semanticHash,
    });
    const {
      resourceProductId: _resourceProductId,
      packVersionId: _packVersionId,
      semanticHash: _semanticHash,
      ...jobContract
    } = parsed;
    return {
      resourceProductId: extension.resourceProductId,
      packVersionId: extension.resourceVersion,
      semanticHash: extension.semanticHash,
      freshness: extension.freshness as PublicResourceContractExtension["freshness"],
      jobContract,
    };
  } catch {
    return null;
  }
}

function purchaseHandoff(entry: CatalogEntry): MobileResourcePackPurchaseHandoff | null {
  if (!isWebMcpBuyable(entry)) return null;
  return Object.freeze({
    kind: "external_webmcp_agent",
    url: absoluteSiteUrl(entry.urls.public),
    requiresWebMcpAgentBrowser: true,
    requiresAuthenticatedBrowserSession: true,
    requiresUserInitiatedNavigation: true,
    catalogExecutesPurchase: false,
    webMcp: Object.freeze({
      tool: WEBMCP_BUY_TOOL_NAME,
    }),
  });
}

function projectEntry(entry: CatalogEntry): MobileResourcePackCatalogEntry | null {
  if (!entry.publishedLive) return null;
  const resource = parseExtension(entry);
  if (!resource) return null;
  return Object.freeze({
    resourceProductId: resource.resourceProductId,
    packVersionId: resource.packVersionId,
    semanticHash: resource.semanticHash,
    slug: entry.slug,
    name: entry.name,
    summary: entry.summary,
    description: entry.description,
    freshness: resource.freshness,
    priceUsdc: entry.priceUsdc,
    availability: Object.freeze({
      publishedLive: entry.publishedLive,
      acceptsPayment: entry.acceptsPayment,
      previewAvailable: entry.previewAvailable,
      paymentState: entry.paymentState,
    }),
    jobContract: resource.jobContract,
    urls: Object.freeze({
      public: absoluteSiteUrl(entry.urls.public),
      run: absoluteSiteUrl(entry.urls.run),
      x402: absoluteSiteUrl(entry.urls.x402),
      agentCard: absoluteSiteUrl(entry.urls.agentCard),
      a2a: absoluteSiteUrl(entry.urls.a2a),
    }),
    purchaseHandoff: purchaseHandoff(entry),
  });
}

/** Compact public projection; pack records and source identities never enter it. */
export function projectMobileResourcePackCatalog(
  entries: readonly CatalogEntry[],
): MobileResourcePackCatalog {
  const packs = entries
    .flatMap((entry) => {
      const projected = projectEntry(entry);
      return projected ? [projected] : [];
    })
    .reduce<readonly MobileResourcePackCatalogEntry[]>((sorted, entry) => {
      const index = sorted.findIndex((current) => entry.slug.localeCompare(current.slug) < 0);
      return index === -1
        ? [...sorted, entry]
        : [...sorted.slice(0, index), entry, ...sorted.slice(index)];
    }, []);
  return Object.freeze({
    schemaVersion: MOBILE_RESOURCE_PACK_CATALOG_VERSION,
    service: "Suede Resource Foundry",
    site: SITE_URL,
    count: packs.length,
    packs: Object.freeze(packs),
  });
}
