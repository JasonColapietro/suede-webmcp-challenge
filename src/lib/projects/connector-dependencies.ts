import type { ConnectorRepository } from "@/lib/connectors/repository";
import {
  parseApiOperationReference,
  resolveApiOperationClosure,
  ApiOperationAssetUnavailableError,
  type OperationClosureSnapshot,
} from "@/lib/connectors/operation-closure";
import { isFlowGraphV2 } from "@/lib/flow/graph-schema";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import type { DependencyPinInput } from "./types";
import {
  compareDependencyContent,
  normalizeDependencyPins,
} from "./version-input";
import {
  derivePinnedFlowDependencies,
  rejectCallerFlowDependencies,
} from "./subflow-dependencies";

export type ConnectorClosureReader = Pick<ConnectorRepository, "getOperationClosure">;

const MAX_PINNED_CONNECTOR_REFERENCES = 250;

export function rejectCallerConnectorDependencies(
  dependencies: readonly DependencyPinInput[] | undefined,
): void {
  if (dependencies?.some((dependency) => dependency.kind === "connector")) {
    throw new TypeError("Connector dependency pins are server-derived and cannot be caller supplied");
  }
}

export function connectorDependencyPinsForSnapshot(
  snapshot: OperationClosureSnapshot,
): readonly DependencyPinInput[] {
  return Object.freeze([
    Object.freeze({
      kind: "connector" as const,
      resourceId: `definition/${snapshot.definition.id}`,
      version: snapshot.definition.id,
      contentHash: snapshot.definition.connectorProjectionHash,
    }),
    Object.freeze({
      kind: "connector" as const,
      resourceId: `operation/${snapshot.operation.id}`,
      version: snapshot.operation.id,
      contentHash: snapshot.operation.operationProjectionHash,
    }),
    Object.freeze({
      kind: "connector" as const,
      resourceId: `schema/${snapshot.operation.id}`,
      version: snapshot.operation.id,
      contentHash: snapshot.operation.schemaHash,
    }),
  ]);
}

export function derivePinnedConnectorDependencies(
  graph: SupportedFlowGraph,
  ownerId: string,
  reader: ConnectorClosureReader,
): DependencyPinInput[] {
  if (!isFlowGraphV2(graph)) return [];
  const byResource = new Map<string, DependencyPinInput>();
  let references = 0;
  for (const node of graph.nodes) {
    if (node.type !== "api.operation") continue;
    references += 1;
    if (references > MAX_PINNED_CONNECTOR_REFERENCES) {
      throw new TypeError("Too many pinned connector references");
    }
    const reference = parseApiOperationReference(node.params);
    const snapshot = resolveApiOperationClosure(reader, ownerId, reference);
    if (snapshot.identity.archivedAt !== null) throw new ApiOperationAssetUnavailableError();
    for (const dependency of connectorDependencyPinsForSnapshot(snapshot)) {
      const existing = byResource.get(dependency.resourceId);
      if (
        existing !== undefined &&
        (existing.version !== dependency.version || existing.contentHash !== dependency.contentHash)
      ) {
        throw new TypeError("Conflicting pinned connector dependency");
      }
      byResource.set(dependency.resourceId, dependency);
    }
  }
  return [...byResource.values()].sort(compareDependencyContent);
}

export function mergeServerDerivedDependencies(
  graph: SupportedFlowGraph,
  ownerId: string,
  reader: ConnectorClosureReader,
  callerDependencies: readonly DependencyPinInput[] = [],
): DependencyPinInput[] {
  rejectCallerFlowDependencies(callerDependencies);
  rejectCallerConnectorDependencies(callerDependencies);
  return normalizeDependencyPins([
    ...callerDependencies.map((dependency) => ({ ...dependency })),
    ...derivePinnedFlowDependencies(graph),
    ...derivePinnedConnectorDependencies(graph, ownerId, reader),
  ]);
}

export function assertPinnedConnectorDependenciesCurrent(
  graph: SupportedFlowGraph,
  ownerId: string,
  reader: ConnectorClosureReader,
  dependencies: readonly DependencyPinInput[],
): void {
  const expected = derivePinnedConnectorDependencies(graph, ownerId, reader);
  const actual = dependencies
    .filter((dependency) => dependency.kind === "connector")
    .map((dependency) => ({ ...dependency }))
    .sort(compareDependencyContent);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ApiOperationAssetUnavailableError();
  }
}
