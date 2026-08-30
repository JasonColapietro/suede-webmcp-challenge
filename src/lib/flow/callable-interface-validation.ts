import { FlowGraphV2Schema } from "./graph-schema";
import { createAuthoringNodePortResolver, type ValidatedNodePortResolver } from "./node-ports";
import { BoundedFlowCallableInterfaceSchema } from "./subflow-api";
import type { FlowCallableInterface, FlowGraphV2 } from "./types";

export function validateCallableInterfaceForGraph(
  graph: FlowGraphV2,
  value: unknown,
  resolveGraphPorts?: ValidatedNodePortResolver,
): FlowCallableInterface {
  const callable = BoundedFlowCallableInterfaceSchema.parse(value);
  const parsedGraph = FlowGraphV2Schema.parse({ ...graph, callableInterface: callable });
  const resolvePorts = resolveGraphPorts ?? createAuthoringNodePortResolver(parsedGraph);
  for (const output of callable.outputs) {
    const node = parsedGraph.nodes.find((candidate) => candidate.id === output.source.nodeId);
    if (!node) throw new Error(`Callable output source node "${output.source.nodeId}" is missing`);
    if (!resolvePorts(node).outputPorts.some((port) => port.id === output.source.portId)) {
      throw new Error(
        `Callable output source port "${output.source.nodeId}.${output.source.portId}" is missing`,
      );
    }
  }
  return callable;
}
