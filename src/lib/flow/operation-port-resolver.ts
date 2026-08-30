import type {
  ApiOperationBrowserClosureProjection,
} from "../connectors/operation-closure";
import {
  parseApiOperationReference,
  type ApiOperationReference,
} from "./api-operation-reference";
import {
  createValidatedNodePortResolver,
  type ResolvedNodePorts,
  type StaticNodeDefinitionResolver,
  type ValidatedNodePortResolver,
} from "./node-ports";
import type { FlowNode, FlowNodeV2, SupportedFlowGraph } from "./types";
import type { JsonSchema } from "./types";

export type DynamicNodePortResolver = (node: FlowNode | FlowNodeV2) => ResolvedNodePorts | undefined;

export type ApiOperationPortProjection = Pick<
  ApiOperationBrowserClosureProjection,
  "reference" | "requestSchema" | "resultSchema"
>;

function sameReference(left: ApiOperationReference, value: unknown): boolean {
  let right: ApiOperationReference;
  try { right = parseApiOperationReference(value); } catch { return false; }
  return right.connectorDefinitionVersionId === left.connectorDefinitionVersionId &&
    right.operationVersionId === left.operationVersionId &&
    right.operationId === left.operationId &&
    right.connectorProjectionHash === left.connectorProjectionHash &&
    right.operationProjectionHash === left.operationProjectionHash &&
    right.schemaHash === left.schemaHash;
}

export function resolveApiOperationPorts(snapshot: ApiOperationPortProjection): ResolvedNodePorts {
  return Object.freeze({
    inputPorts: Object.freeze([Object.freeze({
      id: "request",
      label: "Request",
      schema: snapshot.requestSchema as unknown as JsonSchema,
      required: true,
      cardinality: "one" as const,
    })]),
    outputPorts: Object.freeze([Object.freeze({
      id: "result",
      label: "Result",
      schema: snapshot.resultSchema as unknown as JsonSchema,
      required: true,
      cardinality: "one" as const,
    })]),
  });
}

export function createApiOperationPortResolver(
  snapshots: ReadonlyMap<string, ApiOperationPortProjection>,
): DynamicNodePortResolver {
  return (node) => {
    if (node.type !== "api.operation") return undefined;
    const snapshot = snapshots.get(node.id);
    if (!snapshot || !sameReference(snapshot.reference, node.params)) {
      throw new Error("API operation closure unavailable");
    }
    return resolveApiOperationPorts(snapshot);
  };
}

/** One graph snapshot + one owner-validated closure map, reusable by every authoring consumer. */
export function createValidatedApiOperationNodePortResolver(
  graph: SupportedFlowGraph,
  snapshots: ReadonlyMap<string, ApiOperationPortProjection>,
  resolveStatic?: StaticNodeDefinitionResolver,
): ValidatedNodePortResolver {
  return createValidatedNodePortResolver(
    graph,
    resolveStatic,
    createApiOperationPortResolver(snapshots),
  );
}
