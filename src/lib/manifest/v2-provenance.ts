import type { FlowGraphV2 } from "@/lib/flow/types";
import type { AgentManifestV2 } from "./schema";

const manifestByGraph = new WeakMap<FlowGraphV2, AgentManifestV2>();

export function attachManifestV2Provenance(
  graph: FlowGraphV2,
  manifest: AgentManifestV2,
): FlowGraphV2 {
  manifestByGraph.set(graph, manifest);
  return graph;
}

export function getManifestV2Provenance(graph: FlowGraphV2): AgentManifestV2 | undefined {
  return manifestByGraph.get(graph);
}
