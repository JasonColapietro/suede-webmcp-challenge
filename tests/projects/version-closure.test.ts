import { describe, expect, it } from "vitest";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type { FlowCallableInterface, FlowGraphV2, SubflowReference } from "@/lib/flow/types";
import { hashFlowGraph } from "@/lib/projects/hash";
import { derivePinnedFlowDependencies } from "@/lib/projects/subflow-dependencies";
import type { FlowVersionRecord } from "@/lib/projects/types";
import {
  inspectVersionClosure,
  inspectVersionClosureSync,
} from "@/lib/projects/version-closure";

const OWNER = "owner-1";
const abi: FlowCallableInterface = { inputs: [], outputs: [] };

function reference(version: FlowVersionRecord): Extract<SubflowReference, { kind: "pinned" }> {
  return {
    kind: "pinned",
    flowId: version.flowId,
    versionId: version.id,
    interface: abi,
    interfaceHash: hashCallableInterface(abi),
    contentHash: version.semanticHash,
  };
}

function version(index: string, references: readonly SubflowReference[] = []): FlowVersionRecord {
  const graph: FlowGraphV2 = {
    schemaVersion: 2,
    id: `graph-${index}`,
    name: index,
    nodes: references.map((value, nodeIndex) => ({
      id: `child-${nodeIndex}`,
      type: "subflow",
      params: { reference: value } as never,
      bindings: {},
      position: { x: nodeIndex, y: 0 },
    })),
    edges: [], variables: [], groups: [], annotations: [], callableInterface: abi,
  };
  const id = `version-${index}`;
  const dependencies = derivePinnedFlowDependencies(graph).map((dependency, dependencyIndex) => ({
    id: `pin-${index}-${dependencyIndex}`,
    flowVersionId: id,
    ...dependency,
    createdAt: 1,
  }));
  const inputs = dependencies.map(({ kind, resourceId, version: pinVersion, contentHash }) => ({
    kind, resourceId, version: pinVersion, ...(contentHash === undefined ? {} : { contentHash }),
  }));
  return {
    id,
    flowId: `flow-${index}`,
    versionNumber: 1,
    schemaVersion: 1,
    graph,
    semanticHash: hashFlowGraph(graph, { semantic: true }, inputs),
    fullHash: hashFlowGraph(graph, { semantic: false }, inputs),
    createdBy: OWNER,
    createdAt: 1,
    dependencies,
  };
}

function inspectors(root: FlowVersionRecord, versions: readonly FlowVersionRecord[]) {
  const byKey = new Map(versions.map((item) => [`${item.flowId}\0${item.id}`, item]));
  const load = (flowId: string, versionId: string) => byKey.get(`${flowId}\0${versionId}`) ?? null;
  return {
    sync: inspectVersionClosureSync({ root, load }),
    async: inspectVersionClosure({
      root,
      ownerId: OWNER,
      repo: { getFlowVersion: async ({ flowId, versionId, ownerId }) =>
        ownerId === OWNER ? load(flowId, versionId) : null },
    }),
  };
}

describe("exact deployment version closure", () => {
  it("rejects a pinned callable-interface receipt mismatch in sync and async scans", async () => {
    const child = version("child");
    const forged = { ...reference(child), interfaceHash: "0".repeat(64) };
    const root = version("root", [forged]);
    const result = inspectors(root, [child]);
    expect(result.sync).toBe("invalid");
    await expect(result.async).resolves.toBe("invalid");
  });

  it("detects max-depth overflow on a shared DAG even when the tail was visited shallow first", async () => {
    const leaf = version("leaf");
    const shared = version("shared", [reference(leaf)]);
    const chain: FlowVersionRecord[] = [];
    let next = shared;
    for (let index = 62; index >= 0; index -= 1) {
      next = version(`deep-${index}`, [reference(next)]);
      chain.push(next);
    }
    // LIFO visits `shared` first through the direct edge, then reaches the
    // same tail at depth 64 through the long edge and must still expand it.
    const root = version("root", [reference(next), reference(shared)]);
    const result = inspectors(root, [leaf, shared, ...chain]);
    expect(result.sync).toBe("invalid");
    await expect(result.async).resolves.toBe("invalid");
  });
});
