import { z } from "zod";
import { FlowCycleError, topoSort } from "./engine";
import { SupportedFlowGraphSchema } from "./graph-schema";
import type { FlowGraph, SupportedFlowGraph } from "./types";

export const FlowGraphSchema = SupportedFlowGraphSchema;

const FlowNameSchema = z.string().refine(
  (value) => value.length > 0 && value.trim() === value && new TextEncoder().encode(value).length <= 200,
  "Flow name must be 1..200 UTF-8 bytes without surrounding whitespace",
);

export const CreateFlowRequestSchema = z.object({
  name: FlowNameSchema,
  graph: FlowGraphSchema,
}).strict();

export const UpdateFlowRequestSchema = z.object({
  name: FlowNameSchema,
  graph: FlowGraphSchema,
  impactReceipt: z.string().min(32).max(256).optional(),
}).strict();

export function validateRunnableGraph(graph: SupportedFlowGraph): string | null {
  try {
    const runnableGraph: FlowGraph = {
      id: graph.id,
      name: graph.name,
      nodes: [...graph.nodes],
      edges: [...graph.edges],
      ...(graph.meta === undefined ? {} : { meta: graph.meta }),
    };
    topoSort(runnableGraph);
    return null;
  } catch (error) {
    if (error instanceof FlowCycleError) {
      const nodes =
        error.cycleNodeIds.length > 0
          ? ` (nodes: ${error.cycleNodeIds.join(", ")})`
          : "";
      return `This flow has a cycle and can't be saved${nodes}. Remove one connection that loops back to an earlier node.`;
    }
    throw error;
  }
}
