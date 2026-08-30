import { afterHandle, afterNodeId } from "./schema";
import { type AgentManifest, type AgentManifestV2 } from "./schema";
import { PortableAgentManifestV2Schema } from "./portable-schema";
import type { FlowGraph, FlowGraphV2, FlowEdge, FlowNode } from "@/lib/flow/types";
import {
  attachManifestVersionMetadata,
  versionMetadataFromManifest,
} from "./version-metadata";
import { attachManifestV2Provenance } from "./v2-provenance";
import { randomUUID } from "node:crypto";
import type {
  ConnectorDefinitionVersionV1,
  OperationVersionV1,
} from "@/lib/connectors/types";
import type { ConnectorRepository } from "@/lib/connectors/repository";
import {
  assertPortableConnectorDependencies,
  parseConnectorDependencyBundle,
  type ConnectorDependencyBundleV1,
} from "./connector-bundle";
import { parseApiOperationReference } from "@/lib/connectors/operation-closure";
import { ApiOperationV1UnsupportedError } from "@/lib/flow/api-operation-contract";
import { createAuditCorrelation } from "@/lib/audit/repository";

const ROW_Y = 120;
const COL = 240;

function colX(index: number): number {
  return 80 + index * COL;
}

/**
 * Compile an AgentManifest back into a FlowGraph.
 *
 * Schedule trigger → prepended "trig-schedule" node wired to steps with empty after[].
 * paidCall/manual/webhook → no extra node; input comes from the first step in the graph.
 * Edges: derived from step.after (each entry creates an edge src→step.id with targetHandle "in").
 * Graph id: "mf-" + slugified manifest name.
 */
export function manifestToFlow(manifest: AgentManifestV2): FlowGraphV2;
export function manifestToFlow(manifest: AgentManifest): FlowGraph;
export function manifestToFlow(manifest: AgentManifest | AgentManifestV2): FlowGraph | FlowGraphV2 {
  if (manifest.manifestVersion === 2) {
    assertPortableConnectorDependencies(manifest.graph, manifest.connectorBundles);
    PortableAgentManifestV2Schema.parse(manifest);
    return attachManifestV2Provenance(manifest.graph, manifest);
  }
  if (manifest.steps.some((step) => step.type === "api.operation")) {
    throw new ApiOperationV1UnsupportedError();
  }
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  const scheduleTrigger = manifest.triggers.find((t) => t.kind === "schedule");
  const scheduleNodeId = "trig-schedule";

  // Add schedule node first if the trigger is a schedule
  if (scheduleTrigger?.kind === "schedule") {
    nodes.push({
      id: scheduleNodeId,
      type: "schedule",
      params: { cron: scheduleTrigger.cron },
      position: { x: colX(0), y: ROW_Y },
    });
  }

  // Add step nodes (offset position by 1 if schedule node was added)
  const positionOffset = scheduleTrigger ? 1 : 0;
  manifest.steps.forEach((step, i) => {
    nodes.push({
      id: step.id,
      type: step.type as FlowNode["type"],
      params: { ...step.config },
      position: { x: colX(i + positionOffset), y: ROW_Y },
    });
  });

  // Add edges from step.after arrays
  for (const step of manifest.steps) {
    for (const entry of step.after) {
      const srcId = afterNodeId(entry);
      const handle = afterHandle(entry);
      edges.push({
        // Handle-tagged entries get a distinct edge id so two edges from the
        // same source on different handles into the same target don't collide.
        id: handle ? `${srcId}:${handle}->${step.id}` : `${srcId}->${step.id}`,
        source: srcId,
        target: step.id,
        targetHandle: "in",
        ...(handle ? { sourceHandle: handle } : {}),
      });
    }
    // Wire schedule node to steps with no after entries
    if (scheduleTrigger && step.after.length === 0) {
      edges.push({
        id: `${scheduleNodeId}->${step.id}`,
        source: scheduleNodeId,
        target: step.id,
        targetHandle: "in",
      });
    }
  }

  // Build graph id from name (slug)
  const slugId = "mf-" + manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Preserve non-schedule trigger info in meta so flowToManifest can round-trip losslessly.
  // schedule triggers are already captured by the schedule node; manual/paidCall/webhook
  // have no canvas representation and must ride the meta.
  const nonScheduleTriggers = manifest.triggers.filter((t) => t.kind !== "schedule");

  const graph: FlowGraph = {
    id: slugId,
    name: manifest.name,
    nodes,
    edges,
    meta: {
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.payoutAddress ? { payoutAddress: manifest.payoutAddress } : {}),
      ...manifest.meta,
      ...(nonScheduleTriggers.length > 0
        ? { triggers: nonScheduleTriggers }
        : {}),
    },
  };
  return attachManifestVersionMetadata(graph, versionMetadataFromManifest(manifest));
}

export interface PortableManifestImportOptions {
  readonly ownerId: string;
  readonly actorId: string;
  readonly repository: ConnectorRepository;
  readonly now?: number;
  readonly createId?: () => string;
}

function importedDisplayLabel(definition: ConnectorDefinitionVersionV1): string {
  let host = "connector";
  try {
    host = new URL(definition.projection.origin).hostname;
  } catch {
    // The strict connector parser already validates the origin. Keep the fallback bounded.
  }
  return `Imported ${host}`.slice(0, 120);
}

/**
 * Imports a validated v2 manifest into one owner-local connector namespace.
 * All immutable asset writes share one repository transaction. The returned
 * graph contains only local version ids and unresolved semantic bindings.
 */
export function importPortableAgentManifestV2(
  manifestValue: AgentManifestV2,
  options: PortableManifestImportOptions,
): FlowGraphV2 {
  if (typeof options.ownerId !== "string" || options.ownerId.length < 1 || options.ownerId.length > 512) {
    throw new TypeError("Invalid portable connector owner");
  }
  const bundles = assertPortableConnectorDependencies(
    manifestValue.graph,
    manifestValue.connectorBundles,
  );
  const manifest = PortableAgentManifestV2Schema.parse({
    ...manifestValue,
    ...(manifestValue.connectorBundles === undefined ? {} : { connectorBundles: bundles }),
  });
  if (bundles.length === 0) return attachManifestV2Provenance(manifest.graph, manifest);
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid portable connector timestamp");

  const preparedIds = bundles.map(() => Object.freeze({
    connectorId: createId(),
    definitionVersionId: createId(),
    operationVersionId: createId(),
  }));
  const auditCorrelations = bundles.map(() => createAuditCorrelation(options.ownerId, options.actorId));

  const localBySourceOperation = options.repository.immediate((transaction) => {
    const definitions = new Map<string, ConnectorDefinitionVersionV1 | null>();
    const result = new Map<string, {
      readonly definition: ConnectorDefinitionVersionV1;
      readonly operation: OperationVersionV1;
    }>();
    bundles.forEach((sourceValue, index) => {
      const source = parseConnectorDependencyBundle(sourceValue);
      const hash = source.definition.connectorProjectionHash;
      const lookupKey = JSON.stringify([
        hash,
        source.operation.operationId,
        source.operation.authorAnnotation ?? null,
      ]);
      let definition = definitions.has(lookupKey)
        ? definitions.get(lookupKey) ?? null
        : transaction.findActiveDefinitionForOperation(
            options.ownerId,
            hash,
            source.operation.operationId,
            source.operation.authorAnnotation,
          );
      definitions.set(lookupKey, definition);
      let operation: OperationVersionV1;
      const ids = preparedIds[index]!;
      if (definition === null) {
        const persisted = transaction.persistCompiledImport({
          ownerId: options.ownerId,
          connectorId: null,
          newConnectorId: ids.connectorId,
          definitionVersionId: ids.definitionVersionId,
          operationVersionId: ids.operationVersionId,
          displayLabel: importedDisplayLabel(source.definition),
          connectorProjection: source.definition.projection,
          connectorProjectionHash: source.definition.connectorProjectionHash,
          operation: {
            operationId: source.operation.operationId,
            projection: source.operation.projection,
            operationProjectionHash: source.operation.operationProjectionHash,
            schemaHash: source.operation.schemaHash,
          },
          ...(source.operation.authorAnnotation === undefined
            ? {}
            : { authorAnnotation: source.operation.authorAnnotation }),
          now,
        });
        if (persisted.status !== "ok") throw new TypeError("Portable connector import refused");
        definition = persisted.definition;
        operation = persisted.operation;
        definitions.set(lookupKey, definition);
      } else {
        const materialized = transaction.materializeStoredOperation({
          ownerId: options.ownerId,
          connectorDefinitionVersionId: definition.id,
          operationId: source.operation.operationId,
          operationVersionId: ids.operationVersionId,
          ...(source.operation.authorAnnotation === undefined
            ? {}
            : { authorAnnotation: source.operation.authorAnnotation }),
          now,
        });
        if (materialized.status !== "ok") throw new TypeError("Portable connector import refused");
        operation = materialized.operation;
      }
      const exact = transaction.getOperationClosure(options.ownerId, operation.id);
      if (!exact || exact.identity.archivedAt !== null ||
          exact.definition.connectorProjectionHash !== source.definition.connectorProjectionHash ||
          exact.operation.operationProjectionHash !== source.operation.operationProjectionHash ||
          exact.operation.schemaHash !== source.operation.schemaHash) {
        throw new TypeError("Portable connector import refused");
      }
      const correlation = auditCorrelations[index]!;
      try {
        transaction.appendAudit({
          correlation,
          action: "connector.import",
          resource: {
            kind: "connector_definition",
            id: exact.identity.id,
            versionId: exact.definition.id,
            projectionHash: exact.definition.connectorProjectionHash,
            schemaHash: null,
          },
          outcome: "completed",
          errorCode: null,
          connection: null,
          durationMs: 0,
        });
        transaction.appendAudit({
          correlation,
          action: "connector.operation.create",
          resource: {
            kind: "operation_version",
            id: exact.operation.id,
            versionId: exact.operation.id,
            projectionHash: exact.operation.operationProjectionHash,
            schemaHash: exact.operation.schemaHash,
          },
          outcome: "completed",
          errorCode: null,
          connection: null,
          durationMs: 0,
        });
      } catch {
        throw new TypeError("Portable connector import refused");
      }
      result.set(source.operation.id, Object.freeze({ definition, operation }));
    });
    return result;
  });

  const localGraph: FlowGraphV2 = {
    ...manifest.graph,
    nodes: manifest.graph.nodes.map((node) => {
      if (node.type !== "api.operation") return node;
      const source = parseApiOperationReference(node.params);
      const local = localBySourceOperation.get(source.operationVersionId);
      if (!local) throw new TypeError("Portable connector import refused");
      return {
        ...node,
        params: {
          ...source,
          connectorDefinitionVersionId: local.definition.id,
          operationVersionId: local.operation.id,
        },
      };
    }),
  };
  const localBundles: readonly ConnectorDependencyBundleV1[] = bundles.map((source) => {
    const local = localBySourceOperation.get(source.operation.id);
    if (!local) throw new TypeError("Portable connector import refused");
    return Object.freeze({
      bundleVersion: 1,
      definition: local.definition,
      operation: local.operation,
    });
  });
  const localManifest = PortableAgentManifestV2Schema.parse({
    ...manifest,
    graph: localGraph,
    connectorBundles: localBundles,
  });
  return attachManifestV2Provenance(localGraph, localManifest);
}
