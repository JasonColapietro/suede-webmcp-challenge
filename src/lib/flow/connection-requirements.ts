import { isFlowGraphV2 } from "./graph-schema";
import { getNodeDefinition, nodeAllowsSecretBinding } from "./node-definitions";
import type { NodeConnectionSpec } from "./node-definition-types";
import type { FlowNode, FlowNodeV2, SupportedFlowGraph } from "./types";

export const REQUIRED_CONNECTION_ERROR =
  "Every required action connection must be bound before publication.";
export const REQUIRED_CONNECTION_CODE = "REQUIRED_CONNECTION_MISSING";

export class RequiredConnectionError extends Error {
  readonly code = REQUIRED_CONNECTION_CODE;

  constructor() {
    super(REQUIRED_CONNECTION_ERROR);
    this.name = "RequiredConnectionError";
  }
}

export interface MissingNodeConnection {
  readonly node: FlowNode | FlowNodeV2;
  readonly nodeLabel: string;
  readonly connection: NodeConnectionSpec;
}

export function firstMissingRequiredConnection(
  graph: SupportedFlowGraph,
): MissingNodeConnection | null {
  const v2 = isFlowGraphV2(graph);
  for (const node of graph.nodes) {
    const definition = getNodeDefinition(node.type);
    for (const connection of definition.connections ?? []) {
      if (!connection.required) continue;
      if (!v2) return { node, nodeLabel: definition.label, connection };
      const binding = (node as FlowNodeV2).bindings[connection.key];
      if (binding?.kind !== "secret" ||
          !nodeAllowsSecretBinding(node.type, connection.key, binding.field)) {
        return { node, nodeLabel: definition.label, connection };
      }
    }
  }
  return null;
}

export function graphHasRequiredConnectionBindings(graph: SupportedFlowGraph): boolean {
  return firstMissingRequiredConnection(graph) === null;
}

export function assertGraphHasRequiredConnectionBindings(graph: SupportedFlowGraph): void {
  if (!graphHasRequiredConnectionBindings(graph)) throw new RequiredConnectionError();
}
