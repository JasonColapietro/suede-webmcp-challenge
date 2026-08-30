import { describe, expect, it, vi } from "vitest";
import { getRepo } from "@/lib/db/repo";
import { NODE_META } from "@/lib/flow/node-meta";
import type { FlowGraph } from "@/lib/flow/types";

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (key: string) => (key === "x-owner-id" ? currentOwner : null),
  }),
  cookies: async () => ({ get: () => undefined }),
}));

let currentOwner = "owner-flow-validation-default";
let requestNumber = 0;
const testRunId = `${Date.now()}-${crypto.randomUUID()}`;

const { POST } = await import("@/app/api/flows/route");
const { PUT } = await import("@/app/api/flows/[id]/route");

const validGraph: FlowGraph = {
  id: "g-valid",
  name: "Valid graph",
  nodes: [
    { id: "input", type: "input", params: {}, position: { x: 0, y: 0 } },
    { id: "output", type: "output", params: {}, position: { x: 240, y: 0 } },
  ],
  edges: [{ id: "input-output", source: "input", target: "output" }],
};

const cyclicGraph: FlowGraph = {
  id: "g-cycle",
  name: "Cyclic graph",
  nodes: [
    { id: "a", type: "input", params: {}, position: { x: 0, y: 0 } },
    { id: "b", type: "transform", params: {}, position: { x: 160, y: 0 } },
  ],
  edges: [
    { id: "a-b", source: "a", target: "b" },
    { id: "b-a", source: "b", target: "a" },
  ],
};

type FlowMethod = "POST" | "PUT";

async function request(
  method: FlowMethod,
  body: unknown,
  seedLegacyTarget = false,
): Promise<{ response: Response; owner: string; rowId: string | null }> {
  requestNumber += 1;
  const requestId = `${testRunId}-${method.toLowerCase()}-${requestNumber}`;
  const owner = `owner-flow-validation-${requestId}`;
  currentOwner = owner;
  const repo = await getRepo();
  let effectiveBody = body;
  if (seedLegacyTarget) {
    const childId = `flow-validation-child-${requestId}`;
    await repo.saveFlow({
      id: childId,
      ownerId: owner,
      name: "Child",
      graph: { ...validGraph, id: `g-flow-validation-child-${requestId}` },
    });
    const record = body as { name: string; graph: FlowGraph };
    effectiveBody = {
      ...record,
      graph: {
        ...record.graph,
        nodes: record.graph.nodes.map((node) =>
          node.type === "subflow" || node.type === "loop"
            ? { ...node, params: { flowId: childId } }
            : node),
      },
    };
  }

  const init = {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(effectiveBody),
  };

  if (method === "POST") {
    return {
      response: await POST(new Request("https://agents.suedeai.ai/api/flows", init)),
      owner,
      rowId: null,
    };
  }

  const existing = await repo.saveFlow({
    ownerId: owner,
    name: "before",
    graph: validGraph,
  });
  return {
    response: await PUT(
      new Request(`https://agents.suedeai.ai/api/flows/${existing.id}`, init),
      { params: Promise.resolve({ id: existing.id }) },
    ),
    owner,
    rowId: existing.id,
  };
}

describe("flow request validation parity", () => {
  it.each(["POST", "PUT"] as const)(
    "%s rejects a malformed graph with 400 before saving",
    async (method) => {
      const { response, owner, rowId } = await request(method, {
        name: "bad",
        graph: { id: "g" },
      });

      expect(response.status).toBe(400);
      const repo = await getRepo();
      if (rowId === null) {
        expect(await repo.listFlows(owner)).toHaveLength(0);
      } else {
        expect((await repo.getFlow(rowId))?.name).toBe("before");
      }
    },
  );

  it.each(["POST", "PUT"] as const)(
    "%s rejects a cyclic graph before saving",
    async (method) => {
      const { response, owner, rowId } = await request(method, {
        name: "cycle",
        graph: cyclicGraph,
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("invalid flow graph");
      const repo = await getRepo();
      if (rowId === null) {
        expect(await repo.listFlows(owner)).toHaveLength(0);
      } else {
        expect((await repo.getFlow(rowId))?.name).toBe("before");
      }
    },
  );

  it.each(["POST", "PUT"] as const)(
    "%s rejects an unknown node type",
    async (method) => {
      const graph = {
        ...validGraph,
        nodes: [{ ...validGraph.nodes[0], type: "future.unknown" }],
        edges: [],
      };
      const { response } = await request(method, { name: "unknown", graph });

      expect(response.status).toBe(400);
    },
  );

  it.each(["POST", "PUT"] as const)(
    "%s accepts every current v1-compatible node type and preserves compatible extra fields",
    async (method) => {
      const repo = await getRepo();
      let legacyStaticChildId = `shared-child-${requestNumber + 1}`;
      while (await repo.getFlow(legacyStaticChildId)) {
        requestNumber += 1;
        legacyStaticChildId = `shared-child-${requestNumber + 1}`;
      }
      const foreignOwner = `owner-flow-validation-foreign-${testRunId}-${method.toLowerCase()}`;
      await repo.saveFlow({
        id: legacyStaticChildId,
        ownerId: foreignOwner,
        name: "Foreign child",
        graph: {
          ...validGraph,
          id: `g-flow-validation-foreign-${testRunId}-${method.toLowerCase()}`,
        },
      });
      const graph = {
        id: `g-current-types-${testRunId}-${method.toLowerCase()}`,
        name: "Current node types",
        nodes: NODE_META.filter(({ type }) =>
          type !== "api.operation" && type !== "resource.query"
        ).map((meta, index) => ({
          id: `node-${index}`,
          type: meta.type,
          params: meta.type === "subflow" || meta.type === "loop"
            ? { flowId: "shared-child" }
            : {},
          position: { x: index * 10, y: 0 },
          futureNodeField: `node-extra-${index}`,
        })),
        edges: [
          {
            id: "node-0-node-1",
            source: "node-0",
            target: "node-1",
            futureEdgeField: "edge-extra",
          },
        ],
        meta: { source: "compatibility-test" },
        futureGraphField: "graph-extra",
      };
      try {
        const { response } = await request(method, { name: graph.name, graph }, true);

        expect(response.status).toBe(200);
        const saved = (await response.json()) as {
          flow: { graph: Record<string, unknown> & { nodes: Array<Record<string, unknown>> } };
        };
        expect(saved.flow.graph.futureGraphField).toBe("graph-extra");
        expect(saved.flow.graph.nodes[0]?.futureNodeField).toBe("node-extra-0");
        expect(
          (saved.flow.graph as unknown as { edges: Array<Record<string, unknown>> }).edges[0]
            ?.futureEdgeField,
        ).toBe("edge-extra");
      } finally {
        await repo.deleteFlow(legacyStaticChildId, foreignOwner);
      }
    },
  );
});
