/** Pure, storage-agnostic contracts for immutable Resource Foundry packs. */

export type ResourceProductStatus = "draft" | "test" | "live" | "paused" | "retired";
export type ResourcePackStatus = "candidate" | "approved" | "live" | "retired";
export type ResourceFreshness = "fresh" | "stale" | "mixed";
export type ResourceExecutionAccess = "free" | "paid" | "private";
export type ResourceDiscoveryAccess = "public" | "unlisted";
export type ResourcePaymentState = "free" | "challenged" | "credited" | "settled" | "refunded" | "failed";
export type SourceProvenance = "mine" | "licensed_or_permissioned" | "public_source" | "other_or_unspecified";

export type ResourceJsonPrimitive = string | number | boolean | null;
export type ResourceJsonValue = ResourceJsonPrimitive | readonly ResourceJsonValue[] | { readonly [key: string]: ResourceJsonValue };
export type ResourceJsonSchema = Readonly<Record<string, ResourceJsonValue>>;

export interface ResourceQueryReference {
  readonly resourceProductId: string;
  readonly packVersionId: string;
  readonly semanticHash: string;
}

export interface ResourceProduct {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: ResourceProductStatus;
  readonly executionAccess: ResourceExecutionAccess;
  readonly discoveryAccess: ResourceDiscoveryAccess;
}

export interface ResourceSourceSnapshot {
  readonly id: string;
  readonly resourceProductId: string;
  readonly locator: string;
  readonly sourceKind: string;
  readonly capturedAt: string;
  readonly sourcePublishedAt?: string;
  readonly contentHash: string;
  readonly freshnessDeadline: string;
  /** Informational owner context only; it never gates parsing or query execution. */
  readonly provenance?: SourceProvenance;
  readonly provenanceNote?: string;
}

export interface EvidencePointer {
  readonly id: string;
  readonly sourceSnapshotId: string;
  readonly locator: string;
  readonly observedAt: string;
  readonly fieldHash?: string;
  readonly confidence?: number;
  readonly conflict?: string;
}

export interface ResourceRecord {
  readonly id: string;
  readonly fields: Readonly<Record<string, ResourceJsonValue>>;
  readonly tags: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly unknowns?: readonly string[];
  readonly conflicts?: readonly string[];
}

export interface ResourceTaxonomyEntry {
  readonly id: string;
  readonly label: string;
}

export interface ResourceJobContract {
  readonly jobStatement: string;
  readonly buyerIntent: string;
  readonly inputSchema: ResourceJsonSchema;
  readonly outputSchema: ResourceJsonSchema;
  readonly unsupportedRequest: string;
  readonly evidenceRequirement: string;
  readonly safeExample: ResourceJsonValue;
  readonly reviewBoundary: string;
  readonly dataHandlingDisclosure: string;
}

export interface ResourcePackContent {
  readonly recordSchema: ResourceJsonSchema;
  /** Explicit query surface; private record fields are never implicitly queryable. */
  readonly filterFields: readonly string[];
  /** Explicit return surface; private record fields are never implicitly publishable. */
  readonly returnFields: readonly string[];
  readonly taxonomy: readonly ResourceTaxonomyEntry[];
  readonly records: readonly ResourceRecord[];
  readonly evidence: readonly EvidencePointer[];
  readonly sourceSnapshotIds: readonly string[];
  readonly jobContract: ResourceJobContract;
}

export interface ResourcePackBundle extends ResourceQueryReference {
  readonly freshness: ResourceFreshness;
  readonly content: ResourcePackContent;
}

export interface ResourceQueryParams extends ResourceQueryReference {
  readonly filters: Readonly<Record<string, ResourceJsonValue>>;
  readonly filterFields: readonly string[];
  readonly returnFields: readonly string[];
  readonly limit?: number;
}

export interface ResourceReceipt {
  readonly resourceProductId: string;
  readonly resourceVersion: string;
  readonly semanticHash: string;
  readonly freshness: ResourceFreshness;
  readonly evidence: readonly EvidencePointer[];
  readonly unknowns: readonly string[];
  readonly conflicts: readonly string[];
  readonly outputSchemaValid: boolean;
}

export interface ResourceQueryResult {
  readonly result: readonly Readonly<Record<string, ResourceJsonValue>>[];
  readonly resourceReceipt: ResourceReceipt;
}

/** Bounded public aggregate. It deliberately contains no source identity or content. */
export interface ResourceSourceDisclosure {
  readonly sourceCount: number;
  readonly sourceKinds: readonly string[];
}
