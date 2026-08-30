/** Minimal dry-run context for the gateway's one-node execution contract. */
import { RunLogger } from "@/lib/log";
import type { NodeContext, NodeDef } from "@/lib/flow/executor";
import { getResourceRepository } from "@/lib/resources/provider";
import { createOwnerScopedResourcePackResolver } from "@/lib/projects/resource-dependencies";

function unavailable(label: string): never {
  throw new Error(`${label} is unavailable in a gateway dry run`);
}

export function buildGatewayRunContext(
  ownerId: string,
  runId: string,
  def: NodeDef,
): NodeContext {
  // Guarded gateway execution never selects a real paid/external executor.
  // Keep these capabilities inert so the cold path does not import provider,
  // wallet, or chain SDKs that no dry-run stub can use.
  const x402 = Object.freeze({
    dryRun: true,
    network: "base-mainnet" as const,
    walletAddress: null,
    call: async () => unavailable("x402 calls"),
  }) as unknown as NodeContext["x402"];
  const llm: NodeContext["llm"] = Object.freeze({
    generate: async () => unavailable("LLM calls"),
  });
  let resourceResolver: Promise<NodeContext["resolveResourcePack"]> | null = null;
  const resolveResourcePack: NodeContext["resolveResourcePack"] = async (reference) => {
    resourceResolver ??= getResourceRepository().then((repository) =>
      createOwnerScopedResourcePackResolver(ownerId, repository),
    );
    return (await resourceResolver)(reference);
  };
  return {
    runId,
    dryRun: true,
    ownerId,
    wallet: { address: null, network: "base-mainnet" },
    x402,
    llm,
    logger: new RunLogger(),
    loadSubflow: async () => unavailable("Subflow loading"),
    resolveSubflow: async () => unavailable("Subflow resolution"),
    resolveResourcePack,
    registry: Object.freeze({ [def.type]: def }),
    depth: 0,
    flowAncestry: Object.freeze([]),
    costCeiling: { limitUsdc: 0, spentUsdc: 0, reservedUsdc: 0 },
    runVariables: Object.freeze({}),
    resolveSecretReference: async () => unavailable("Secret resolution"),
  };
}
