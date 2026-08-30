import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getCodeViewData } from "@/lib/code-view";
import { handleCliAgentPull } from "@/lib/cli/agent-slug-handler";
import { handleCliAgentsList } from "@/lib/cli/agents-handler";
import { handleCliAgentsPush } from "@/lib/cli/agents-handler";
import { API_OPERATION_V1_UNSUPPORTED } from "@/lib/flow/api-operation-contract";
import { requireFlowGraphV1 } from "@/lib/flow/graph-schema";
import type { FlowRepo } from "@/lib/db/repo";
import type { FlowGraphV2 } from "@/lib/flow/types";

const graph: FlowGraphV2 = {
  schemaVersion: 2,
  id: "api",
  name: "API",
  nodes: [{
    id: "api", type: "api.operation",
    params: {
      connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000601",
      operationVersionId: "00000000-0000-4000-8000-000000000602",
      operationId: "createThing",
      connectorProjectionHash: "1".repeat(64),
      operationProjectionHash: "2".repeat(64),
      schemaHash: "3".repeat(64),
    },
    bindings: {}, position: { x: 0, y: 0 },
  }],
  edges: [], variables: [], groups: [], annotations: [],
};

const flow = { id: "flow-1", ownerId: "owner-1", name: "API", graph, updatedAt: 1 };
const agent = {
  id: "agent-1", flowId: flow.id, slug: "api-agent", status: "live" as const,
  priceUsdc: 0, createdAt: 1, settlementLive: false,
};

function repo(): FlowRepo {
  return {
    getFlow: async () => flow,
    getAgentBySlug: async () => agent,
    listAgentsByOwner: async () => [agent],
    listFlows: async () => [flow],
  } as unknown as FlowRepo;
}

async function expectFixed(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code: API_OPERATION_V1_UNSUPPORTED,
    message: API_OPERATION_V1_UNSUPPORTED,
  });
}

describe("api.operation legacy export boundaries", () => {
  it("uses the fixed compatibility error at the shared conversion boundary", () => {
    expect(() => requireFlowGraphV1(graph, "legacy export")).toThrow(API_OPERATION_V1_UNSUPPORTED);
  });

  it("refuses code view and CLI pull/list without generic conversion loss", async () => {
    await expectFixed(getCodeViewData(flow.id, flow.ownerId, repo()));
    await expectFixed(handleCliAgentPull(agent.slug, flow.ownerId, repo()));
    await expectFixed(handleCliAgentsList(flow.ownerId, repo()));
  });

  it("refuses CLI v1 manifest import before repository access", async () => {
    const inaccessible = new Proxy({}, {
      get: () => { throw new Error("repository must remain untouched"); },
    }) as FlowRepo;
    await expectFixed(handleCliAgentsPush({
      manifestVersion: 1,
      name: "Legacy API",
      description: "",
      triggers: [{ kind: "manual" }],
      steps: [{ id: "api", type: "api.operation", config: graph.nodes[0]!.params, after: [] }],
      meta: {},
    }, "v1-import-owner", inaccessible));
  });

  it("maps the fixed error in HTTP download and CLI envelopes", () => {
    for (const path of [
      "src/app/code/[flowId]/agent.ts/route.ts",
      "src/app/api/cli/agents/[slug]/route.ts",
      "src/app/api/cli/agents/route.ts",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("API_OPERATION_V1_UNSUPPORTED");
      expect(source).toContain("409");
    }
  });
});
