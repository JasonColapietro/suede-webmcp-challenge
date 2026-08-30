/**
 * POST /api/flows/[id]/launch — webhook secret provisioning.
 *
 * Follows tests/api-flows-cycle.test.ts's convention of mocking next/headers
 * and importing the route handler directly, since launch/route.ts pulls no
 * server-only deps vitest can't resolve.
 */
import { describe, it, expect, vi } from "vitest";
import { getRepo } from "@/lib/db/repo";
import type { FlowGraph } from "@/lib/flow/types";
import { API_OPERATION_LIVE_UNAVAILABLE } from "@/lib/connectors/operation-closure";

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k === "x-owner-id" ? currentOwner : null),
  }),
  cookies: async () => ({ get: () => undefined }),
}));

let currentOwner = "owner-launch-webhook-default";

const { POST } = await import("@/app/api/flows/[id]/launch/route");

async function launch(id: string, owner: string): Promise<Response> {
  currentOwner = owner;
  return POST(
    new Request(`https://agents.suedeai.ai/api/flows/${id}/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ id }) },
  );
}

const webhookGraph: FlowGraph = {
  id: "g-webhook-launch",
  name: "webhook flow",
  nodes: [
    { id: "w", type: "webhook", params: {}, position: { x: 0, y: 0 } },
    { id: "o", type: "output", params: {}, position: { x: 1, y: 0 } },
  ],
  edges: [{ id: "w->o", source: "w", target: "o" }],
};

const scheduleGraph: FlowGraph = {
  id: "g-schedule-launch",
  name: "schedule flow",
  nodes: [
    { id: "s", type: "schedule", params: { cron: "0 9 * * *" }, position: { x: 0, y: 0 } },
    { id: "o", type: "output", params: {}, position: { x: 1, y: 0 } },
  ],
  edges: [{ id: "s->o", source: "s", target: "o" }],
};

const credentialHttpGraph: FlowGraph = {
  id: "g-http-credential-launch",
  name: "credential HTTP flow",
  nodes: [
    { id: "i", type: "input", params: {}, position: { x: 0, y: 0 } },
    {
      id: "h", type: "http",
      params: {
        method: "GET", url: "https://example.com",
        headers: { Accept: "application/json", Authorization: "Bearer launch-route-canary" },
      },
      position: { x: 1, y: 0 },
    },
    { id: "o", type: "output", params: {}, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: "i->h", source: "i", target: "h" },
    { id: "h->o", source: "h", target: "o" },
  ],
};

describe("POST /api/flows/[id]/launch — webhook secret", () => {
  it("refuses legacy publication with static HTTP credentials before agent writes", async () => {
    const owner = `owner-launch-http-credential-${Date.now()}`;
    const repo = await getRepo();
    const flow = await repo.saveFlow({
      ownerId: owner,
      name: "credential HTTP agent",
      graph: credentialHttpGraph,
    });

    const response = await launch(flow.id, owner);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "HTTP credentials must use an opaque Connection binding before publication.",
    });
    expect(await repo.getAgentByFlowId(flow.id)).toBeNull();
  });

  it("refuses a forged legacy api.operation graph before agent or schedule writes", async () => {
    const owner = `owner-launch-api-operation-${Date.now()}`;
    const repo = await getRepo();
    const forged = {
      schemaVersion: 2,
      id: "legacy-api-operation",
      name: "forged legacy API operation",
      nodes: [{ id: "api", type: "api.operation", params: {
        connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000601",
        operationVersionId: "00000000-0000-4000-8000-000000000602",
        operationId: "createThing",
        connectorProjectionHash: "1".repeat(64),
        operationProjectionHash: "2".repeat(64),
        schemaHash: "3".repeat(64),
      }, bindings: {}, position: { x: 0, y: 0 } }],
      edges: [], variables: [], groups: [], annotations: [],
    } as unknown as FlowGraph;
    const flow = await repo.saveFlow({ ownerId: owner, name: "forged", graph: forged });
    const response = await launch(flow.id, owner);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: API_OPERATION_LIVE_UNAVAILABLE });
    expect(await repo.getAgentByFlowId(flow.id)).toBeNull();
  });
  it("generates and returns a webhook secret exactly once on first launch", async () => {
    const owner = `owner-launch-webhook-${Date.now()}-a`;
    const repo = await getRepo();
    const flow = await repo.saveFlow({ ownerId: owner, name: "webhook agent", graph: webhookGraph });

    const res = await launch(flow.id, owner);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      webhook: { url: string; secret?: string } | null;
      urls: Record<string, string>;
      endpoints: string[];
    };
    expect(json.webhook).not.toBeNull();
    expect(json.webhook?.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(json.webhook?.url).toBe(`/api/agents/${(await repo.getAgentByFlowId(flow.id))!.id}/webhook`);
    expect(json.urls.webhook).toBe(json.webhook?.url);
    expect(json.endpoints).toContain(json.webhook?.url);
  });

  it("does not re-generate or re-show the secret on a second launch", async () => {
    const owner = `owner-launch-webhook-${Date.now()}-b`;
    const repo = await getRepo();
    const flow = await repo.saveFlow({ ownerId: owner, name: "webhook agent 2", graph: webhookGraph });

    const first = await launch(flow.id, owner);
    const firstJson = (await first.json()) as { webhook: { secret?: string } | null };
    const firstSecret = firstJson.webhook?.secret;
    expect(firstSecret).toBeTruthy();

    const second = await launch(flow.id, owner);
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { webhook: { secret?: string } | null };
    expect(secondJson.webhook?.secret).toBeUndefined();

    // The stored hash must be unchanged — relaunching must not rotate a
    // secret an owner may have already configured into a third-party sender.
    const agent = await repo.getAgentByFlowId(flow.id);
    const endpoint = await repo.getWebhookEndpoint(agent!.id);
    expect(endpoint?.secretHash).toBe(firstSecret);
  });

  it("omits webhook from the response entirely for a flow with no webhook node", async () => {
    const owner = `owner-launch-webhook-${Date.now()}-c`;
    const repo = await getRepo();
    const flow = await repo.saveFlow({ ownerId: owner, name: "schedule agent", graph: scheduleGraph });

    const res = await launch(flow.id, owner);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { webhook: unknown; urls: Record<string, string> };
    expect(json.webhook).toBeNull();
    expect(json.urls.webhook).toBeUndefined();
  });
});
