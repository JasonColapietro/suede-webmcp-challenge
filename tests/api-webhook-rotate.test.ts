/**
 * POST /api/agents/[agent]/webhook/rotate (rotation) and
 * DELETE /api/agents/[agent]/webhook (revocation) — owner-only webhook
 * secret mutation endpoints.
 *
 * Follows tests/api-launch-webhook.test.ts's convention: mock next/headers
 * and import the route handlers directly against the real sqlite repo
 * (studio.db), with unique per-test owner/flow/agent ids so parallel tests
 * in this file don't collide. Follows tests/api-flows-auth.test.ts's
 * convention for the unauthenticated (401) case: stub NODE_ENV=production so
 * resolveOwnerId() actually throws instead of falling back to the dev owner.
 *
 * Every request in this file sets a unique x-real-ip header so the IP-keyed
 * rate-limit bucket (shared module-level state — see src/lib/rate-limit.ts)
 * doesn't bleed across unrelated tests; only the dedicated rate-limit test
 * reuses one IP on purpose.
 */
import { describe, it, expect, vi } from "vitest";
import { getRepo } from "@/lib/db/repo";
import type { FlowGraph } from "@/lib/flow/types";
import { generateWebhookSecret, signWebhookRequest } from "@/lib/webhook-auth";

let currentOwner: string | null = "owner-webhook-rotate-default";

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k === "x-owner-id" ? currentOwner : null),
  }),
  cookies: async () => ({ get: () => undefined }),
}));

const { POST: rotate } = await import("@/app/api/agents/[agent]/webhook/rotate/route");
const { POST: inboundWebhook, DELETE: revoke } = await import(
  "@/app/api/agents/[agent]/webhook/route"
);

const webhookGraph: FlowGraph = {
  id: "g-webhook-rotate",
  name: "webhook flow",
  nodes: [
    { id: "w", type: "webhook", params: {}, position: { x: 0, y: 0 } },
    { id: "o", type: "output", params: {}, position: { x: 1, y: 0 } },
  ],
  edges: [{ id: "w->o", source: "w", target: "o" }],
};

const noWebhookGraph: FlowGraph = {
  id: "g-no-webhook-rotate",
  name: "no webhook flow",
  nodes: [{ id: "i", type: "input", params: {}, position: { x: 0, y: 0 } }],
  edges: [],
};

let seedCounter = 0;
function nextSuffix(): string {
  seedCounter += 1;
  return `${Date.now()}-${seedCounter}`;
}

/** Creates a live agent owned by `owner`, with a webhook endpoint seeded to a known secret. */
async function seedAgentWithWebhook(
  owner: string,
): Promise<{ agentId: string; secret: string }> {
  const repo = await getRepo();
  const suffix = nextSuffix();
  const flow = await repo.saveFlow({
    ownerId: owner,
    name: `webhook flow ${suffix}`,
    graph: { ...webhookGraph, id: `g-webhook-rotate-${suffix}` },
  });
  const agent = await repo.createAgent({
    flowId: flow.id,
    slug: `webhook-rotate-${suffix}`,
    status: "live",
  });
  const secret = generateWebhookSecret();
  await repo.upsertWebhookEndpoint({ agentId: agent.id, secretHash: secret });
  return { agentId: agent.id, secret };
}

/** Creates a live agent owned by `owner` with NO webhook endpoint at all. */
async function seedAgentWithoutWebhook(owner: string): Promise<{ agentId: string }> {
  const repo = await getRepo();
  const suffix = nextSuffix();
  const flow = await repo.saveFlow({
    ownerId: owner,
    name: `no webhook flow ${suffix}`,
    graph: { ...noWebhookGraph, id: `g-no-webhook-rotate-${suffix}` },
  });
  const agent = await repo.createAgent({
    flowId: flow.id,
    slug: `no-webhook-rotate-${suffix}`,
    status: "live",
  });
  return { agentId: agent.id };
}

function rotateReq(agentId: string, ip: string): Request {
  return new Request(`https://agents.suedeai.ai/api/agents/${agentId}/webhook/rotate`, {
    method: "POST",
    headers: { "x-real-ip": ip },
  });
}

function revokeReq(agentId: string, ip: string): Request {
  return new Request(`https://agents.suedeai.ai/api/agents/${agentId}/webhook`, {
    method: "DELETE",
    headers: { "x-real-ip": ip },
  });
}

function inboundReq(agentId: string, rawBody: string, timestamp: string, signature: string): Request {
  return new Request(`https://agents.suedeai.ai/api/agents/${agentId}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-suede-webhook-signature": signature,
      "x-suede-webhook-timestamp": timestamp,
    },
    body: rawBody,
  });
}

async function callAgent(agentId: string, secret: string): Promise<Response> {
  const rawBody = JSON.stringify({ event: "ping" });
  const timestamp = String(Date.now());
  const signature = signWebhookRequest(timestamp, rawBody, secret);
  return inboundWebhook(inboundReq(agentId, rawBody, timestamp, signature), {
    params: Promise.resolve({ agent: agentId }),
  });
}

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

describe("POST /api/agents/[agent]/webhook/rotate", () => {
  it("owner can rotate: response contains a new secret, old secret no longer verifies, new secret verifies", async () => {
    const owner = `owner-rotate-happy-${nextSuffix()}`;
    currentOwner = owner;
    const { agentId, secret: oldSecret } = await seedAgentWithWebhook(owner);

    // Old secret works before rotation.
    const before = await callAgent(agentId, oldSecret);
    expect(before.status).toBe(200);

    const res = await rotate(rotateReq(agentId, nextIp()), {
      params: Promise.resolve({ agent: agentId }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { agentId: string; slug: string; secret: string };
    expect(json.agentId).toBe(agentId);
    expect(json.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(json.secret).not.toBe(oldSecret);

    // Old secret is invalidated immediately.
    const afterOld = await callAgent(agentId, oldSecret);
    expect(afterOld.status).toBe(401);

    // New secret verifies.
    const afterNew = await callAgent(agentId, json.secret);
    expect(afterNew.status).toBe(200);
  });

  it("non-owner cannot rotate someone else's secret", async () => {
    const owner = `owner-rotate-owner-${nextSuffix()}`;
    const nonOwner = `owner-rotate-nonowner-${nextSuffix()}`;
    const { agentId, secret } = await seedAgentWithWebhook(owner);

    currentOwner = nonOwner;
    const res = await rotate(rotateReq(agentId, nextIp()), {
      params: Promise.resolve({ agent: agentId }),
    });
    expect([403, 404]).toContain(res.status);

    // The real owner's secret must still work — rotation never happened.
    const stillWorks = await callAgent(agentId, secret);
    expect(stillWorks.status).toBe(200);
  });

  it("unauthenticated caller gets 401", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      currentOwner = null;
      const owner = `owner-rotate-unauth-${nextSuffix()}`;
      const { agentId } = await seedAgentWithWebhook(owner);

      const res = await rotate(rotateReq(agentId, nextIp()), {
        params: Promise.resolve({ agent: agentId }),
      });
      expect(res.status).toBe(401);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rotating an agent with no webhook endpoint returns a clean 4xx, not a 500", async () => {
    const owner = `owner-rotate-nowebhook-${nextSuffix()}`;
    currentOwner = owner;
    const { agentId } = await seedAgentWithoutWebhook(owner);

    const res = await rotate(rotateReq(agentId, nextIp()), {
      params: Promise.resolve({ agent: agentId }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rotating a nonexistent agent id returns a clean 4xx, not a 500", async () => {
    currentOwner = `owner-rotate-ghost-${nextSuffix()}`;
    const res = await rotate(rotateReq("does-not-exist", nextIp()), {
      params: Promise.resolve({ agent: "does-not-exist" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rate limit applies: repeated rotation attempts eventually 429", async () => {
    const owner = `owner-rotate-ratelimit-${nextSuffix()}`;
    currentOwner = owner;
    const { agentId } = await seedAgentWithWebhook(owner);
    const ip = nextIp();

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await rotate(rotateReq(agentId, ip), {
        params: Promise.resolve({ agent: agentId }),
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});

describe("DELETE /api/agents/[agent]/webhook — revocation", () => {
  it("owner can revoke: subsequent inbound calls with the old secret fail", async () => {
    const owner = `owner-revoke-happy-${nextSuffix()}`;
    currentOwner = owner;
    const { agentId, secret } = await seedAgentWithWebhook(owner);

    const res = await revoke(revokeReq(agentId, nextIp()), {
      params: Promise.resolve({ agent: agentId }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { revoked: boolean };
    expect(json.revoked).toBe(true);

    const after = await callAgent(agentId, secret);
    expect(after.status).toBe(401);
  });

  it("non-owner cannot revoke someone else's webhook", async () => {
    const owner = `owner-revoke-owner-${nextSuffix()}`;
    const nonOwner = `owner-revoke-nonowner-${nextSuffix()}`;
    const { agentId, secret } = await seedAgentWithWebhook(owner);

    currentOwner = nonOwner;
    const res = await revoke(revokeReq(agentId, nextIp()), {
      params: Promise.resolve({ agent: agentId }),
    });
    expect([403, 404]).toContain(res.status);

    const stillWorks = await callAgent(agentId, secret);
    expect(stillWorks.status).toBe(200);
  });

  it("revoking an agent with no webhook endpoint returns a clean 4xx, not a 500", async () => {
    const owner = `owner-revoke-nowebhook-${nextSuffix()}`;
    currentOwner = owner;
    const { agentId } = await seedAgentWithoutWebhook(owner);

    const res = await revoke(revokeReq(agentId, nextIp()), {
      params: Promise.resolve({ agent: agentId }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
