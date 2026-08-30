import type { ApiOperationBrowserClosureProjection } from "./operation-closure";
import type { OperationClosuresEnvelope } from "./api-contract";
import { parseApiOperationReference, type ApiOperationReference } from "../flow/api-operation-reference";
import { resolveApiOperationPorts } from "../flow/operation-port-resolver";
import {
  createValidatedNodePortResolver,
  type ResolvedNodePorts,
  type ValidatedNodePortResolver,
} from "../flow/node-ports";
import type { GraphCommand, Point } from "../flow/graph-command-types";
import type { FlowGraphV2, FlowNodeV2, SupportedFlowGraph } from "../flow/types";

const NO_PORTS: ResolvedNodePorts = Object.freeze({
  inputPorts: Object.freeze([]),
  outputPorts: Object.freeze([]),
});

export const API_OPERATION_REPAIR_MESSAGE =
  "API operation details are unavailable or changed. Repair this node before continuing." as const;

export function studioOperationClosureContextKey(input: Readonly<{
  graphToken: number | null;
  ownerScopeHash: string | null;
  persistedId: string | null;
}>): string {
  return JSON.stringify([input.graphToken, input.ownerScopeHash, input.persistedId]);
}

export function projectContextualStudioValue<Value>(
  currentContextKey: string,
  tagged: Readonly<{ contextKey: string; value: Value }>,
  fallback: Value,
): Value {
  return tagged.contextKey === currentContextKey ? tagged.value : fallback;
}

export function projectOwnerScopedStudioValue<Value>(
  currentOwnerScopeHash: string | null,
  tagged: Readonly<{ ownerScopeHash: string | null; value: Value }>,
  fallback: Value,
): Value {
  return currentOwnerScopeHash !== null && tagged.ownerScopeHash === currentOwnerScopeHash
    ? tagged.value
    : fallback;
}

export function isCurrentStudioContext(capturedContextKey: string, currentContextKey: string): boolean {
  return capturedContextKey === currentContextKey;
}

type StudioSimulationIdleState = Readonly<{
  contextKey: string;
  value: Readonly<{ status: "idle" }>;
}>;

type StudioPinState = Readonly<{
  contextKey: string;
  values: Readonly<Record<string, string>>;
}>;

/**
 * A boundary-input edit invalidates the complete simulation result, including a
 * request that is still in flight. Readiness is intentionally independent.
 */
export function invalidateStudioSimulationForPinChange(input: Readonly<{
  contextKey: string;
  key: string;
  value: string;
  generation: { current: number };
  controller: { current: AbortController | null };
  setSimulation: (next: StudioSimulationIdleState) => void;
  setPins: (update: (current: StudioPinState) => StudioPinState) => void;
}>): void {
  input.generation.current += 1;
  input.controller.current?.abort();
  input.controller.current = null;
  input.setSimulation({ contextKey: input.contextKey, value: { status: "idle" } });
  input.setPins((current) => ({
    contextKey: input.contextKey,
    values: {
      ...(current.contextKey === input.contextKey ? current.values : {}),
      [input.key]: input.value,
    },
  }));
}

function sixPins(reference: ApiOperationReference): readonly string[] {
  return [
    reference.connectorDefinitionVersionId,
    reference.operationVersionId,
    reference.operationId,
    reference.connectorProjectionHash,
    reference.operationProjectionHash,
    reference.schemaHash,
  ];
}

function sameSixPins(left: ApiOperationReference, right: ApiOperationReference): boolean {
  const a = sixPins(left);
  const b = sixPins(right);
  return a.every((value, index) => value === b[index]);
}

export function operationVersionIdsForGraph(graph: SupportedFlowGraph): readonly string[] {
  if (!("schemaVersion" in graph) || graph.schemaVersion !== 2) return Object.freeze([]);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const node of graph.nodes) {
    if (node.type !== "api.operation") continue;
    const id = parseApiOperationReference(node.params).operationVersionId;
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return Object.freeze(ids);
}

export type StudioOperationClosureResult =
  | Readonly<{
      status: "ready";
      byNodeId: ReadonlyMap<string, ApiOperationBrowserClosureProjection>;
    }>
  | Readonly<{ status: "repair"; reason: typeof API_OPERATION_REPAIR_MESSAGE }>;

function browserClosure(
  closure: OperationClosuresEnvelope["closures"][number],
  reference: ApiOperationReference,
): ApiOperationBrowserClosureProjection {
  return Object.freeze({
    ...closure,
    reference: Object.freeze({
      connectorDefinitionVersionId: reference.connectorDefinitionVersionId,
      operationVersionId: reference.operationVersionId,
      operationId: reference.operationId,
      connectorProjectionHash: reference.connectorProjectionHash,
      operationProjectionHash: reference.operationProjectionHash,
      schemaHash: reference.schemaHash,
      ...(reference.readinessBinding === undefined ? {} : { readinessBinding: reference.readinessBinding }),
    }),
  }) as ApiOperationBrowserClosureProjection;
}

export function bindStudioOperationClosures(
  graph: FlowGraphV2,
  requestedIds: readonly string[],
  envelope: OperationClosuresEnvelope,
): StudioOperationClosureResult {
  const expected = operationVersionIdsForGraph(graph);
  if (requestedIds.length !== expected.length || requestedIds.some((id, index) => id !== expected[index]) ||
      envelope.closures.length !== requestedIds.length || envelope.closures.some((closure, index) =>
        closure.reference.operationVersionId !== requestedIds[index] || closure.reference.readinessBinding !== undefined)) {
    return Object.freeze({ status: "repair", reason: API_OPERATION_REPAIR_MESSAGE });
  }
  const byOperationId = new Map(envelope.closures.map((closure) => [closure.reference.operationVersionId, closure]));
  const byNodeId = new Map<string, ApiOperationBrowserClosureProjection>();
  for (const node of graph.nodes) {
    if (node.type !== "api.operation") continue;
    let local: ApiOperationReference;
    try { local = parseApiOperationReference(node.params); } catch {
      return Object.freeze({ status: "repair", reason: API_OPERATION_REPAIR_MESSAGE });
    }
    const closure = byOperationId.get(local.operationVersionId);
    if (!closure || !sameSixPins(local, closure.reference) || closure.archivedAt !== null ||
        (closure.authentication.kind === "none" && local.readinessBinding !== undefined)) {
      return Object.freeze({ status: "repair", reason: API_OPERATION_REPAIR_MESSAGE });
    }
    byNodeId.set(node.id, browserClosure(closure, local));
  }
  return Object.freeze({ status: "ready", byNodeId });
}

/** One resolver identity for one exact graph object; missing API authority is always zero-port. */
export function createStudioOperationPortResolver(
  graph: SupportedFlowGraph,
  byNodeId: ReadonlyMap<string, ApiOperationBrowserClosureProjection> = new Map(),
): ValidatedNodePortResolver {
  return createValidatedNodePortResolver(graph, undefined, (node) => {
    if (node.type !== "api.operation") return undefined;
    const closure = byNodeId.get(node.id);
    if (!closure || closure.archivedAt !== null) return NO_PORTS;
    try {
      const local = parseApiOperationReference(node.params);
      if (!sameSixPins(local, closure.reference) ||
          (closure.authentication.kind === "none" && local.readinessBinding !== undefined)) return NO_PORTS;
      return resolveApiOperationPorts(closure);
    } catch {
      return NO_PORTS;
    }
  });
}

export function commandForApiOperationPick(input: Readonly<{
  closure: ApiOperationBrowserClosureProjection;
  position: Point;
  commandId: string;
  nodeId: string;
}>): Extract<GraphCommand, { kind: "node.add" }> {
  const reference = input.closure.reference;
  const node: FlowNodeV2 = {
    id: input.nodeId,
    type: "api.operation",
    params: {
      connectorDefinitionVersionId: reference.connectorDefinitionVersionId,
      operationVersionId: reference.operationVersionId,
      operationId: reference.operationId,
      connectorProjectionHash: reference.connectorProjectionHash,
      operationProjectionHash: reference.operationProjectionHash,
      schemaHash: reference.schemaHash,
    },
    bindings: {},
    position: { x: input.position.x, y: input.position.y },
  };
  return Object.freeze({ v: 1, id: input.commandId, kind: "node.add", node });
}
