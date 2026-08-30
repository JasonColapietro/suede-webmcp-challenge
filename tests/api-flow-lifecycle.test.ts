import { describe, expect, it, vi } from "vitest";
import { parsePersistedFlow } from "@/lib/flow/api-contract";
import { getProjectRepo } from "@/lib/projects/provider";
import type { FlowGraph, FlowGraphV2, SupportedFlowGraph } from "@/lib/flow/types";

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (key: string) => (key === "x-owner-id" ? currentOwner : null),
  }),
  cookies: async () => ({ get: () => undefined }),
}));

let currentOwner = "owner-flow-lifecycle-default";

const { POST: createFlowRoute } = await import("@/app/api/flows/route");
const { GET: getFlowRoute, PUT: putFlowRoute } = await import(
  "@/app/api/flows/[id]/route"
);
const { POST: runFlowRoute } = await import("@/app/api/flows/[id]/run/route");
const { POST: launchFlowRoute } = await import("@/app/api/flows/[id]/launch/route");

function validGraph(id: string): FlowGraph {
  return {
    id,
    name: "Lifecycle flow",
    nodes: [
      { id: "input", type: "input", params: {}, position: { x: 0, y: 0 } },
      { id: "output", type: "output", params: {}, position: { x: 240, y: 0 } },
    ],
    edges: [{ id: "input-output", source: "input", target: "output" }],
  };
}

async function createFlow(owner: string, graph: FlowGraph): Promise<Response> {
  currentOwner = owner;
  return createFlowRoute(
    new Request("https://agents.suedeai.ai/api/flows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: graph.name, graph }),
    }),
  );
}

async function createSupportedFlow(owner: string, graph: SupportedFlowGraph): Promise<Response> {
  currentOwner = owner;
  return createFlowRoute(new Request("https://agents.suedeai.ai/api/flows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: graph.name, graph }),
  }));
}

async function getFlow(owner: string, rowId: string): Promise<Response> {
  currentOwner = owner;
  return getFlowRoute(
    new Request(`https://agents.suedeai.ai/api/flows/${rowId}`),
    { params: Promise.resolve({ id: rowId }) },
  );
}

async function putFlow(owner: string, rowId: string, graph: SupportedFlowGraph): Promise<Response> {
  currentOwner = owner;
  return putFlowRoute(
    new Request(`https://agents.suedeai.ai/api/flows/${rowId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: graph.name, graph }),
    }),
    { params: Promise.resolve({ id: rowId }) },
  );
}

async function runFlow(
  owner: string,
  rowId: string,
  runVariables: Record<string, unknown> = {},
): Promise<Response> {
  currentOwner = owner;
  const response = await runFlowRoute(
    new Request(`https://agents.suedeai.ai/api/flows/${rowId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ triggerInput: {}, runVariables }),
    }),
    { params: Promise.resolve({ id: rowId }) },
  );
  const body = await response.text();
  return new Response(body, { status: response.status, headers: response.headers });
}

async function launchFlow(
  owner: string,
  rowId: string,
): Promise<{ agent: { flowId: string }; deployment: { id: string; versionId: string } }> {
  currentOwner = owner;
  const response = await launchFlowRoute(
    new Request(`https://agents.suedeai.ai/api/flows/${rowId}/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceUsdc: 0 }),
    }),
    { params: Promise.resolve({ id: rowId }) },
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    agent: { flowId: string };
    deployment: { id: string; versionId: string };
  }>;
}

describe("flow row identity lifecycle", () => {
  it("creates, reads, and updates v2 graphs without losing variables or bindings", async () => {
    const owner = `owner-flow-v2-${Date.now()}`;
    const graph: FlowGraphV2 = {
      schemaVersion: 2,
      id: "v2-graph",
      name: "V2 lifecycle",
      nodes: [
        { id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        {
          id: "output",
          type: "output",
          params: {},
          bindings: { value: { kind: "variable", variableId: "region" } },
          position: { x: 240, y: 0 },
        },
      ],
      edges: [{ id: "edge", source: "input", sourceHandle: "result", target: "output", targetHandle: "in" }],
      variables: [{ id: "region", name: "Region", scope: "run", schema: { type: "string" } }],
      groups: [],
      annotations: [],
    };
    const createdResponse = await createSupportedFlow(owner, graph);
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as { flow: { id: string; graph: SupportedFlowGraph } };
    expect(created.flow.graph).toEqual(graph);
    expect((await getFlow(owner, created.flow.id).then((response) => response.json()) as { flow: { graph: SupportedFlowGraph } }).flow.graph).toEqual(graph);

    const updated = { ...graph, name: "V2 saved", variables: [...graph.variables, { id: "tier", name: "Tier", scope: "workflow" as const, schema: {} }] };
    currentOwner = owner;
    const response = await putFlowRoute(new Request(`https://agents.suedeai.ai/api/flows/${created.flow.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: updated.name, graph: updated }),
    }), { params: Promise.resolve({ id: created.flow.id }) });
    expect(response.status).toBe(200);
    expect((await response.json() as { flow: { graph: SupportedFlowGraph } }).flow.graph).toEqual(updated);
    const runResponse = await runFlow(owner, created.flow.id, { region: "us-east" });
    expect(runResponse.status).toBe(200);
    const events = (await runResponse.text())
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)) as { kind: string; status?: string });
    expect(events.some((event) => event.kind === "node:error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "run:done", status: "done" });
  });

  it("create -> open -> save -> run -> launch keeps the row id authoritative", async () => {
    const owner = `owner-flow-lifecycle-${Date.now()}`;
    const graphId = "graph-not-the-row-id";
    const createResponse = await createFlow(owner, validGraph(graphId));
    const created = (await createResponse.json()) as {
      flow: { id: string; graph: FlowGraph };
    };
    expect(created.flow.id).not.toBe(graphId);

    const openResponse = await getFlow(owner, created.flow.id);
    const opened = parsePersistedFlow(await openResponse.json());
    expect(opened).toEqual({ rowId: created.flow.id, graph: created.flow.graph });

    expect(
      (await putFlow(owner, opened!.rowId, { ...opened!.graph, name: "saved" })).status,
    ).toBe(200);
    expect((await runFlow(owner, opened!.rowId)).status).toBe(200);
    const launched = await launchFlow(owner, opened!.rowId);
    expect(launched.agent.flowId).toBe(created.flow.id);

    // Deliberate contract extension (deploy-on-launch, 2026-08-09): launching
    // now also promotes the flow to an active Live deployment so the agent's
    // paid call resolves instead of 503ing "published run unavailable". The
    // row-id lifecycle above is unchanged; this pins the new guarantee.
    const projectRepo = await getProjectRepo();
    const liveDeployment = await projectRepo.getActiveDeployment({
      flowId: created.flow.id,
      environmentKind: "live",
      ownerId: owner,
    });
    expect(liveDeployment).toMatchObject({ status: "live" });
    expect(launched.deployment.id).toBe(liveDeployment?.id);

    expect((await getFlow(owner, graphId)).status).toBe(404);
  });
});
