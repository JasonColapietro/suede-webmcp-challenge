/**
 * Structural validation for a flow graph before it goes live. Catches a
 * disconnected or half-wired graph that would otherwise launch silently and
 * fail (or do nothing) the first time it runs. Pure data checks only — reads
 * the client-safe node-meta table, no engine/executor imports.
 */
import { getNodeMetaForGraph } from "./node-meta";
import { createAuthoringNodePortResolver, type ValidatedNodePortResolver } from "./node-ports";
import type { FlowNode, FlowNodeV2, SupportedFlowGraph } from "./types";
import {
  graphHasSafeHttpPublicationCredentials,
  HTTP_PUBLICATION_CREDENTIAL_ERROR,
} from "./http-publication-policy";
import { firstMissingRequiredConnection } from "./connection-requirements";

/** Trigger nodes are the ones with no declared inputs (Schedule, Input). */
function isTriggerNode(
  graph: SupportedFlowGraph,
  node: FlowNode | FlowNodeV2,
  resolvePorts: ValidatedNodePortResolver,
): boolean {
  const meta = getNodeMetaForGraph(graph, node, resolvePorts);
  return !meta || meta.inputs.length === 0;
}

function nodeLabel(
  graph: SupportedFlowGraph,
  node: FlowNode | FlowNodeV2,
  resolvePorts: ValidatedNodePortResolver,
): string {
  const meta = getNodeMetaForGraph(graph, node, resolvePorts);
  const name = meta ? meta.label : node.type;
  return `"${name}" (${node.id})`;
}

/**
 * Returns a human-readable error naming the offending node, or null if the
 * graph is structurally sound enough to launch.
 */
export function validateFlowGraph(
  graph: SupportedFlowGraph,
  resolveGraphPorts?: ValidatedNodePortResolver,
): string | null {
  const { nodes, edges } = graph;
  const resolvePorts = resolveGraphPorts ?? createAuthoringNodePortResolver(graph);

  if (nodes.length === 0) {
    return "This flow has no nodes yet. Add at least a trigger and one step before launching.";
  }
  if (!graphHasSafeHttpPublicationCredentials(graph)) return HTTP_PUBLICATION_CREDENTIAL_ERROR;
  const missingConnection = firstMissingRequiredConnection(graph);
  if (missingConnection) {
    return `"${missingConnection.nodeLabel}" (${missingConnection.node.id}) requires the ${missingConnection.connection.label} Connection before it can go live.`;
  }

  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  for (const node of nodes) {
    incomingCount.set(node.id, 0);
    outgoingCount.set(node.id, 0);
  }
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    if (incomingCount.has(edge.target)) {
      incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
    }
    if (outgoingCount.has(edge.source)) {
      outgoingCount.set(edge.source, (outgoingCount.get(edge.source) ?? 0) + 1);
      adjacency.get(edge.source)?.push(edge.target);
    }
  }

  // 1. Every non-trigger node needs at least one incoming edge.
  for (const node of nodes) {
    if (isTriggerNode(graph, node, resolvePorts)) continue;
    if ((incomingCount.get(node.id) ?? 0) === 0) {
      return `${nodeLabel(graph, node, resolvePorts)} is not connected to anything upstream. Wire an edge into it, or remove the node.`;
    }
  }

  // 2. There must be a trigger, and something reachable from it must
  //    actually finish the flow (a sink node downstream of the trigger).
  const triggers = nodes.filter((node) => isTriggerNode(graph, node, resolvePorts));
  if (triggers.length === 0) {
    return "This flow has no trigger (a Schedule or Input node) to start it.";
  }

  const reachable = new Set<string>();
  const queue: string[] = triggers.map((t) => t.id);
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    for (const next of adjacency.get(id) ?? []) queue.push(next);
  }

  const hasReachableTerminal = nodes.some(
    (n) =>
      reachable.has(n.id) &&
      !isTriggerNode(graph, n, resolvePorts) &&
      (outgoingCount.get(n.id) ?? 0) === 0,
  );
  if (!hasReachableTerminal) {
    return "No node reachable from the trigger actually ends the flow. Add an Output node (or another final step) downstream and connect it.";
  }

  // 3. LLM nodes need a non-empty prompt or they will fail (or bill) for nothing.
  for (const node of nodes) {
    if (node.type !== "llm") continue;
    const prompt = node.params.prompt;
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return `${nodeLabel(graph, node, resolvePorts)} has no prompt. Add one in the Inspector before launching.`;
    }
  }

  // 4. Transform nodes need a non-empty expression or they will fail at runtime.
  for (const node of nodes) {
    if (node.type !== "transform") continue;
    const expression = node.params.expression;
    if (typeof expression !== "string" || expression.trim() === "") {
      return `${nodeLabel(graph, node, resolvePorts)} has no expression. Add one in the Inspector before launching.`;
    }
  }

  return null;
}
