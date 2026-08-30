import { describe, expect, it } from "vitest";
import { getRepo } from "@/lib/db/repo";
import { runToCompletion } from "@/lib/run-service";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type { FlowCallableInterface, FlowGraphV2, FlowNodeV2 } from "@/lib/flow/types";

const iface: FlowCallableInterface = { inputs: [], outputs: [] };

describe("persisted run root recursion identity", () => {
  it("seeds ancestry with the authoritative flow row ID, not graph.id", async () => {
    const repo = await getRepo();
    const ownerId = `owner-run-recursion-${Date.now()}`;
    const graph: FlowGraphV2 = {
      schemaVersion: 2, id: "not-the-row-id", name: "Self", variables: [], groups: [], annotations: [],
      callableInterface: iface,
      nodes: [{
        id: "self", type: "subflow", position: { x: 0, y: 0 }, bindings: {},
        params: { reference: { kind: "draft", flowId: "placeholder", interface: iface, interfaceHash: hashCallableInterface(iface) } } as unknown as FlowNodeV2["params"],
      }], edges: [],
    };
    const saved = await repo.saveFlow({ ownerId, name: "Self", graph });
    const patched: FlowGraphV2 = {
      ...graph,
      nodes: [{ ...graph.nodes[0]!, params: { reference: { kind: "draft", flowId: saved.id, interface: iface, interfaceHash: hashCallableInterface(iface) } } as unknown as FlowNodeV2["params"] }],
    };
    await repo.saveFlow({ id: saved.id, ownerId, name: "Self", graph: patched });
    const summary = await runToCompletion(patched, { flowId: saved.id, trigger: "test", dryRun: true });
    expect(summary.status).toBe("error");
    expect(summary.outputs).toEqual({});
    expect(summary.totalCostUsdc).toBe(0);
    const runs = await repo.listRuns(saved.id);
    const steps = await repo.listRunSteps(runs[0]!.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.nodeId).toBe("self");
    expect(steps[0]!.error).toMatch(new RegExp(`recursive subflow.*${saved.id}`, "i"));
    expect(steps[0]!.error).not.toContain(graph.id);
  });
});
