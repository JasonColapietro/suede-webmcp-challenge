/**
 * Client-safe compatibility metadata for the canvas and its consumers.
 *
 * The canonical descriptors in node-definitions.ts own all authored node
 * metadata. Keep this module projection-only so the legacy surface cannot
 * drift from that catalog or pull server executors into client bundles.
 */
import type { NodeField, NodeGroup } from "./node-definition-types";
import {
  NODE_DEFINITION_BY_TYPE,
  NODE_DEFINITIONS,
  isNodeDefinitionAvailable,
  NODE_GROUP_ORDER as CATALOG_NODE_GROUP_ORDER,
  NODE_TYPE_SET as CATALOG_NODE_TYPE_SET,
  type NodeAvailabilityMode,
  type NodeAvailabilityProjection,
} from "./node-definitions";
import type { NodeType } from "./types";
import type { FlowNode, FlowNodeV2, SupportedFlowGraph } from "./types";
import { resolveNodePorts, type ValidatedNodePortResolver } from "./node-ports";

export type {
  NodeField,
  NodeFieldKind as FieldKind,
  NodeGroup,
} from "./node-definition-types";
export const NODE_GROUP_ORDER = CATALOG_NODE_GROUP_ORDER;
export const NODE_TYPE_SET: ReadonlySet<string> = CATALOG_NODE_TYPE_SET;

export interface NodeMeta {
  type: NodeType;
  label: string;
  group: NodeGroup;
  priceUsdc?: number;
  inputs: string[];
  outputs: string[];
  fields: NodeField[];
  prototype?: { enabled: boolean; badge: "Prototype: simulation only" };
}

export const NODE_META: NodeMeta[] = NODE_DEFINITIONS.map((definition) => ({
  type: definition.type,
  label: definition.label,
  group: definition.category,
  ...(definition.cost.kind === "estimated"
    ? { priceUsdc: definition.cost.amount }
    : {}),
  inputs: definition.inputPorts.map((port) => port.id),
  outputs: definition.outputPorts.map((port) => port.id),
  fields: [...definition.ui.fields],
  ...(definition.prototype ? { prototype: { ...definition.prototype } } : {}),
}));

const NODE_META_BY_TYPE = new Map<NodeType, NodeMeta>(
  NODE_META.map((metadata) => [metadata.type, metadata]),
);

export function getNodeMeta(type: NodeType): NodeMeta | undefined {
  return NODE_META_BY_TYPE.get(type);
}

export function projectAvailableNodeMeta(
  projection: NodeAvailabilityProjection,
  mode: NodeAvailabilityMode,
): readonly NodeMeta[] {
  return Object.freeze(NODE_META.filter((metadata) =>
    isNodeDefinitionAvailable(NODE_DEFINITION_BY_TYPE[metadata.type], projection, mode)));
}

/** Graph-aware projection. NODE_META remains the immutable catalog view. */
export function getNodeMetaForGraph(
  graph: SupportedFlowGraph,
  node: FlowNode | FlowNodeV2,
  resolvePorts?: ValidatedNodePortResolver,
): NodeMeta | undefined {
  const metadata = getNodeMeta(node.type);
  if (!metadata) return undefined;
  const ports = resolvePorts ? resolvePorts(node) : resolveNodePorts(graph, node);
  return {
    ...metadata,
    inputs: ports.inputPorts.map((port) => port.id),
    outputs: ports.outputPorts.map((port) => port.id),
  };
}
