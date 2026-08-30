// SERVER-ONLY — imports @/lib/manifest which transitively pulls node:crypto.
// Never import this module from a client component.
import { getRepo, type FlowRepo } from "@/lib/db/repo";
import { flowToManifest, codegen } from "@/lib/manifest";
import { requireFlowGraphV1 } from "@/lib/flow/graph-schema";

export interface CodeViewData {
  source: string;
  name: string;
  flowId: string;
}

/**
 * Load a flow (owner-scoped), compile it to TypeScript SDK source.
 * Returns null if the flow doesn't exist or the ownerId doesn't match.
 *
 * Accepts an optional `repo` for testing (avoids the DB_DRIVER env dance).
 */
export async function getCodeViewData(
  flowId: string,
  ownerId: string,
  repo?: FlowRepo,
): Promise<CodeViewData | null> {
  const r = repo ?? (await getRepo());
  const flow = await r.getFlow(flowId);
  if (flow === null || flow.ownerId !== ownerId) return null;
  const manifest = flowToManifest(requireFlowGraphV1(flow.graph, "Code generation"));
  const source = codegen(manifest);
  return { source, name: flow.name, flowId: flow.id };
}
