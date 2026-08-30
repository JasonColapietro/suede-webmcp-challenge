import type Database from "better-sqlite3";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import { resourcePackSemanticHash } from "@/lib/resources/pack-hash";
import { parseResourcePackBundle } from "@/lib/resources/query";
import { parseResourcePackContent } from "@/lib/resources/schemas";
import type { ResourcePackBundle, ResourcePackStatus } from "@/lib/resources/types";
import type { ResourceRepository } from "@/lib/resources/repository";
import type { DependencyPinInput } from "./types";
import {
  RESOURCE_DEPENDENCY_ERROR,
  type ResourcePackResolutionReference,
  assertPortableResourceDependencies,
  resourceDependencyPinsFromGraph,
} from "./resource-dependency-contract";

export {
  RESOURCE_DEPENDENCY_ERROR,
  type ResourcePackResolutionReference,
  assertPortableResourceDependencies,
  rejectCallerResourceDependencies,
  resourceDependencyPinsFromGraph,
} from "./resource-dependency-contract";

const SHA256 = /^[a-f0-9]{64}$/u;
const ACTIVE_PACK_STATUSES = new Set<ResourcePackStatus>(["approved", "live"]);

export interface ResolvedOwnedResourcePack {
  readonly status: ResourcePackStatus;
  readonly bundle: ResourcePackBundle;
}

export interface ExactFreshResourcePackSnapshotEntry {
  readonly reference: ResourcePackResolutionReference;
  readonly resolved: ResolvedOwnedResourcePack;
}

export type OwnerScopedResourcePackResolver = (
  reference: ResourcePackResolutionReference,
) => ResolvedOwnedResourcePack | null | Promise<ResolvedOwnedResourcePack | null>;

function refused(): never {
  throw new TypeError(RESOURCE_DEPENDENCY_ERROR);
}

function assertResolved(
  reference: ResourcePackResolutionReference,
  resolved: ResolvedOwnedResourcePack | null,
): ResolvedOwnedResourcePack {
  if (!resolved || !ACTIVE_PACK_STATUSES.has(resolved.status)) refused();
  const { bundle } = resolved;
  if (
    bundle.resourceProductId !== reference.resourceProductId ||
    bundle.packVersionId !== reference.packVersionId ||
    bundle.semanticHash !== reference.contentHash ||
    resourcePackSemanticHash(bundle.content).semanticHash !== reference.contentHash
  ) refused();
  return resolved;
}

function referenceForPin(pin: DependencyPinInput): ResourcePackResolutionReference {
  if (pin.kind !== "resource" || !pin.contentHash || !SHA256.test(pin.contentHash)) refused();
  return {
    resourceProductId: pin.resourceId,
    packVersionId: pin.version,
    contentHash: pin.contentHash,
  };
}

export async function derivePinnedResourceDependencies(
  graph: SupportedFlowGraph,
  resolver: OwnerScopedResourcePackResolver,
): Promise<readonly DependencyPinInput[]> {
  const pins = resourceDependencyPinsFromGraph(graph);
  for (const pin of pins) {
    const reference = referenceForPin(pin);
    assertResolved(reference, await resolver(reference));
  }
  return pins;
}

export function derivePinnedResourceDependenciesSync(
  graph: SupportedFlowGraph,
  resolver: OwnerScopedResourcePackResolver,
): readonly DependencyPinInput[] {
  const pins = resourceDependencyPinsFromGraph(graph);
  for (const pin of pins) {
    const reference = referenceForPin(pin);
    const result = resolver(reference);
    if (result instanceof Promise) refused();
    assertResolved(reference, result);
  }
  return pins;
}

export async function assertPinnedResourceDependenciesCurrent(
  graph: SupportedFlowGraph,
  dependencies: readonly DependencyPinInput[],
  resolver: OwnerScopedResourcePackResolver,
): Promise<void> {
  assertPortableResourceDependencies(graph, dependencies);
  for (const pin of dependencies.filter((candidate) => candidate.kind === "resource")) {
    const reference = referenceForPin(pin);
    assertResolved(reference, await resolver(reference));
  }
}

export function assertPinnedResourceDependenciesCurrentSync(
  graph: SupportedFlowGraph,
  dependencies: readonly DependencyPinInput[],
  resolver: OwnerScopedResourcePackResolver,
): void {
  assertPortableResourceDependencies(graph, dependencies);
  for (const pin of dependencies.filter((candidate) => candidate.kind === "resource")) {
    const reference = referenceForPin(pin);
    const result = resolver(reference);
    if (result instanceof Promise) refused();
    assertResolved(reference, result);
  }
}

export function createOwnerScopedResourcePackResolver(
  ownerId: string,
  repository: ResourceRepository,
): OwnerScopedResourcePackResolver {
  const scopedOwner = ownerId.trim();
  if (scopedOwner.length === 0) return async () => null;
  return async (reference) => {
    const bundle = await repository.getOwnedPack({
      ownerId: scopedOwner,
      resourceProductId: reference.resourceProductId,
      packVersionId: reference.packVersionId,
      semanticHash: reference.contentHash,
    });
    if (!bundle) return null;
    // Read the current pointers after the exact pack so an approval superseded
    // during resolution fails closed instead of executing the older revision.
    const products = await repository.listOwnedProducts(scopedOwner);
    const product = products.find((item) => item.id === reference.resourceProductId);
    if (!product) return null;
    const status: ResourcePackStatus | null = product.livePackVersionId === reference.packVersionId
      ? "live"
      : product.approvedPackVersionId === reference.packVersionId
        ? "approved"
        : null;
    return status ? Object.freeze({ status, bundle }) : null;
  };
}

/**
 * Read and detach the exact current Resource closure at the last mutation-free
 * boundary. Callers bind these objects into one prepared execution rather
 * than reopening mutable persistence after payment begins.
 */
export async function loadExactFreshResourcePackSnapshot(
  ownerId: string,
  repository: ResourceRepository,
  references: readonly ResourcePackResolutionReference[],
): Promise<readonly ExactFreshResourcePackSnapshotEntry[] | null> {
  try {
    const resolver = createOwnerScopedResourcePackResolver(ownerId, repository);
    const byProduct = new Map<string, ExactFreshResourcePackSnapshotEntry>();
    for (const reference of references) {
      if (byProduct.has(reference.resourceProductId)) return null;
      const resolved = assertResolved(reference, await resolver(reference));
      const bundle = parseResourcePackBundle(resolved.bundle);
      if (bundle.freshness !== "fresh") return null;
      byProduct.set(reference.resourceProductId, Object.freeze({
        reference: Object.freeze({ ...reference }),
        resolved: Object.freeze({ status: resolved.status, bundle }),
      }));
    }
    return Object.freeze([...byProduct.values()].sort((left, right) =>
      left.reference.resourceProductId.localeCompare(right.reference.resourceProductId)));
  } catch {
    return null;
  }
}

export function createSqliteOwnerScopedResourcePackResolver(
  db: Database.Database,
  ownerId: string,
): OwnerScopedResourcePackResolver {
  const scopedOwner = ownerId.trim();
  return (reference) => {
    if (scopedOwner.length === 0) return null;
    const row = db.prepare(
      `SELECT v.status, v.content_json
       FROM resource_pack_versions v
       JOIN resource_products p ON p.id = v.resource_product_id
       WHERE p.owner_id = ? AND p.id = ? AND v.id = ? AND v.semantic_hash = ?
         AND (
           (v.status = 'approved' AND v.id = (
             SELECT current_approved.id
             FROM resource_pack_versions current_approved
             WHERE current_approved.resource_product_id = p.id
               AND current_approved.status = 'approved'
             ORDER BY current_approved.revision DESC, current_approved.id DESC
             LIMIT 1
           ))
           OR
           (v.status = 'live' AND v.id = (
             SELECT current_live.id
             FROM resource_pack_versions current_live
             WHERE current_live.resource_product_id = p.id
               AND current_live.status = 'live'
             ORDER BY current_live.revision DESC, current_live.id DESC
             LIMIT 1
           ))
         )`,
    ).get(
      scopedOwner,
      reference.resourceProductId,
      reference.packVersionId,
      reference.contentHash,
    ) as { status: ResourcePackStatus; content_json: string } | undefined;
    if (!row) return null;
    let content;
    try {
      content = parseResourcePackContent(JSON.parse(row.content_json));
    } catch {
      return null;
    }
    if (resourcePackSemanticHash(content).semanticHash !== reference.contentHash) return null;
    return Object.freeze({
      status: row.status,
      bundle: Object.freeze({
        resourceProductId: reference.resourceProductId,
        packVersionId: reference.packVersionId,
        semanticHash: reference.contentHash,
        freshness: "mixed" as const,
        content,
      }),
    });
  };
}
