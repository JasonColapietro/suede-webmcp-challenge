import type {
  ResourceDiscoveryAccess,
  ResourceExecutionAccess,
  ResourceFreshness,
  ResourcePackBundle, ResourcePaymentState, ResourceSourceDisclosure,
  ResourcePackContent,
  ResourcePackStatus,
  ResourceProduct,
  ResourceProductStatus,
  ResourceReceipt,
  ResourceSourceSnapshot,
  SourceProvenance,
} from "./types";

export const RESOURCE_REPOSITORY_NOT_FOUND = "Resource not found.";
export const RESOURCE_REPOSITORY_CONFLICT = "Resource persistence conflict.";
export const RESOURCE_PERSISTENCE_ERROR = "Resource persistence failed.";
export const RESOURCE_PERSISTENCE_INTEGRITY_ERROR = "Resource persistence integrity check failed.";
export const RESOURCE_AMBIGUOUS_FINAL_COMMIT = "Resource publication outcome is unknown.";

export class ResourceRepositoryNotFoundError extends Error {
  readonly code = "RESOURCE_NOT_FOUND";
  constructor() { super(RESOURCE_REPOSITORY_NOT_FOUND); this.name = "ResourceRepositoryNotFoundError"; }
}

export class ResourceRepositoryConflictError extends Error {
  readonly code = "RESOURCE_CONFLICT";
  constructor() { super(RESOURCE_REPOSITORY_CONFLICT); this.name = "ResourceRepositoryConflictError"; }
}

export class ResourcePersistenceError extends Error {
  readonly code: string = "RESOURCE_PERSISTENCE_ERROR";
  constructor(message = RESOURCE_PERSISTENCE_ERROR) { super(message); this.name = "ResourcePersistenceError"; }
}

export class ResourceAmbiguousFinalCommitError extends ResourcePersistenceError {
  override readonly code = "RESOURCE_AMBIGUOUS_FINAL_COMMIT";
  constructor() {
    super(RESOURCE_AMBIGUOUS_FINAL_COMMIT);
    this.name = "ResourceAmbiguousFinalCommitError";
  }
}

export interface CreateResourceProductInput {
  readonly id?: string;
  readonly ownerId: string;
  readonly name: string;
  readonly slug: string;
  readonly executionAccess: ResourceExecutionAccess;
  readonly discoveryAccess: ResourceDiscoveryAccess;
}

export interface CreateResourceProductWithCandidateInput extends CreateResourceProductInput {
  readonly content: ResourcePackContent;
  readonly createdBy: string;
}

export interface CreatedResourceProductWithCandidate {
  readonly product: ResourceProduct;
  readonly candidate: ResourcePackVersion;
}

export interface UpdateResourceProductInput {
  readonly ownerId: string;
  readonly resourceProductId: string;
  readonly expectedStatus: ResourceProductStatus;
  readonly name?: string;
  readonly slug?: string;
  readonly status?: ResourceProductStatus;
  readonly executionAccess?: ResourceExecutionAccess;
  readonly discoveryAccess?: ResourceDiscoveryAccess;
}

export interface CreateSourceSnapshotInput {
  readonly id?: string;
  readonly sourceAssetId?: string;
  readonly ownerId: string;
  readonly resourceProductId: string;
  readonly locator: string;
  readonly sourceKind: string;
  readonly capturedAt: string;
  readonly sourcePublishedAt?: string;
  readonly contentHash: string;
  readonly freshnessDeadline: string;
  readonly provenance?: SourceProvenance;
  readonly provenanceNote?: string;
}

export interface ResourcePackVersion {
  readonly id: string;
  readonly resourceProductId: string;
  readonly revision: number;
  readonly status: ResourcePackStatus;
  readonly semanticHash: string;
  readonly content: ResourcePackContent;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

export interface ReplaceCandidateInput {
  readonly ownerId: string;
  readonly resourceProductId: string;
  readonly expectedCandidatePackVersionId: string | null;
  readonly expectedRevision: number;
  readonly content: ResourcePackContent;
  readonly createdBy: string;
}

export interface CreateSourceSnapshotAndReplaceCandidateInput {
  readonly snapshot: CreateSourceSnapshotInput;
  readonly candidate: ReplaceCandidateInput;
}

export interface CreatedSourceSnapshotAndCandidate {
  readonly snapshot: ResourceSourceSnapshot;
  readonly candidate: ResourcePackVersion;
}

export interface ApproveCandidateInput {
  readonly ownerId: string;
  readonly resourceProductId: string;
  readonly candidatePackVersionId: string;
  readonly expectedRevision: number;
  readonly expectedSemanticHash: string;
  readonly approvedBy: string;
}

export interface RejectCandidateInput {
  readonly ownerId: string;
  readonly resourceProductId: string;
  readonly candidatePackVersionId: string;
  readonly expectedRevision: number;
  readonly expectedSemanticHash: string;
}

export interface OwnedResourceQueryReference {
  readonly ownerId: string;
  readonly resourceProductId: string;
  readonly packVersionId: string;
  readonly semanticHash: string;
}

export interface ResourceRelease {
  readonly id: string;
  readonly ownerId: string;
  readonly resourceProductId: string;
  readonly packVersionId: string;
  readonly semanticHash: string;
  readonly publicationKey: string;
  readonly publicationRequestHash: string;
  readonly graphSemanticHash: string;
  readonly graphFullHash: string;
  readonly priceUsdc: number;
  readonly executionAccess: ResourceExecutionAccess;
  readonly discoveryAccess: ResourceDiscoveryAccess;
  readonly agentId: string;
  readonly flowId: string;
  readonly flowVersionId: string;
  readonly deploymentId: string;
  readonly environmentId: string;
  readonly createdAt: string;
}

export interface CreateResourceReleaseInput extends Omit<ResourceRelease, "id" | "createdAt"> {
  readonly id?: string;
  readonly createdAt?: string;
}

export type ResourceReleaseLifecycleAction = "pause" | "resume" | "retire";

export interface TransitionResourceReleaseLifecycleInput {
  readonly ownerId: string;
  readonly resourceProductId: string;
  readonly action: ResourceReleaseLifecycleAction;
  readonly expectedStatus: Extract<ResourceProductStatus, "live" | "paused">;
  readonly releaseId: string;
  readonly agentId: string;
  readonly deploymentId: string;
}

export interface TransitionResourceReleaseLifecycleResult {
  readonly product: ResourceProduct;
  readonly release: ResourceRelease;
}

export interface ResourceRunReceipt extends ResourceReceipt {
  readonly id: string;
  readonly ownerId: string;
  readonly packVersionId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly flowVersionId: string;
  readonly deploymentId: string;
  readonly paymentId: string | null;
  readonly paymentState: ResourcePaymentState;
  readonly priceUsdc: number;
  readonly createdAt: string;
}

export interface CreateResourceRunReceiptInput {
  readonly id?: string;
  readonly ownerId: string;
  readonly resourceProductId: string;
  readonly packVersionId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly flowVersionId: string;
  readonly deploymentId: string;
  readonly paymentId: string | null;
  readonly paymentState: ResourcePaymentState;
  readonly priceUsdc: number;
  readonly receipt: ResourceReceipt;
  readonly createdAt?: string;
}

export interface ResourcePortfolioItem extends ResourceProduct {
  readonly candidateRevision: number | null;
  readonly approvedPackVersionId: string | null;
  readonly livePackVersionId: string | null;
  readonly currentCandidate: ResourcePortfolioPackReference | null;
  readonly approvedPack: ResourcePortfolioPackReference | null;
  readonly livePack: ResourcePortfolioPackReference | null;
  readonly portfolioFreshness: ResourceFreshness | null;
  readonly portfolioPayments: ResourcePortfolioPaymentSummary;
  readonly currentRelease: ResourceCurrentReleaseSummary | null;
  readonly releaseCount: number;
  readonly runReceiptCount: number;
}

export interface ResourcePortfolioMoneySummary {
  readonly count: number;
  readonly amountUsdc: number;
}

export interface ResourcePortfolioUnknownMoneySummary {
  readonly count: null;
  readonly amountUsdc: null;
}

/** Exact durable receipt aggregates. Attempted is null because attempts are not durably measured. */
export interface ResourcePortfolioPaymentSummary {
  readonly attempted: null;
  readonly free: number;
  readonly challenged: null;
  readonly executed: number;
  readonly credited: ResourcePortfolioMoneySummary;
  readonly settled: ResourcePortfolioMoneySummary;
  readonly refunded: ResourcePortfolioUnknownMoneySummary;
  readonly failed: null;
}

/** Bounded owner-only release receipt; it contains no pack or source bodies. */
export interface ResourceCurrentReleaseSummary {
  readonly id: string;
  readonly resourceProductId: string;
  readonly packVersionId: string;
  readonly semanticHash: string;
  readonly publicationKey: string;
  readonly publicationRequestHash: string;
  readonly priceUsdc: number;
  readonly executionAccess: ResourceExecutionAccess;
  readonly discoveryAccess: ResourceDiscoveryAccess;
  readonly freshness: ResourceFreshness;
  readonly payoutReady: boolean;
  readonly settlementState: "off" | "on";
  readonly agentId: string;
  readonly agentStatus: "draft" | "live";
  readonly flowVersionId: string;
  readonly deploymentId: string;
  readonly deploymentStatus: "live" | "retired";
  readonly deploymentRetiredAt: string | null;
  readonly createdAt: string;
  readonly urls: {
    readonly run: string;
    readonly card: string;
    readonly x402: string;
    readonly a2a: string;
    readonly public: string;
  };
}

/** Bounded owner-workspace pointer. Pack content remains behind the exact owner-only pack read. */
export interface ResourcePortfolioPackReference {
  readonly packVersionId: string;
  readonly revision: number;
  readonly semanticHash: string;
}

export interface ResourceRepository {
  createProduct(input: CreateResourceProductInput): Promise<ResourceProduct>;
  createProductWithCandidate(input: CreateResourceProductWithCandidateInput): Promise<CreatedResourceProductWithCandidate>;
  getOwnedProduct(ownerId: string, productId: string): Promise<ResourceProduct | null>;
  getOwnedPortfolioItem(ownerId: string, productId: string): Promise<ResourcePortfolioItem | null>;
  listOwnedProducts(ownerId: string): Promise<readonly ResourcePortfolioItem[]>;
  updateOwnedDraft(input: UpdateResourceProductInput): Promise<ResourceProduct>;
  createSourceSnapshot(input: CreateSourceSnapshotInput): Promise<ResourceSourceSnapshot>;
  createSourceSnapshotAndReplaceCandidate(input: CreateSourceSnapshotAndReplaceCandidateInput): Promise<CreatedSourceSnapshotAndCandidate>;
  replaceCandidate(input: ReplaceCandidateInput): Promise<ResourcePackVersion>;
  rejectCandidate(input: RejectCandidateInput): Promise<void>;
  approveCandidate(input: ApproveCandidateInput): Promise<ResourcePackVersion>;
  getOwnedPack(reference: OwnedResourceQueryReference): Promise<ResourcePackBundle | null>;
  getOwnedSourceDisclosure(reference: OwnedResourceQueryReference): Promise<ResourceSourceDisclosure | null>;
  /** Server-current approved pointer; callers never select a version or hash. */
  getOwnedApprovedPack(ownerId: string, resourceProductId: string): Promise<ResourcePackBundle | null>;
  createRelease(input: CreateResourceReleaseInput): Promise<ResourceRelease>;
  transitionReleaseLifecycle(
    input: TransitionResourceReleaseLifecycleInput,
  ): Promise<TransitionResourceReleaseLifecycleResult>;
  getPublishedReleaseByAgent(agentId: string): Promise<ResourceRelease | null>;
  /** Exact latest immutable release for each requested agent, in one bounded read. */
  listPublishedReleasesByAgentIds(agentIds: readonly string[]): Promise<readonly ResourceRelease[]>;
  getOwnedPublishedReleaseByPublicationKey(
    ownerId: string,
    resourceProductId: string,
    publicationKey: string,
  ): Promise<ResourceRelease | null>;
  /** Newest-first bounded owner-only immutable release receipts; never includes pack or source bodies. */
  listOwnedReleaseHistory(
    ownerId: string,
    resourceProductId: string,
    limit: number,
  ): Promise<readonly ResourceCurrentReleaseSummary[]>;
  recordRunReceipt(input: CreateResourceRunReceiptInput): Promise<ResourceRunReceipt>;
  listRunReceipts(ownerId: string, productId: string): Promise<readonly ResourceRunReceipt[]>;
  adoptOwner(fromOwnerId: string, toOwnerId: string): Promise<void>;
}

export function resourceFreshness(deadlines: readonly string[], now: Date): ResourceFreshness {
  if (deadlines.length === 0) return "fresh";
  const current = now.getTime();
  const stale = deadlines.filter((deadline) => Date.parse(deadline) < current).length;
  return stale === 0 ? "fresh" : stale === deadlines.length ? "stale" : "mixed";
}
