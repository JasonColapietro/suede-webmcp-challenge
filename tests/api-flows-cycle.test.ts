/**
 * Regression: PUT /api/flows/[id] saved a cyclic graph fine and only failed
 * later, at run time, with an opaque topoSort error. Fix: validate
 * acyclicity with the engine's topoSort/FlowCycleError before saving and
 * return 400 with a message naming the cycle's nodes.
 *
 * Follows tests/guided/api.test.ts's convention of mocking next/headers and
 * importing the route handler directly, since flows/[id]/route.ts pulls no
 * server-only deps vitest can't resolve.
 */
import { describe, it, expect, vi } from "vitest";
import { getRepo } from "@/lib/db/repo";
import type { FlowGraph } from "@/lib/flow/types";

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k === "x-owner-id" ? currentOwner : null),
  }),
  cookies: async () => ({ get: () => undefined }),
}));

let currentOwner = "owner-flows-cycle-default";

const { PUT } = await import("@/app/api/flows/[id]/route");

async function putFlow(
  id: string,
  owner: string,
  body: { name: string; graph: unknown },
): Promise<Response> {
  currentOwner = owner;
  return PUT(
    new Request(`https://agents.suedeai.ai/api/flows/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

const acyclicGraph: FlowGraph = {
  id: "g-acyclic",
  name: "ok",
  nodes: [
    { id: "a", type: "input", params: {}, position: { x: 0, y: 0 } },
    { id: "b", type: "output", params: {}, position: { x: 1, y: 0 } },
  ],
  edges: [{ id: "a->b", source: "a", target: "b" }],
};

const cyclicGraph: FlowGraph = {
  id: "g-cyclic",
  name: "cyclic",
  nodes: [
    { id: "a", type: "input", params: {}, position: { x: 0, y: 0 } },
    { id: "b", type: "llm", params: {}, position: { x: 1, y: 0 } },
    { id: "c", type: "output", params: {}, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: "a->b", source: "a", target: "b" },
    { id: "b->c", source: "b", target: "c" },
    { id: "c->b", source: "c", target: "b" }, // closes a loop b -> c -> b
  ],
};

describe("PUT /api/flows/[id] — cycle validation", () => {
  it("saves an acyclic graph", async () => {
    const owner = `owner-flows-cycle-${Date.now()}-ok`;
    const repo = await getRepo();
    const flow = await repo.saveFlow({ ownerId: owner, name: "before", graph: acyclicGraph });

    const res = await putFlow(flow.id, owner, { name: "after", graph: acyclicGraph });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { flow: { name: string } };
    expect(json.flow.name).toBe("after");
  });

  it("rejects a cyclic graph with 400 and names the looping nodes, without saving it", async () => {
    const owner = `owner-flows-cycle-${Date.now()}-bad`;
    const repo = await getRepo();
    const flow = await repo.saveFlow({ ownerId: owner, name: "before", graph: acyclicGraph });

    const res = await putFlow(flow.id, owner, { name: "after", graph: cyclicGraph });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid flow graph");

    // The bad graph must not have been persisted over the good one.
    const stored = await repo.getFlow(flow.id);
    expect(stored?.name).toBe("before");
  });

  it("still 404s for a flow owned by someone else, before the cycle check even runs", async () => {
    const owner = `owner-flows-cycle-${Date.now()}-owner`;
    const stranger = `owner-flows-cycle-${Date.now()}-stranger`;
    const repo = await getRepo();
    const flow = await repo.saveFlow({ ownerId: owner, name: "mine", graph: acyclicGraph });

    const res = await putFlow(flow.id, stranger, { name: "hijacked", graph: cyclicGraph });
    expect(res.status).toBe(404);
  });
});
