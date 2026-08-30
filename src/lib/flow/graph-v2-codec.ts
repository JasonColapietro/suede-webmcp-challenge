import { isFlowGraphV2 } from "./graph-schema";
import {
  API_OPERATION_V1_UNSUPPORTED,
  graphContainsApiOperation,
} from "./api-operation-contract";
import { getNodeDefinition } from "./node-definitions";
import {
  createValidatedNodePortResolver,
  type ValidatedNodePortResolver,
} from "./node-ports";
import type {
  FlowEdge,
  FlowEdgeV2,
  FlowGraphV1,
  FlowGraphV2,
  FlowNode,
  SupportedFlowGraph,
} from "./types";

export class GraphVersionError extends Error {
  readonly edgeId: string;

  constructor(edgeId: string, message: string) {
    super(`Flow edge ${edgeId}: ${message}`);
    this.name = "GraphVersionError";
    this.edgeId = edgeId;
  }
}

interface LegacyFieldSnapshot {
  readonly present: boolean;
  readonly value: unknown;
}

interface LegacyNodeProvenance {
  readonly id: string;
  readonly original: Readonly<Record<string, unknown>>;
  readonly implementationVersion: LegacyFieldSnapshot;
  readonly meta: LegacyFieldSnapshot;
  readonly passthroughFields: readonly string[];
}

interface LegacyEdgeProvenance {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly original: Readonly<Record<string, unknown>>;
  readonly sourceHandle: LegacyFieldSnapshot;
  readonly targetHandle: LegacyFieldSnapshot;
  readonly adaptedSourceHandle: string;
  readonly adaptedTargetHandle: string;
  readonly condition: LegacyFieldSnapshot;
  readonly passthroughFields: readonly string[];
}

interface LegacyGraphProvenance {
  readonly original: FlowGraphV1;
  readonly originalBytes: string;
  readonly adaptedBytes: string;
  readonly passthroughFields: readonly string[];
  readonly nodes: readonly LegacyNodeProvenance[];
  readonly nodesById: ReadonlyMap<string, LegacyNodeProvenance>;
  readonly edges: readonly LegacyEdgeProvenance[];
  readonly edgesById: ReadonlyMap<string, LegacyEdgeProvenance>;
}

const legacyProvenance = new WeakMap<FlowGraphV2, LegacyGraphProvenance>();
const V1_GRAPH_FIELDS = new Set(["id", "name", "nodes", "edges", "meta"]);
const V1_NODE_FIELDS = new Set(["id", "type", "params", "position"]);
const V2_COMPATIBLE_NODE_FIELDS = new Set([...V1_NODE_FIELDS, "implementationVersion", "meta"]);
const V1_EDGE_FIELDS = new Set(["id", "source", "sourceHandle", "target", "targetHandle"]);
const V2_COMPATIBLE_EDGE_FIELDS = new Set([...V1_EDGE_FIELDS, "condition"]);

function fieldSnapshot(value: Readonly<Record<string, unknown>>, key: string): LegacyFieldSnapshot {
  return { present: Object.hasOwn(value, key), value: value[key] };
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function changedFromSnapshot(
  value: Readonly<Record<string, unknown>>,
  key: string,
  snapshot: LegacyFieldSnapshot,
): boolean {
  const present = Object.hasOwn(value, key);
  return present !== snapshot.present || (present && !sameValue(value[key], snapshot.value));
}

function endpointHandle(
  edge: FlowEdge,
  nodes: ReadonlyMap<string, FlowNode>,
  endpoint: "source" | "target",
): string {
  const existing = endpoint === "source" ? edge.sourceHandle : edge.targetHandle;
  if (existing !== undefined) return existing;

  const nodeId = endpoint === "source" ? edge.source : edge.target;
  const node = nodes.get(nodeId);
  if (node === undefined) {
    throw new GraphVersionError(edge.id, `${endpoint} node ${nodeId} does not exist`);
  }
  const definition = getNodeDefinition(node.type);
  const ports = endpoint === "source" ? definition.outputPorts : definition.inputPorts;
  if (ports.length !== 1) {
    throw new GraphVersionError(
      edge.id,
      `${endpoint} node ${nodeId} has ${ports.length} canonical ${endpoint === "source" ? "outputs" : "inputs"}; a named handle is required`,
    );
  }
  const port = ports[0];
  if (port === undefined) {
    throw new GraphVersionError(edge.id, `${endpoint} endpoint has no canonical port`);
  }
  return port.id;
}

export function adaptFlowGraphV1(graph: FlowGraphV1): FlowGraphV2 {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const adapted: Record<string, unknown> = { schemaVersion: 2 };
  for (const key of Object.keys(graph)) {
    if (!V1_GRAPH_FIELDS.has(key)) continue;
    if (key === "nodes") {
      adapted.nodes = graph.nodes.map((node) => {
        const value: Record<string, unknown> = {};
        for (const nodeKey of Object.keys(node)) {
          if (!V2_COMPATIBLE_NODE_FIELDS.has(nodeKey)) continue;
          value[nodeKey] = (node as unknown as Record<string, unknown>)[nodeKey];
        }
        value.bindings = {};
        return value;
      });
      continue;
    }
    if (key === "edges") {
      adapted.edges = graph.edges.map((edge) => {
        const value: Record<string, unknown> = {};
        for (const edgeKey of Object.keys(edge)) {
          if (!V2_COMPATIBLE_EDGE_FIELDS.has(edgeKey)) continue;
          value[edgeKey] = (edge as unknown as Record<string, unknown>)[edgeKey];
        }
        value.sourceHandle = endpointHandle(edge, nodesById, "source");
        value.targetHandle = endpointHandle(edge, nodesById, "target");
        return value;
      });
      continue;
    }
    adapted[key] = (graph as unknown as Record<string, unknown>)[key];
  }
  adapted.variables = [];
  adapted.groups = [];
  adapted.annotations = [];
  const result = adapted as unknown as FlowGraphV2;
  const nodeProvenance = graph.nodes.map((node) => {
    const original = node as unknown as Readonly<Record<string, unknown>>;
    return {
      id: node.id,
      original,
      implementationVersion: fieldSnapshot(original, "implementationVersion"),
      meta: fieldSnapshot(original, "meta"),
      passthroughFields: Object.keys(original).filter(
        (key) => !V2_COMPATIBLE_NODE_FIELDS.has(key),
      ),
    } satisfies LegacyNodeProvenance;
  });
  const edgeProvenance = graph.edges.map((edge, index) => {
    const original = edge as unknown as Readonly<Record<string, unknown>>;
    const adaptedEdge = result.edges[index];
    if (adaptedEdge === undefined) {
      throw new GraphVersionError(edge.id, "adapted edge provenance is missing");
    }
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      original,
      sourceHandle: fieldSnapshot(original, "sourceHandle"),
      targetHandle: fieldSnapshot(original, "targetHandle"),
      adaptedSourceHandle: adaptedEdge.sourceHandle,
      adaptedTargetHandle: adaptedEdge.targetHandle,
      condition: fieldSnapshot(original, "condition"),
      passthroughFields: Object.keys(original).filter(
        (key) => !V2_COMPATIBLE_EDGE_FIELDS.has(key),
      ),
    } satisfies LegacyEdgeProvenance;
  });
  legacyProvenance.set(result, {
    original: graph,
    originalBytes: JSON.stringify(graph),
    adaptedBytes: JSON.stringify(result),
    passthroughFields: Object.keys(graph).filter((key) => !V1_GRAPH_FIELDS.has(key)),
    nodes: nodeProvenance,
    nodesById: new Map(nodeProvenance.map((node) => [node.id, node])),
    edges: edgeProvenance,
    edgesById: new Map(edgeProvenance.map((edge) => [edge.id, edge])),
  });
  return result;
}

export function upgradeFlowGraph(graph: SupportedFlowGraph): FlowGraphV2 {
  return isFlowGraphV2(graph) ? graph : adaptFlowGraphV1(graph);
}

function edgePortFeature(
  graph: FlowGraphV2,
  edge: FlowEdgeV2,
  resolvePorts: ValidatedNodePortResolver,
): string | null {
  const source = graph.nodes.find((node) => node.id === edge.source);
  const target = graph.nodes.find((node) => node.id === edge.target);
  const sourcePorts = source === undefined ? [] : resolvePorts(source).outputPorts;
  const targetPorts = target === undefined ? [] : resolvePorts(target).inputPorts;
  const hasUniqueDefaults =
    sourcePorts.length === 1 &&
    targetPorts.length === 1 &&
    sourcePorts[0]?.id === edge.sourceHandle &&
    targetPorts[0]?.id === edge.targetHandle;
  return hasUniqueDefaults
    ? null
    : `edge-port:${edge.id}:${edge.sourceHandle}->${edge.targetHandle}`;
}

export function inspectV2OnlyFeatures(graph: FlowGraphV2): string[] {
  if (graphContainsApiOperation(graph)) return [API_OPERATION_V1_UNSUPPORTED];
  const provenance = legacyProvenance.get(graph);
  const resolvePorts = createValidatedNodePortResolver(graph);
  const features: string[] = [];
  if (graph.callableInterface !== undefined) features.push("callable-interface");
  for (const variable of graph.variables) features.push(`variable:${variable.id}`);
  graph.nodes.forEach((node, index) => {
    const legacy = provenance?.nodesById.get(node.id) ?? provenance?.nodes[index];
    const nodeValue = node as unknown as Readonly<Record<string, unknown>>;
    for (const key of Object.keys(node.bindings)) features.push(`binding:${node.id}:${key}`);
    if ((node.type === "subflow" || node.type === "loop") && Object.hasOwn(node.params, "reference")) {
      features.push(`typed-reference:${node.id}`);
    }
    if (
      legacy === undefined
        ? node.implementationVersion !== undefined
        : changedFromSnapshot(nodeValue, "implementationVersion", legacy.implementationVersion)
    ) {
      features.push(`meta:implementation-version:${node.id}`);
    }
    if (
      legacy === undefined
        ? node.meta !== undefined
        : changedFromSnapshot(nodeValue, "meta", legacy.meta)
    ) {
      features.push(`meta:node:${node.id}`);
    }
  });
  graph.edges.forEach((edge, index) => {
    const legacy = provenance?.edgesById.get(edge.id) ?? provenance?.edges[index];
    const handlesChanged =
      legacy !== undefined &&
      (edge.sourceHandle !== legacy.adaptedSourceHandle ||
        edge.targetHandle !== legacy.adaptedTargetHandle);
    const endpointsChanged =
      legacy !== undefined && (edge.source !== legacy.source || edge.target !== legacy.target);
    const portFeature =
      legacy !== undefined && !handlesChanged && !endpointsChanged
        ? null
        : edgePortFeature(graph, edge, resolvePorts);
    const changedPortFeature =
      handlesChanged && portFeature === null
        ? `edge-port:${edge.id}:${edge.sourceHandle}->${edge.targetHandle}`
        : portFeature;
    if (changedPortFeature !== null) features.push(changedPortFeature);
    const edgeValue = edge as unknown as Readonly<Record<string, unknown>>;
    if (
      legacy === undefined
        ? edge.condition !== undefined
        : changedFromSnapshot(edgeValue, "condition", legacy.condition)
    ) {
      features.push(`meta:edge-condition:${edge.id}`);
    }
  });
  for (const group of graph.groups) features.push(`group:${group.id}`);
  for (const annotation of graph.annotations) features.push(`annotation:${annotation.id}`);
  return features.sort();
}

function normalizedLegacyNode(node: FlowGraphV2["nodes"][number]): Record<string, unknown> {
  return { id: node.id, type: node.type, params: node.params, position: node.position };
}

function restoreLegacyNode(
  node: FlowGraphV2["nodes"][number],
  provenance: LegacyNodeProvenance | undefined,
): Record<string, unknown> {
  if (provenance === undefined) return normalizedLegacyNode(node);
  const value: Record<string, unknown> = {};
  for (const key of Object.keys(provenance.original)) {
    value[key] = V1_NODE_FIELDS.has(key)
      ? (node as unknown as Readonly<Record<string, unknown>>)[key]
      : provenance.original[key];
  }
  return value;
}

function normalizedLegacyEdge(edge: FlowEdgeV2): Record<string, unknown> {
  return { id: edge.id, source: edge.source, target: edge.target };
}

function restoreLegacyEdge(
  edge: FlowEdgeV2,
  provenance: LegacyEdgeProvenance | undefined,
): Record<string, unknown> {
  if (provenance === undefined) return normalizedLegacyEdge(edge);
  const value: Record<string, unknown> = {};
  for (const key of Object.keys(provenance.original)) {
    value[key] = ["id", "source", "target"].includes(key)
      ? (edge as unknown as Readonly<Record<string, unknown>>)[key]
      : provenance.original[key];
  }
  return value;
}

function restoreLegacyGraph(
  graph: FlowGraphV2,
  provenance: LegacyGraphProvenance,
): FlowGraphV1 {
  if (JSON.stringify(graph) === provenance.adaptedBytes) return provenance.original;

  const value: Record<string, unknown> = {};
  for (const key of Object.keys(provenance.original)) {
    if (key === "nodes") {
      value.nodes = graph.nodes.map((node, index) =>
        restoreLegacyNode(
          node,
          provenance.nodesById.get(node.id) ?? provenance.nodes[index],
        ),
      );
    } else if (key === "edges") {
      value.edges = graph.edges.map((edge, index) =>
        restoreLegacyEdge(
          edge,
          provenance.edgesById.get(edge.id) ?? provenance.edges[index],
        ),
      );
    } else if (["id", "name", "meta"].includes(key)) {
      const current = (graph as unknown as Readonly<Record<string, unknown>>)[key];
      if (current !== undefined) value[key] = current;
    } else {
      value[key] = (provenance.original as unknown as Readonly<Record<string, unknown>>)[key];
    }
  }
  if (!Object.hasOwn(provenance.original, "meta") && graph.meta !== undefined) {
    value.meta = graph.meta;
  }
  return value as unknown as FlowGraphV1;
}

export type DownconvertFlowGraphResult =
  | { readonly ok: true; readonly graph: FlowGraphV1 }
  | { readonly ok: false; readonly nonRoundTrippableFeatures: string[] };

export function downconvertFlowGraph(graph: FlowGraphV2): DownconvertFlowGraphResult {
  const features = inspectV2OnlyFeatures(graph);
  if (features.length > 0) return { ok: false, nonRoundTrippableFeatures: features };

  const provenance = legacyProvenance.get(graph);
  if (provenance !== undefined) {
    return { ok: true, graph: restoreLegacyGraph(graph, provenance) };
  }

  const legacy: Record<string, unknown> = {};
  for (const key of Object.keys(graph)) {
    if (["schemaVersion", "variables", "groups", "annotations"].includes(key)) continue;
    if (key === "nodes") {
      legacy.nodes = graph.nodes.map((node) => {
        const value: Record<string, unknown> = {};
        for (const nodeKey of Object.keys(node)) {
          if (["bindings", "implementationVersion", "meta"].includes(nodeKey)) continue;
          value[nodeKey] = (node as unknown as Record<string, unknown>)[nodeKey];
        }
        return value;
      });
      continue;
    }
    if (key === "edges") {
      legacy.edges = graph.edges.map((edge) => {
        const value: Record<string, unknown> = {};
        for (const edgeKey of Object.keys(edge)) {
          if (["sourceHandle", "targetHandle", "condition"].includes(edgeKey)) continue;
          value[edgeKey] = (edge as unknown as Record<string, unknown>)[edgeKey];
        }
        return value;
      });
      continue;
    }
    legacy[key] = (graph as unknown as Record<string, unknown>)[key];
  }
  return { ok: true, graph: legacy as unknown as FlowGraphV1 };
}
