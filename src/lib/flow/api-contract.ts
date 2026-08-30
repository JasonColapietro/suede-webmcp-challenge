import { isFlowGraphV1, parseSupportedFlowGraph } from "./graph-schema";
import type { FlowGraph, SupportedFlowGraph } from "./types";

export interface PersistedFlowPayload {
  rowId: string;
  graph: SupportedFlowGraph;
}

export function isFlowGraph(value: unknown): value is FlowGraph {
  return isFlowGraphV1(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parsePersistedFlow(payload: unknown): PersistedFlowPayload | null {
  const root = asRecord(payload);
  const flow = asRecord(root?.flow);
  if (typeof flow?.id !== "string" || flow.id.length === 0) return null;
  const graph = parseSupportedGraphOrNull(flow.graph);
  return graph === null ? null : { rowId: flow.id, graph };
}

export function parseCreatedFlowId(payload: unknown): string | null {
  return parsePersistedFlow(payload)?.rowId ?? null;
}

export function parseTemplateGraph(payload: unknown): FlowGraph | null {
  const root = asRecord(payload);
  const template = asRecord(root?.template);
  return parseGraphV1OrNull(template?.graph);
}

function parseGraphV1OrNull(value: unknown): FlowGraph | null {
  try {
    const graph = parseSupportedFlowGraph(value);
    return isFlowGraphV1(graph) ? graph : null;
  } catch {
    return null;
  }
}

function parseSupportedGraphOrNull(value: unknown): SupportedFlowGraph | null {
  try {
    return parseSupportedFlowGraph(value);
  } catch {
    return null;
  }
}
