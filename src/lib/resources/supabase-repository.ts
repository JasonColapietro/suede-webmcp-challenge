import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "../db/supabase-server-client";
import { canonicalizeResourcePack, resourcePackSemanticHash } from "./pack-hash";
import {
  RESOURCE_PERSISTENCE_INTEGRITY_ERROR,
  ResourceAmbiguousFinalCommitError,
  ResourcePersistenceError,
  ResourceRepositoryConflictError,
  ResourceRepositoryNotFoundError,
  type ApproveCandidateInput,
  type CreateResourceProductInput,
  type CreateResourceProductWithCandidateInput,
  type CreatedResourceProductWithCandidate,
  type CreateSourceSnapshotAndReplaceCandidateInput,
  type CreatedSourceSnapshotAndCandidate,
  type CreateResourceReleaseInput,
  type CreateResourceRunReceiptInput,
  type CreateSourceSnapshotInput,
  type OwnedResourceQueryReference,
  type ReplaceCandidateInput,
  type RejectCandidateInput,
  type ResourcePackVersion,
  type ResourcePortfolioPackReference,
  type ResourcePortfolioPaymentSummary,
  type ResourceCurrentReleaseSummary,
  type ResourcePortfolioItem,
  type ResourceRelease,
  type ResourceRepository,
  type ResourceRunReceipt,
  type TransitionResourceReleaseLifecycleInput,
  type TransitionResourceReleaseLifecycleResult,
  type UpdateResourceProductInput,
} from "./repository";
import {
  parseEvidencePointer,
  parseResourcePackContent,
  parseResourceProduct,
  parseSourceSnapshot,
} from "./schemas";
import type { ResourcePackBundle, ResourceProduct, ResourceSourceSnapshot } from "./types";

type Payload = Record<string, unknown>;
type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

class MalformedResourceReleaseResultError extends Error {}

const releaseInputIdentityKeys = [
  "ownerId", "resourceProductId", "packVersionId", "semanticHash", "publicationKey",
  "publicationRequestHash", "graphSemanticHash", "graphFullHash", "priceUsdc",
  "executionAccess", "discoveryAccess", "agentId", "flowId", "flowVersionId",
  "deploymentId", "environmentId",
] as const satisfies readonly (keyof CreateResourceReleaseInput)[];

function validatedProductCreateInput(
  input: CreateResourceProductInput,
): CreateResourceProductInput {
  const parsed = parseResourceProduct({
    id: input.id ?? "resource-product-preflight",
    ownerId: input.ownerId,
    name: input.name,
    slug: input.slug,
    status: "draft",
    executionAccess: input.executionAccess,
    discoveryAccess: input.discoveryAccess,
  });
  return Object.freeze({
    ...(input.id === undefined ? {} : { id: parsed.id }),
    ownerId: parsed.ownerId,
    name: parsed.name,
    slug: parsed.slug,
    executionAccess: parsed.executionAccess,
    discoveryAccess: parsed.discoveryAccess,
  });
}

function validatedResourceIdentity(value: string): string {
  return parseResourceProduct({
    id: "resource-identity-preflight",
    ownerId: value,
    name: "Resource identity preflight",
    slug: "resource-identity-preflight",
    status: "draft",
    executionAccess: "private",
    discoveryAccess: "unlisted",
  }).ownerId;
}

function matchesProductCreateInput(
  value: ResourceProduct,
  input: CreateResourceProductInput,
): boolean {
  return value.status === "draft" &&
    value.ownerId === input.ownerId &&
    value.name === input.name &&
    value.slug === input.slug &&
    value.executionAccess === input.executionAccess &&
    value.discoveryAccess === input.discoveryAccess &&
    (input.id === undefined || value.id === input.id);
}

function object(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
  return value as Payload;
}

function product(value: unknown): ResourceProduct {
  const row = object(value);
  return parseResourceProduct({ id: row.id, ownerId: row.owner_id ?? row.ownerId, name: row.name, slug: row.slug, status: row.status, executionAccess: row.execution_access ?? row.executionAccess, discoveryAccess: row.discovery_access ?? row.discoveryAccess });
}

function portfolioReference(value: unknown): ResourcePortfolioPackReference | null {
  if (value == null) return null;
  const row = object(value);
  if (Object.keys(row).some((key) => !["packVersionId", "revision", "semanticHash"].includes(key)) ||
      typeof row.packVersionId !== "string" || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1 ||
      typeof row.semanticHash !== "string" || !/^[a-f0-9]{64}$/u.test(row.semanticHash)) {
    throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
  }
  return Object.freeze({
    packVersionId: row.packVersionId,
    revision: row.revision as number,
    semanticHash: row.semanticHash,
  });
}

function boundedCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
  }
  return value as number;
}

function boundedAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
  }
  return value;
}

function portfolioPayments(value: unknown): ResourcePortfolioPaymentSummary {
  const row = object(value);
  const allowed = new Set(["attempted", "free", "challenged", "executed", "credited", "settled", "refunded", "failed"]);
  if (Object.keys(row).some((key) => !allowed.has(key)) || row.attempted !== null) {
    throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
  }
  const money = (candidate: unknown) => {
    const entry = object(candidate);
    if (Object.keys(entry).some((key) => key !== "count" && key !== "amountUsdc")) {
      throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
    }
    return Object.freeze({ count: boundedCount(entry.count), amountUsdc: boundedAmount(entry.amountUsdc) });
  };
  boundedCount(row.challenged);
  money(row.refunded);
  boundedCount(row.failed);
  return Object.freeze({
    attempted: null,
    free: boundedCount(row.free), challenged: null,
    executed: boundedCount(row.executed), credited: money(row.credited),
    settled: money(row.settled), refunded: Object.freeze({ count: null, amountUsdc: null }), failed: null,
  });
}

function currentReleaseSummary(value: unknown): ResourceCurrentReleaseSummary | null {
  if (value == null) return null;
  const row = object(value);
  const urls = object(row.urls);
  const expected = [
    "id", "resourceProductId", "packVersionId", "semanticHash", "publicationKey", "publicationRequestHash",
    "priceUsdc", "executionAccess", "discoveryAccess", "freshness",
    "payoutReady", "settlementState", "agentId", "agentStatus", "flowVersionId",
    "deploymentId", "deploymentStatus", "deploymentRetiredAt", "createdAt", "urls",
  ];
  if (Object.keys(row).some((key) => !expected.includes(key)) ||
      Object.keys(urls).some((key) => !["run", "card", "x402", "a2a", "public"].includes(key)) ||
      !["id", "resourceProductId", "packVersionId", "semanticHash", "publicationKey", "publicationRequestHash", "agentId", "flowVersionId", "deploymentId", "createdAt"]
        .every((key) => typeof row[key] === "string" && (row[key] as string).length > 0) ||
      !/^[a-f0-9]{64}$/u.test(row.semanticHash as string) ||
      !/^[a-f0-9]{64}$/u.test(row.publicationRequestHash as string) ||
      !["free", "paid", "private"].includes(row.executionAccess as string) ||
      !["public", "unlisted"].includes(row.discoveryAccess as string) ||
      !["fresh", "stale", "mixed"].includes(row.freshness as string) ||
      typeof row.payoutReady !== "boolean" ||
      (row.settlementState !== "off" && row.settlementState !== "on") ||
      !["draft", "live"].includes(row.agentStatus as string) ||
      !["live", "retired"].includes(row.deploymentStatus as string) ||
      (row.deploymentRetiredAt !== null &&
        (typeof row.deploymentRetiredAt !== "string" || Number.isNaN(Date.parse(row.deploymentRetiredAt)))) ||
      ((row.deploymentStatus === "live") !== (row.deploymentRetiredAt === null)) ||
      !["run", "card", "x402", "a2a", "public"].every((key) => typeof urls[key] === "string" && (urls[key] as string).length > 0)) {
    throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
  }
  return Object.freeze({
    id: row.id as string, resourceProductId: row.resourceProductId as string,
    packVersionId: row.packVersionId as string,
    semanticHash: row.semanticHash as string, publicationKey: row.publicationKey as string,
    publicationRequestHash: row.publicationRequestHash as string,
    priceUsdc: boundedAmount(row.priceUsdc),
    executionAccess: row.executionAccess as ResourceCurrentReleaseSummary["executionAccess"],
    discoveryAccess: row.discoveryAccess as ResourceCurrentReleaseSummary["discoveryAccess"],
    freshness: row.freshness as ResourceCurrentReleaseSummary["freshness"],
    payoutReady: row.payoutReady,
    settlementState: row.settlementState,
    agentId: row.agentId as string,
    agentStatus: row.agentStatus as ResourceCurrentReleaseSummary["agentStatus"],
    flowVersionId: row.flowVersionId as string,
    deploymentId: row.deploymentId as string,
    deploymentStatus: row.deploymentStatus as ResourceCurrentReleaseSummary["deploymentStatus"],
    deploymentRetiredAt: row.deploymentRetiredAt as string | null,
    createdAt: row.createdAt as string,
    urls: Object.freeze({
      run: urls.run as string, card: urls.card as string, x402: urls.x402 as string,
      a2a: urls.a2a as string, public: urls.public as string,
    }),
  });
}

function resourcePortfolioItem(value: unknown): ResourcePortfolioItem {
  const row = object(value);
  const currentCandidate = portfolioReference(row.current_candidate);
  const approvedPack = portfolioReference(row.approved_pack);
  const livePack = portfolioReference(row.live_pack);
  const freshness = row.portfolio_freshness;
  if (freshness !== null && freshness !== "fresh" && freshness !== "stale" && freshness !== "mixed") {
    throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
  }
  return Object.freeze({
    ...product(row),
    candidateRevision: row.candidate_revision == null ? null : Number(row.candidate_revision),
    approvedPackVersionId: approvedPack?.packVersionId ?? (row.approved_pack_version_id == null ? null : String(row.approved_pack_version_id)),
    livePackVersionId: livePack?.packVersionId ?? (row.live_pack_version_id == null ? null : String(row.live_pack_version_id)),
    currentCandidate, approvedPack, livePack,
    portfolioFreshness: freshness,
    portfolioPayments: portfolioPayments(row.portfolio_payments),
    currentRelease: currentReleaseSummary(row.current_release),
    releaseCount: boundedCount(row.release_count), runReceiptCount: boundedCount(row.run_receipt_count),
  });
}

function pack(value: unknown): ResourcePackVersion {
  const row = object(value);
  let content;
  try { content = parseResourcePackContent(row.content ?? row.content_json); } catch { throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR); }
  const semanticHash = row.semantic_hash ?? row.semanticHash;
  if (typeof semanticHash !== "string" || resourcePackSemanticHash(content).semanticHash !== semanticHash) throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
  if (typeof row.id !== "string" || typeof (row.resource_product_id ?? row.resourceProductId) !== "string" || typeof row.revision !== "number" || typeof row.status !== "string" || typeof (row.created_by ?? row.createdBy) !== "string" || typeof (row.created_at ?? row.createdAt) !== "string") throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
  return Object.freeze({
    id: row.id, resourceProductId: (row.resource_product_id ?? row.resourceProductId) as string,
    revision: row.revision, status: row.status as ResourcePackVersion["status"], semanticHash,
    content, createdBy: (row.created_by ?? row.createdBy) as string, createdAt: (row.created_at ?? row.createdAt) as string,
    ...((row.approved_by ?? row.approvedBy) == null ? {} : { approvedBy: (row.approved_by ?? row.approvedBy) as string }),
    ...((row.approved_at ?? row.approvedAt) == null ? {} : { approvedAt: (row.approved_at ?? row.approvedAt) as string }),
  });
}

function releaseResult(value: unknown): ResourceRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MalformedResourceReleaseResultError();
  }
  const row = value as Payload;
  const string = (snakeKey: string, camelKey: string): string => {
    const field = row[snakeKey] ?? row[camelKey];
    if (typeof field !== "string" || field.trim().length === 0) {
      throw new MalformedResourceReleaseResultError();
    }
    return field;
  };
  const id = string("id", "id");
  const ownerId = string("owner_id", "ownerId");
  const resourceProductId = string("resource_product_id", "resourceProductId");
  const packVersionId = string("pack_version_id", "packVersionId");
  const semanticHash = string("semantic_hash", "semanticHash");
  const publicationKey = string("publication_key", "publicationKey");
  const publicationRequestHash = string("publication_request_hash", "publicationRequestHash");
  const graphSemanticHash = string("graph_semantic_hash", "graphSemanticHash");
  const graphFullHash = string("graph_full_hash", "graphFullHash");
  const executionAccess = row.execution_access ?? row.executionAccess;
  const discoveryAccess = row.discovery_access ?? row.discoveryAccess;
  const priceUsdc = row.price_usdc ?? row.priceUsdc;
  if ((executionAccess !== "free" && executionAccess !== "paid" && executionAccess !== "private") ||
      (discoveryAccess !== "public" && discoveryAccess !== "unlisted") ||
      typeof priceUsdc !== "number" || !Number.isFinite(priceUsdc) || priceUsdc < 0 ||
      (executionAccess !== "paid" && priceUsdc !== 0) ||
      !/^[a-f0-9]{64}$/u.test(semanticHash) ||
      !/^[a-f0-9]{64}$/u.test(publicationRequestHash) ||
      !/^[a-f0-9]{64}$/u.test(graphSemanticHash) ||
      !/^[a-f0-9]{64}$/u.test(graphFullHash)) {
    throw new MalformedResourceReleaseResultError();
  }
  return Object.freeze({
    id, ownerId, resourceProductId, packVersionId, semanticHash, publicationKey,
    publicationRequestHash, graphSemanticHash, graphFullHash,
    priceUsdc, executionAccess, discoveryAccess,
    agentId: string("agent_id", "agentId"), flowId: string("flow_id", "flowId"),
    flowVersionId: string("flow_version_id", "flowVersionId"),
    deploymentId: string("deployment_id", "deploymentId"),
    environmentId: string("environment_id", "environmentId"),
    createdAt: string("created_at", "createdAt"),
  });
}

function release(value: unknown): ResourceRelease {
  try {
    return releaseResult(value);
  } catch (error) {
    if (error instanceof MalformedResourceReleaseResultError) {
      throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
    }
    throw error;
  }
}

function matchesReleaseInput(value: ResourceRelease, input: CreateResourceReleaseInput): boolean {
  return releaseInputIdentityKeys.every((key) => value[key] === input[key]) &&
    (input.id === undefined || value.id === input.id) &&
    (input.createdAt === undefined || value.createdAt === input.createdAt);
}

function isClassifiedRepositoryError(error: unknown): boolean {
  return error instanceof ResourceRepositoryNotFoundError ||
    error instanceof ResourceRepositoryConflictError ||
    error instanceof ResourcePersistenceError;
}

function receipt(value: unknown): ResourceRunReceipt {
  const row = object(value);
  const evidence = row.evidence ?? row.evidence_json;
  const unknowns = row.unknowns ?? row.unknowns_json;
  const conflicts = row.conflicts ?? row.conflicts_json;
  const stringFields = ["id", "owner_id", "resource_product_id", "pack_version_id", "agent_id", "run_id", "flow_version_id", "deployment_id", "payment_state", "semantic_hash", "freshness", "created_at"];
  if (stringFields.some((key) => typeof row[key] !== "string") || !Array.isArray(evidence) || !Array.isArray(unknowns) || !Array.isArray(conflicts) ||
      unknowns.some((item) => typeof item !== "string") || conflicts.some((item) => typeof item !== "string") ||
      (row.payment_id !== null && typeof row.payment_id !== "string") || typeof row.price_usdc !== "number" || !Number.isFinite(row.price_usdc) || row.price_usdc < 0 ||
      !["free", "challenged", "credited", "settled", "refunded", "failed"].includes(row.payment_state as string) ||
      !["fresh", "stale", "mixed"].includes(row.freshness as string) || typeof row.output_schema_valid !== "boolean") {
    throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
  }
  let parsedEvidence;
  try { parsedEvidence = Object.freeze(evidence.map(parseEvidencePointer)); } catch {
    throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
  }
  return Object.freeze({
    id: row.id as string, ownerId: row.owner_id as string, resourceProductId: row.resource_product_id as string,
    packVersionId: row.pack_version_id as string, agentId: row.agent_id as string, runId: row.run_id as string,
    flowVersionId: row.flow_version_id as string, deploymentId: row.deployment_id as string,
    paymentId: row.payment_id as string | null, paymentState: row.payment_state as ResourceRunReceipt["paymentState"],
    priceUsdc: row.price_usdc as number,
    resourceVersion: row.pack_version_id as string, semanticHash: row.semantic_hash as string,
    freshness: row.freshness as ResourceRunReceipt["freshness"], evidence: parsedEvidence,
    unknowns: Object.freeze(unknowns as string[]), conflicts: Object.freeze(conflicts as string[]),
    outputSchemaValid: row.output_schema_valid as boolean, createdAt: row.created_at as string,
  });
}

export class SupabaseResourceRepository implements ResourceRepository {
  private readonly db: SupabaseClient;
  constructor(client: SupabaseClient = createServerSupabaseClient()) { this.db = client; }

  private async call(
    name: string,
    args: Payload,
    options: { readonly ambiguousTransport?: boolean } = {},
  ): Promise<unknown> {
    const invoke = this.db.rpc.bind(this.db) as unknown as (name: string, args: Payload) => Promise<RpcResult>;
    let result: RpcResult;
    try {
      result = await invoke(name, args);
    } catch (error) {
      if (isClassifiedRepositoryError(error)) throw error;
      if (options.ambiguousTransport) throw new ResourceAmbiguousFinalCommitError();
      throw new ResourcePersistenceError();
    }
    if (result.error) {
      const message = `${result.error.code ?? ""} ${result.error.message ?? ""}`.toLowerCase();
      if (message.includes("resource_not_found")) throw new ResourceRepositoryNotFoundError();
      if (message.includes("resource_conflict")) throw new ResourceRepositoryConflictError();
      throw new ResourcePersistenceError();
    }
    return result.data;
  }

  async createProduct(input: CreateResourceProductInput): Promise<ResourceProduct> {
    const validated = validatedProductCreateInput(input);
    const data = await this.call(
      "agent_studio_resource_create_product",
      { p_input: validated },
      { ambiguousTransport: true },
    );
    try {
      const created = product(data);
      if (!matchesProductCreateInput(created, validated)) throw new Error();
      return created;
    } catch {
      throw new ResourceAmbiguousFinalCommitError();
    }
  }
  async createProductWithCandidate(input: CreateResourceProductWithCandidateInput): Promise<CreatedResourceProductWithCandidate> {
    const validated = validatedProductCreateInput(input);
    const createdBy = validatedResourceIdentity(input.createdBy);
    const canonical = canonicalizeResourcePack(input.content);
    const semanticHash = resourcePackSemanticHash(canonical.content).semanticHash;
    const data = await this.call(
      "agent_studio_resource_create_product_with_candidate",
      { p_input: { ...validated, content: canonical.content, createdBy, semanticHash } },
      { ambiguousTransport: true },
    );
    try {
      const row = object(data);
      const createdProduct = product(row.product);
      const candidate = pack(row.candidate);
      if (!matchesProductCreateInput(createdProduct, validated) ||
          candidate.resourceProductId !== createdProduct.id ||
          candidate.revision !== 1 || candidate.status !== "candidate" ||
          candidate.semanticHash !== semanticHash || candidate.createdBy !== createdBy) {
        throw new Error();
      }
      return Object.freeze({ product: createdProduct, candidate });
    } catch {
      throw new ResourceAmbiguousFinalCommitError();
    }
  }
  async getOwnedProduct(ownerId: string, productId: string): Promise<ResourceProduct | null> {
    const data = await this.call("agent_studio_resource_get_owned_product", { p_owner_id: ownerId, p_resource_product_id: productId });
    return data == null ? null : product(data);
  }
  async getOwnedPortfolioItem(ownerId: string, productId: string): Promise<ResourcePortfolioItem | null> {
    const data = await this.call("agent_studio_resource_get_owned_portfolio_item", {
      p_owner_id: ownerId, p_resource_product_id: productId,
    });
    return data == null ? null : resourcePortfolioItem(data);
  }
  async listOwnedProducts(ownerId: string): Promise<readonly ResourcePortfolioItem[]> {
    const data = await this.call("agent_studio_resource_list_owned_products", { p_owner_id: ownerId });
    if (!Array.isArray(data)) throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
    return Object.freeze(data.map(resourcePortfolioItem));
  }
  async listOwnedReleaseHistory(
    ownerId: string,
    resourceProductId: string,
    limit: number,
  ): Promise<readonly ResourceCurrentReleaseSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
    }
    const data = await this.call("agent_studio_resource_list_owned_releases", {
      p_owner_id: ownerId, p_resource_product_id: resourceProductId, p_limit: limit,
    });
    if (!Array.isArray(data) || data.length > limit) {
      throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
    }
    const seen = new Set<string>();
    return Object.freeze(data.map((value) => {
      const summary = currentReleaseSummary(value);
      if (!summary || summary.resourceProductId !== resourceProductId || seen.has(summary.id)) {
        throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
      }
      seen.add(summary.id);
      return summary;
    }));
  }
  async updateOwnedDraft(input: UpdateResourceProductInput): Promise<ResourceProduct> {
    return product(await this.call("agent_studio_resource_update_product", { p_input: input }));
  }
  async createSourceSnapshot(input: CreateSourceSnapshotInput): Promise<ResourceSourceSnapshot> {
    const row = object(await this.call("agent_studio_resource_create_source_snapshot", { p_input: input }));
    return parseSourceSnapshot({ id: row.id, resourceProductId: row.resource_product_id, locator: row.locator, sourceKind: row.source_kind, capturedAt: row.captured_at, ...(row.source_published_at == null ? {} : { sourcePublishedAt: row.source_published_at }), contentHash: row.content_hash, freshnessDeadline: row.freshness_deadline, ...(row.provenance == null ? {} : { provenance: row.provenance }), ...(row.provenance_note == null ? {} : { provenanceNote: row.provenance_note }) });
  }
  async createSourceSnapshotAndReplaceCandidate(
    input: CreateSourceSnapshotAndReplaceCandidateInput,
  ): Promise<CreatedSourceSnapshotAndCandidate> {
    if (input.snapshot.ownerId !== input.candidate.ownerId ||
        input.snapshot.resourceProductId !== input.candidate.resourceProductId) {
      throw new ResourceRepositoryConflictError();
    }
    const canonical = canonicalizeResourcePack(input.candidate.content);
    const semanticHash = resourcePackSemanticHash(canonical.content).semanticHash;
    const row = object(await this.call("agent_studio_resource_collect_source_candidate", {
      p_input: {
        snapshot: input.snapshot,
        candidate: { ...input.candidate, content: canonical.content, semanticHash },
      },
    }));
    const snapshotRow = object(row.snapshot);
    return Object.freeze({
      snapshot: parseSourceSnapshot({
        id: snapshotRow.id, resourceProductId: snapshotRow.resource_product_id,
        locator: snapshotRow.locator, sourceKind: snapshotRow.source_kind,
        capturedAt: snapshotRow.captured_at,
        ...(snapshotRow.source_published_at == null ? {} : { sourcePublishedAt: snapshotRow.source_published_at }),
        contentHash: snapshotRow.content_hash, freshnessDeadline: snapshotRow.freshness_deadline,
        ...(snapshotRow.provenance == null ? {} : { provenance: snapshotRow.provenance }),
        ...(snapshotRow.provenance_note == null ? {} : { provenanceNote: snapshotRow.provenance_note }),
      }),
      candidate: pack(row.candidate),
    });
  }
  async replaceCandidate(input: ReplaceCandidateInput): Promise<ResourcePackVersion> {
    const canonical = canonicalizeResourcePack(input.content);
    const semanticHash = resourcePackSemanticHash(canonical.content).semanticHash;
    return pack(await this.call("agent_studio_resource_replace_candidate", { p_input: { ...input, content: canonical.content, semanticHash } }));
  }
  async rejectCandidate(input: RejectCandidateInput): Promise<void> {
    await this.call("agent_studio_resource_reject_candidate", { p_input: input });
  }
  async approveCandidate(input: ApproveCandidateInput): Promise<ResourcePackVersion> {
    return pack(await this.call("agent_studio_resource_approve_candidate", { p_input: input }));
  }
  async getOwnedPack(reference: OwnedResourceQueryReference): Promise<ResourcePackBundle | null> {
    const data = await this.call("agent_studio_resource_get_owned_pack", { p_reference: reference });
    if (data == null) return null;
    const row = object(data);
    const version = pack(row.pack ?? row);
    if (typeof row.freshness !== "string") throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
    return Object.freeze({ resourceProductId: version.resourceProductId, packVersionId: version.id, semanticHash: version.semanticHash, freshness: row.freshness as ResourcePackBundle["freshness"], content: version.content });
  }
  async getOwnedSourceDisclosure(reference: OwnedResourceQueryReference) {
    const data = await this.call("agent_studio_resource_get_source_disclosure", { p_reference: reference });
    if (data == null) return null;
    const row = object(data);
    const sourceCount = row.source_count ?? row.sourceCount;
    const sourceKinds = row.source_kinds ?? row.sourceKinds;
    if (!Number.isSafeInteger(sourceCount) || (sourceCount as number) < 0 || !Array.isArray(sourceKinds) ||
        sourceKinds.some((kind) => typeof kind !== "string" || kind.length === 0 || kind.trim() !== kind) ||
        new Set(sourceKinds).size !== sourceKinds.length) {
      throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
    }
    return Object.freeze({
      sourceCount: sourceCount as number,
      sourceKinds: Object.freeze([...sourceKinds].sort((left, right) => (left as string).localeCompare(right as string)) as string[]),
    });
  }
  async getOwnedApprovedPack(ownerId: string, resourceProductId: string): Promise<ResourcePackBundle | null> {
    const data = await this.call("agent_studio_resource_get_owned_approved_pack", {
      p_owner_id: ownerId, p_resource_product_id: resourceProductId,
    });
    if (data == null) return null;
    const row = object(data);
    const version = pack(row.pack ?? row);
    if (typeof row.freshness !== "string" || version.status !== "approved") {
      throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
    }
    return Object.freeze({ resourceProductId: version.resourceProductId, packVersionId: version.id, semanticHash: version.semanticHash, freshness: row.freshness as ResourcePackBundle["freshness"], content: version.content });
  }
  async createRelease(input: CreateResourceReleaseInput): Promise<ResourceRelease> {
    const data = await this.call(
      "agent_studio_resource_create_release",
      { p_input: input },
      { ambiguousTransport: true },
    );
    try {
      const created = releaseResult(data);
      if (!matchesReleaseInput(created, input)) throw new MalformedResourceReleaseResultError();
      return created;
    } catch (error) {
      if (isClassifiedRepositoryError(error)) throw error;
      throw new ResourceAmbiguousFinalCommitError();
    }
  }
  async transitionReleaseLifecycle(
    input: TransitionResourceReleaseLifecycleInput,
  ): Promise<TransitionResourceReleaseLifecycleResult> {
    const data = await this.call(
      "agent_studio_resource_transition_release_lifecycle",
      { p_input: input },
      { ambiguousTransport: true },
    );
    try {
      const row = object(data);
      const transitionedProduct = product(row.product);
      const transitionedRelease = releaseResult(row.release);
      const expectedStatus = input.action === "pause"
        ? "paused"
        : input.action === "resume" ? "live" : "retired";
      if (transitionedProduct.id !== input.resourceProductId ||
          transitionedProduct.ownerId !== input.ownerId ||
          transitionedProduct.status !== expectedStatus ||
          transitionedRelease.id !== input.releaseId ||
          transitionedRelease.ownerId !== input.ownerId ||
          transitionedRelease.resourceProductId !== input.resourceProductId ||
          transitionedRelease.agentId !== input.agentId ||
          transitionedRelease.deploymentId !== input.deploymentId) {
        throw new MalformedResourceReleaseResultError();
      }
      return Object.freeze({ product: transitionedProduct, release: transitionedRelease });
    } catch {
      throw new ResourceAmbiguousFinalCommitError();
    }
  }
  async getPublishedReleaseByAgent(agentId: string): Promise<ResourceRelease | null> {
    const data = await this.call("agent_studio_resource_get_release_by_agent", { p_agent_id: agentId });
    return data == null ? null : release(data);
  }
  async listPublishedReleasesByAgentIds(agentIds: readonly string[]): Promise<readonly ResourceRelease[]> {
    const ids = [...new Set(agentIds.filter((id) => id.length > 0))];
    if (ids.length === 0) return Object.freeze([]);
    const data = await this.call("agent_studio_resource_list_releases_by_agents", {
      p_agent_ids: ids,
    });
    if (!Array.isArray(data)) {
      throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
    }
    const requested = new Set(ids);
    const seen = new Set<string>();
    const releases = data.map(release);
    if (releases.some((item) => !requested.has(item.agentId) || seen.has(item.agentId) || !seen.add(item.agentId))) {
      throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
    }
    return Object.freeze(releases);
  }
  async getOwnedPublishedReleaseByPublicationKey(
    ownerId: string,
    resourceProductId: string,
    publicationKey: string,
  ): Promise<ResourceRelease | null> {
    const data = await this.call("agent_studio_resource_get_release_by_publication", {
      p_owner_id: ownerId,
      p_resource_product_id: resourceProductId,
      p_publication_key: publicationKey,
    });
    return data == null ? null : release(data);
  }
  async recordRunReceipt(input: CreateResourceRunReceiptInput): Promise<ResourceRunReceipt> {
    return receipt(await this.call("agent_studio_resource_record_run_receipt", { p_input: input }));
  }
  async listRunReceipts(ownerId: string, productId: string): Promise<readonly ResourceRunReceipt[]> {
    const data = await this.call("agent_studio_resource_list_run_receipts", { p_owner_id: ownerId, p_resource_product_id: productId });
    if (!Array.isArray(data)) throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
    return Object.freeze(data.map(receipt));
  }
  async adoptOwner(fromOwnerId: string, toOwnerId: string): Promise<void> {
    if (fromOwnerId === toOwnerId) return;
    await this.call("agent_studio_adopt_owner_with_connections", { p_from_owner_id: fromOwnerId, p_to_owner_id: toOwnerId });
  }
}
