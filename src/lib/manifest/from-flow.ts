import { topoSort } from "@/lib/flow/engine";
import { isFlowGraphV2 } from "@/lib/flow/graph-schema";
import type { FlowGraph, FlowGraphV2 } from "@/lib/flow/types";
import { AgentManifestSchema } from "./schema";
import { PortableAgentManifestV2Schema } from "./portable-schema";
import type {
  AfterEntry,
  AgentManifest,
  AgentManifestV2,
  ManifestStep,
  ManifestTrigger,
  ManifestVersionMetadata,
} from "./schema";
import { getAttachedManifestVersionMetadata } from "./version-metadata";
import { getManifestV2Provenance } from "./v2-provenance";
import { assertGraphPortReferences } from "@/lib/flow/node-ports";
import { assertPortableSubflowDependencies } from "@/lib/projects/subflow-dependencies";
import { assertPortableResourceDependencies } from "@/lib/projects/resource-dependencies";
import type { ConnectorOperationClosure } from "@/lib/connectors/repository";
import { graphContainsApiOperation } from "@/lib/connectors/operation-closure";
import { ApiOperationV1UnsupportedError } from "@/lib/flow/api-operation-contract";
import {
  buildPortableConnectorExport,
  closureFromConnectorBundle,
  type ConnectorDependencyBundleV1,
} from "./connector-bundle";
import type { ApiOperationReference } from "@/lib/connectors/operation-closure";

export interface FlowToManifestOptions {
  readonly versionMetadata?: ManifestVersionMetadata;
  readonly resolveApiOperation?: (
    reference: ApiOperationReference,
    nodeId: string,
  ) => ConnectorOperationClosure;
}

/**
 * Compile a FlowGraph into an AgentManifest.
 *
 * Trigger detection:
 * - If a "schedule" node exists → schedule trigger (cron from node.params.cron).
 * - Otherwise → paidCall trigger with priceUsdc: 0 (launch path overrides price).
 *
 * Steps: all non-schedule nodes, ordered topologically then id-lexicographic.
 * After: derived from incoming edges (edge.source values for edges targeting each node),
 *        excluding any schedule node (it becomes a trigger, not a step dependency).
 */
export function flowToManifest(
  graph: FlowGraphV2,
  options?: FlowToManifestOptions,
): AgentManifestV2;
export function flowToManifest(
  graph: FlowGraph,
  options?: FlowToManifestOptions,
): AgentManifest;
export function flowToManifest(
  graph: FlowGraph | FlowGraphV2,
  options: FlowToManifestOptions = {},
): AgentManifest | AgentManifestV2 {
  if (Reflect.get(graph, "schemaVersion") === 2 && !isFlowGraphV2(graph)) {
    throw new Error("Cannot compile an invalid schemaVersion 2 flow graph");
  }
  if (isFlowGraphV2(graph)) {
    assertGraphPortReferences(graph);
    const provenance = getManifestV2Provenance(graph);
    if (provenance && options.versionMetadata === undefined && !graphContainsApiOperation(graph)) {
      assertPortableSubflowDependencies(graph, provenance.dependencies ?? []);
      assertPortableResourceDependencies(graph, provenance.dependencies ?? []);
      return PortableAgentManifestV2Schema.parse(provenance);
    }

    let manifestGraph = graph;
    let connectorBundles: readonly ConnectorDependencyBundleV1[] | undefined;
    if (graphContainsApiOperation(graph)) {
      const provenanceBundles = new Map(
        (provenance?.connectorBundles ?? []).map((value) => {
          const bundle = value as ConnectorDependencyBundleV1;
          return [bundle.operation.id, bundle] as const;
        }),
      );
      const portable = buildPortableConnectorExport(graph, (reference, nodeId) => {
        if (options.resolveApiOperation !== undefined) {
          return options.resolveApiOperation(reference, nodeId);
        }
        const bundle = provenanceBundles.get(reference.operationVersionId);
        if (bundle === undefined) {
          throw new TypeError("Portable connector dependency bundle is required");
        }
        return closureFromConnectorBundle(bundle);
      });
      manifestGraph = portable.graph;
      connectorBundles = portable.bundles;
    }

    const metaTriggers = Array.isArray(graph.meta?.triggers)
      ? (graph.meta.triggers as ManifestTrigger[])
      : null;
    const versionMetadata = options.versionMetadata;
    assertPortableSubflowDependencies(manifestGraph, versionMetadata?.dependencies ?? []);
    assertPortableResourceDependencies(manifestGraph, versionMetadata?.dependencies ?? []);
    return PortableAgentManifestV2Schema.parse({
      manifestVersion: 2,
      schemaVersion: 2,
      ...(versionMetadata?.resourceVersion === undefined
        ? {}
        : { resourceVersion: versionMetadata.resourceVersion }),
      ...(versionMetadata?.dependencies === undefined
        ? {}
        : { dependencies: versionMetadata.dependencies }),
      name: provenance?.name ?? graph.name,
      description:
        provenance?.description ??
        (typeof graph.meta?.description === "string" ? graph.meta.description : ""),
      triggers: provenance?.triggers ?? metaTriggers ?? [{ kind: "paidCall", priceUsdc: 0 }],
      graph: manifestGraph,
      ...(connectorBundles === undefined ? {} : { connectorBundles }),
      ...(provenance?.payoutAddress !== undefined
        ? { payoutAddress: provenance.payoutAddress }
        : typeof graph.meta?.payoutAddress === "string"
          ? { payoutAddress: graph.meta.payoutAddress }
          : {}),
      meta:
        provenance?.meta ??
        {
          ...(typeof graph.meta?.template === "string" ? { template: graph.meta.template } : {}),
          ...(graph.meta?.createdBy === "guided" ||
          graph.meta?.createdBy === "studio" ||
          graph.meta?.createdBy === "code"
            ? { createdBy: graph.meta.createdBy }
            : {}),
        },
    });
  }
  if (graphContainsApiOperation(graph)) throw new ApiOperationV1UnsupportedError();
  const scheduleNode = graph.nodes.find((n) => n.type === "schedule");

  // Reconstruct triggers: schedule node → schedule trigger; non-schedule triggers are
  // stored in graph.meta.triggers by manifestToFlow for lossless round-trips.
  // For flows built natively in the studio (no meta.triggers), default to paidCall.
  const metaTriggers = Array.isArray(graph.meta?.triggers)
    ? (graph.meta.triggers as ManifestTrigger[])
    : null;

  const triggers: ManifestTrigger[] = [
    ...(scheduleNode
      ? [{ kind: "schedule" as const, cron: String(scheduleNode.params.cron ?? "0 * * * *") }]
      : []),
    ...(metaTriggers ? metaTriggers : !scheduleNode ? [{ kind: "paidCall" as const, priceUsdc: 0 }] : []),
  ];

  // Topological order for determinism; tie-break by id lexicographic within same topo rank
  const topoOrder = topoSort(graph);
  const orderIndex = new Map(topoOrder.map((id, i) => [id, i]));

  const stepNodes = graph.nodes
    .filter((n) => n.type !== "schedule")
    .sort((a, b) => {
      const ai = orderIndex.get(a.id) ?? 0;
      const bi = orderIndex.get(b.id) ?? 0;
      return ai !== bi ? ai - bi : a.id.localeCompare(b.id);
    });

  const steps: ManifestStep[] = stepNodes.map((flowNode) => {
    const incomingEdges = graph.edges.filter((e) => e.target === flowNode.id);
    const after: AfterEntry[] = incomingEdges
      // Exclude the schedule node from `after` lists — it's a trigger, not a step
      .filter((e) => e.source !== scheduleNode?.id)
      // Only record the source handle when it's set to something other than
      // the default -- this keeps manifests for ordinary linear flows (every
      // node has one implicit output) byte-identical to the pre-handle
      // format. A handle only shows up here for edges that left a node with
      // more than one named output on something other than its default one,
      // e.g. a `branch` node's "true"/"false" or a `loop` node's "errors".
      .map((e): AfterEntry => (e.sourceHandle ? { node: e.source, handle: e.sourceHandle } : e.source))
      .sort((a, b) => {
        // Same ordering as the old plain `.sort()` on source ids, with the
        // handle as a tiebreaker so output stays deterministic when a
        // single source feeds a step on more than one handle.
        const aKey = typeof a === "string" ? a : `${a.node}\u0000${a.handle ?? ""}`;
        const bKey = typeof b === "string" ? b : `${b.node}\u0000${b.handle ?? ""}`;
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
      });
    return {
      id: flowNode.id,
      type: flowNode.type,
      config: { ...flowNode.params },
      after,
    };
  });

  const versionMetadata = options.versionMetadata ?? getAttachedManifestVersionMetadata(graph);
  const raw = {
    manifestVersion: 1 as const,
    ...(versionMetadata ?? {}),
    name: graph.name,
    description: typeof graph.meta?.description === "string" ? graph.meta.description : "",
    triggers,
    steps,
    ...(graph.meta?.payoutAddress !== undefined
      ? { payoutAddress: String(graph.meta.payoutAddress) }
      : {}),
    meta: {
      ...(typeof graph.meta?.template === "string" ? { template: graph.meta.template } : {}),
      ...(typeof graph.meta?.createdBy === "string"
        ? { createdBy: graph.meta.createdBy as "guided" | "studio" | "code" }
        : {}),
    },
  };

  return AgentManifestSchema.parse(raw);
}
