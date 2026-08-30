import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlowMutationStoreUnavailableError } from "@/lib/flow/flow-mutation-service";

const state = vi.hoisted(() => ({
  authorization: null as string | null,
  ownerHeader: null as string | null,
  pushResult: null as unknown,
  pushCalls: [] as unknown[][],
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => {
      if (name.toLowerCase() === "authorization") return state.authorization;
      if (name.toLowerCase() === "x-owner-id") return state.ownerHeader;
      return null;
    },
  }),
}));

vi.mock("@/lib/db/repo", () => ({ getRepo: async () => ({}) }));
vi.mock("@/lib/cli/agents-handler", () => ({
  handleCliAgentsList: async () => ({ agents: [] }),
  handleCliAgentsPush: async (...args: unknown[]) => {
    state.pushCalls.push(args);
    if (state.pushResult instanceof Error) throw state.pushResult;
    return state.pushResult;
  },
}));

const route = await import("@/app/api/cli/agents/route");

const manifest = {
  manifestVersion: 1,
  name: "CLI route",
  description: "Bounded route fixture",
  triggers: [{ kind: "manual" }],
  steps: [
    { id: "in", type: "input", config: {}, after: [] },
    { id: "out", type: "output", config: {}, after: ["in"] },
  ],
  meta: { createdBy: "code" },
};

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://agents.suedeai.ai/api/cli/agents", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function expectPrivate(response: Response, status: number): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return await response.json() as Record<string, unknown>;
}

describe("private CLI agents route envelopes", () => {
  beforeEach(() => {
    state.authorization = "Bearer owner-cli-route";
    state.ownerHeader = null;
    state.pushCalls.length = 0;
    state.pushResult = { ok: true, slug: "cli-route", url: "/a/cli-route", manifest };
  });

  it("returns a fixed private 401 before reading the body", async () => {
    state.authorization = null;
    expect(await expectPrivate(await route.POST(request({ surprise: true })), 401))
      .toEqual({ error: "Authorization required" });
    expect(state.pushCalls).toHaveLength(0);
  });

  it("returns a strict bounded 400 without schema details", async () => {
    const response = await route.POST(request({ ...manifest, surprise: true }));
    expect(await expectPrivate(response, 400)).toEqual({ error: "Invalid AgentManifest" });
  });

  it("returns an allowlisted impact handshake and passes only the retry receipt", async () => {
    const receipt = "r".repeat(43);
    state.pushResult = {
      ok: false,
      mutationRefused: true,
      status: "impact-required",
      receipt,
      impact: { dependents: [], truncated: false, total: 0 },
    };
    const response = await route.POST(request(manifest, { "x-suede-impact-receipt": receipt }));
    expect(await expectPrivate(response, 409)).toEqual({
      error: "Flow mutation refused",
      status: "impact-required",
      receipt,
      impact: { dependents: [], truncated: false, total: 0 },
    });
    expect(state.pushCalls[0]?.[3]).toEqual({ impactReceipt: receipt });
  });

  it("preserves Retry-After without weakening private caching", async () => {
    state.pushResult = { ok: false, rateLimited: true, retryAfterSec: 7 };
    const response = await route.POST(request(manifest));
    await expectPrivate(response, 429);
    expect(response.headers.get("retry-after")).toBe("7");
  });

  it("maps unavailable mutation storage to a fixed private 503", async () => {
    state.pushResult = new FlowMutationStoreUnavailableError();
    expect(await expectPrivate(await route.POST(request(manifest)), 503))
      .toEqual({ error: "flow mutation unavailable" });
  });
});
