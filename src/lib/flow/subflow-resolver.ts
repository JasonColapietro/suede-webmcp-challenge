import type { FlowRepo } from "@/lib/db/repo";
import type { FlowVersionRepo } from "@/lib/projects/repo";
import { hashFlowGraph } from "@/lib/projects/hash";
import { isFlowGraphV2, parseSupportedFlowGraph } from "./graph-schema";
import {
  assertSubflowReferenceReceipt,
  hashCallableInterface,
} from "./subflow-reference";
import type {
  FlowCallableInterface,
  SubflowReference,
  SupportedFlowGraph,
} from "./types";

export interface ResolvedSubflow {
  readonly graph: SupportedFlowGraph;
  readonly flowId: string;
  readonly versionId?: string;
  readonly semanticHash: string;
  readonly callableInterface: FlowCallableInterface;
}

export type SubflowResolver = (
  reference: SubflowReference,
  signal?: AbortSignal,
) => Promise<ResolvedSubflow>;

export function createSubflowResolver(input: {
  readonly ownerId: string | null;
  readonly flowRepo: Pick<FlowRepo, "getOwnedFlow">;
  readonly versionRepo: Pick<FlowVersionRepo, "getFlowVersion">;
}): SubflowResolver {
  return async (reference, signal) => {
    signal?.throwIfAborted();
    const notFound = (): never => {
      throw new Error(`Subflow ${reference.flowId} not found`);
    };
    if (!input.ownerId) return notFound();

    let graph: SupportedFlowGraph;
    let semanticHash: string;
    let versionId: string | undefined;
    if (reference.kind === "pinned") {
      const version = await input.versionRepo.getFlowVersion({
        flowId: reference.flowId,
        versionId: reference.versionId,
        ownerId: input.ownerId,
      });
      if (!version) return notFound();
      graph = parseSupportedFlowGraph(version.graph);
      semanticHash = version.semanticHash;
      versionId = version.id;
    } else {
      const flow = await input.flowRepo.getOwnedFlow(reference.flowId, input.ownerId);
      if (!flow) return notFound();
      graph = flow.graph;
      semanticHash = hashFlowGraph(graph, { semantic: true });
    }

    signal?.throwIfAborted();
    if (!isFlowGraphV2(graph) || !graph.callableInterface) {
      throw new Error(`Subflow ${reference.flowId} has no callable interface`);
    }
    const interfaceHash = hashCallableInterface(graph.callableInterface);
    assertSubflowReferenceReceipt(reference, {
      interfaceHash,
      ...(versionId ? { contentHash: semanticHash } : {}),
    });
    return {
      graph,
      flowId: reference.flowId,
      ...(versionId ? { versionId } : {}),
      semanticHash,
      callableInterface: graph.callableInterface,
    };
  };
}
