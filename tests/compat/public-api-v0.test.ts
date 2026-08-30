import { describe, expect, it, vi } from "vitest";
import type { FlowGraph, RunEvent } from "@/lib/flow/types";

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (key: string) => (key === "x-owner-id" ? currentOwner : null),
  }),
  cookies: async () => ({ get: () => undefined }),
}));

let currentOwner = "compat-public-api-default";

const { GET: listFlows, POST: createFlow } = await import("@/app/api/flows/route");
const {
  GET: getFlow,
  PUT: updateFlow,
  DELETE: deleteFlow,
} = await import("@/app/api/flows/[id]/route");
const { POST: runFlow } = await import("@/app/api/flows/[id]/run/route");
const { POST: launchFlow } = await import("@/app/api/flows/[id]/launch/route");

function graph(id: string, name = "Public API compatibility"): FlowGraph {
  return {
    id,
    name,
    nodes: [
      { id: "input", type: "input", params: {}, position: { x: 0, y: 0 } },
      { id: "output", type: "output", params: {}, position: { x: 240, y: 0 } },
    ],
    edges: [{ id: "input-output", source: "input", target: "output" }],
  };
}

function request(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = (id: string): { params: Promise<{ id: string }> } => ({
  params: Promise.resolve({ id }),
});

describe("public flow API v0 compatibility", () => {
  it("retains create, list, get, update, run, launch, and delete envelopes", async () => {
    currentOwner = `compat-public-api-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const original = graph("graph-public-api-v0");

    const createdResponse = await createFlow(
      request("https://agents.suedeai.ai/api/flows", "POST", {
        name: original.name,
        graph: original,
      }),
    );
    expect(createdResponse.status).toBe(200);
    const created = (await createdResponse.json()) as {
      flow: { id: string; ownerId: string; name: string; graph: FlowGraph; updatedAt: number };
    };
    expect(Object.keys(created)).toEqual(["flow"]);
    expect(created.flow).toMatchObject({ ownerId: currentOwner, name: original.name, graph: original });
    expect(created.flow.id).not.toBe(original.id);
    expect(typeof created.flow.updatedAt).toBe("number");

    const listedResponse = await listFlows();
    const listed = (await listedResponse.json()) as { flows: Array<{ id: string }> };
    expect(Object.keys(listed)).toEqual(["flows"]);
    expect(listed.flows.some((flow) => flow.id === created.flow.id)).toBe(true);

    const fetchedResponse = await getFlow(
      new Request(`https://agents.suedeai.ai/api/flows/${created.flow.id}`),
      params(created.flow.id),
    );
    expect(await fetchedResponse.json()).toMatchObject({
      flow: { id: created.flow.id, graph: original },
    });

    const changed = graph(original.id, "Updated compatibility flow");
    const updatedResponse = await updateFlow(
      request(`https://agents.suedeai.ai/api/flows/${created.flow.id}`, "PUT", {
        name: changed.name,
        graph: changed,
      }),
      params(created.flow.id),
    );
    expect(await updatedResponse.json()).toMatchObject({
      flow: { id: created.flow.id, name: changed.name, graph: changed },
    });

    const runResponse = await runFlow(
      request(`https://agents.suedeai.ai/api/flows/${created.flow.id}/run`, "POST", {
        triggerInput: { value: "compat" },
      }),
      params(created.flow.id),
    );
    expect(runResponse.status).toBe(200);
    expect(runResponse.headers.get("content-type")).toContain("text/event-stream");
    const events = (await runResponse.text())
      .split("\n\n")
      .map((frame) => frame.trim())
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)) as RunEvent);
    expect(events[0]?.kind).toBe("run:start");
    expect(events.at(-1)?.kind).toBe("run:done");

    const launchResponse = await launchFlow(
      request(`https://agents.suedeai.ai/api/flows/${created.flow.id}/launch`, "POST", {
        priceUsdc: 0,
      }),
      params(created.flow.id),
    );
    expect(launchResponse.status).toBe(200);
    const launched = (await launchResponse.json()) as Record<string, unknown> & {
      agent: { id: string; flowId: string; slug: string };
      slug: string;
      urls: Record<string, string>;
      endpoints: string[];
    };
    expect(launched.agent.flowId).toBe(created.flow.id);
    expect(launched.slug).toBe(launched.agent.slug);
    expect(Object.keys(launched.urls).sort()).toEqual(["a2a", "card", "public", "run", "x402"]);
    expect(launched.endpoints.sort()).toEqual(Object.values(launched.urls).sort());
    expect(launched).toHaveProperty("schedule");
    expect(launched).toHaveProperty("payout");

    const deletedResponse = await deleteFlow(
      request(`https://agents.suedeai.ai/api/flows/${created.flow.id}`, "DELETE"),
      params(created.flow.id),
    );
    expect(await deletedResponse.json()).toEqual({ deleted: true });
  });
});
