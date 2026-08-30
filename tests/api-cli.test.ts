/**
 * Tests for the CLI API routes: /api/cli/agents and /api/cli/agents/[slug]
 *
 * TDD: route handlers with a seeded SqliteRepo owner.
 * Auth: Authorization: Bearer <workspaceKey> where workspaceKey == ownerId (UUID).
 * Push creates agent; push again to same slug updates (launch dedup law).
 * Pull returns valid AgentManifest.
 */

import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { AgentManifestSchema } from "@/lib/manifest/schema";
import type { AgentManifest } from "@/lib/manifest/schema";

// ────────────────────────────────────────────────────────────────────────────
// Shared helpers — invoke route handlers directly with a seeded repo
// ────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "cli-test-owner-" + Math.random().toString(36).slice(2, 7);

const SAMPLE_MANIFEST: AgentManifest = AgentManifestSchema.parse({
  manifestVersion: 1,
  name: "My CLI Agent",
  description: "A test agent pushed via CLI",
  triggers: [{ kind: "paidCall", priceUsdc: 0.1 }],
  steps: [
    { id: "n1", type: "input", config: {}, after: [] },
    { id: "n2", type: "llm", config: { prompt: "do stuff" }, after: ["n1"] },
    { id: "n3", type: "output", config: {}, after: ["n2"] },
  ],
  meta: { createdBy: "code" },
});

/** Build a mock Request with Authorization: Bearer <key> and optional JSON body. */
function makeRequest(
  method: string,
  url: string,
  ownerId: string,
  body?: unknown,
): Request {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${ownerId}`,
    "Content-Type": "application/json",
  };
  return new Request(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Import route handler logic (pure functions that accept repo + owner)
// ────────────────────────────────────────────────────────────────────────────

import {
  handleCliAgentsList,
  handleCliAgentsPush,
  type PushResult,
} from "@/lib/cli/agents-handler";
import { handleCliAgentPull } from "@/lib/cli/agent-slug-handler";

function assertPushResult(value: { readonly ok: boolean }): asserts value is PushResult {
  expect(value.ok).toBe(true);
  if (!value.ok) throw new Error("expected CLI push success");
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("CLI routes — push/pull", () => {
  it("refuses CLI publication with static HTTP credentials before flow or agent writes", async () => {
    const repo = new SqliteRepo(":memory:");
    const owner = `cli-http-credential-${Math.random().toString(36).slice(2, 10)}`;
    const manifest: AgentManifest = AgentManifestSchema.parse({
      manifestVersion: 1,
      name: "Credential HTTP Agent",
      triggers: [{ kind: "manual" }],
      steps: [
        { id: "i", type: "input", config: {}, after: [] },
        {
          id: "h", type: "http",
          config: {
            method: "GET", url: "https://example.com",
            headers: { Accept: "application/json", "X-Api-Key": "cli-publish-canary" },
          },
          after: ["i"],
        },
        { id: "o", type: "output", config: {}, after: ["h"] },
      ],
    });

    await expect(handleCliAgentsPush(manifest, owner, repo)).rejects.toThrow(
      "HTTP credentials must use an opaque Connection binding before publication.",
    );
    expect(await repo.listFlows(owner)).toEqual([]);
    expect(await repo.listAgentsByOwner(owner)).toEqual([]);
  });

  it("push creates an agent and returns a slug + public URL", async () => {
    const repo = new SqliteRepo(":memory:");
    const result = await handleCliAgentsPush(SAMPLE_MANIFEST, OWNER_ID, repo);

    assertPushResult(result);
    expect(typeof result.slug).toBe("string");
    expect(result.slug).toContain("my-cli-agent");
    expect(result.url).toContain("/a/");
    expect(result.manifest).toBeDefined();
  });

  it("push again to same flow slug updates (launch dedup law)", async () => {
    const repo = new SqliteRepo(":memory:");

    // First push
    const first = await handleCliAgentsPush(SAMPLE_MANIFEST, OWNER_ID, repo);
    assertPushResult(first);
    const firstSlug = first.slug;

    // Second push of same manifest — should update, not create a new agent
    const second = await handleCliAgentsPush(SAMPLE_MANIFEST, OWNER_ID, repo);
    assertPushResult(second);
    expect(second.slug).toBe(firstSlug);

    // Verify only one agent exists for the owner
    const agents = await repo.listAgentsByOwner(OWNER_ID);
    expect(agents.length).toBe(1);
  });

  it("push respects priceUsdc from the manifest trigger", async () => {
    const repo = new SqliteRepo(":memory:");
    const manifest: AgentManifest = AgentManifestSchema.parse({
      ...SAMPLE_MANIFEST,
      triggers: [{ kind: "paidCall", priceUsdc: 0.5 }],
    });
    const result = await handleCliAgentsPush(manifest, OWNER_ID, repo);
    assertPushResult(result);

    const agent = await repo.getAgentBySlug(result.slug);
    expect(agent).not.toBeNull();
    expect(agent!.priceUsdc).toBe(0.5);
  });

  it("list returns empty array for a fresh owner", async () => {
    const repo = new SqliteRepo(":memory:");
    const freshOwner = "fresh-" + Math.random().toString(36).slice(2, 8);
    const result = await handleCliAgentsList(freshOwner, repo);
    expect(result.agents).toEqual([]);
  });

  it("list returns agent manifests after push", async () => {
    const repo = new SqliteRepo(":memory:");
    await handleCliAgentsPush(SAMPLE_MANIFEST, OWNER_ID, repo);
    const result = await handleCliAgentsList(OWNER_ID, repo);
    expect(result.agents.length).toBe(1);
    expect(result.agents[0].name).toBe("My CLI Agent");
  });

  it("pull returns a valid AgentManifest and source for the slug", async () => {
    const repo = new SqliteRepo(":memory:");
    const pushed = await handleCliAgentsPush(SAMPLE_MANIFEST, OWNER_ID, repo);
    assertPushResult(pushed);
    const result = await handleCliAgentPull(pushed.slug, OWNER_ID, repo);

    expect(result).not.toBeNull();
    const parsed = AgentManifestSchema.safeParse(result!.manifest);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.name).toBe("My CLI Agent");
    // source must contain defineAgent and the agent name
    expect(result!.source).toContain("defineAgent");
    expect(result!.source).toContain("My CLI Agent");
  });

  it("pull enriches paidCall priceUsdc from agent row", async () => {
    const repo = new SqliteRepo(":memory:");
    const manifest: AgentManifest = AgentManifestSchema.parse({
      ...SAMPLE_MANIFEST,
      name: "Price Enriched Agent",
      triggers: [{ kind: "paidCall", priceUsdc: 0.75 }],
    });
    const pushed = await handleCliAgentsPush(manifest, OWNER_ID, repo);
    assertPushResult(pushed);
    const result = await handleCliAgentPull(pushed.slug, OWNER_ID, repo);
    expect(result).not.toBeNull();
    const paidTrigger = result!.manifest.triggers.find((t) => t.kind === "paidCall");
    expect(paidTrigger).toBeDefined();
    expect((paidTrigger as { priceUsdc: number }).priceUsdc).toBeCloseTo(0.75);
  });

  it("pull returns null for an unknown slug", async () => {
    const repo = new SqliteRepo(":memory:");
    const result = await handleCliAgentPull("no-such-slug-xyz", OWNER_ID, repo);
    expect(result).toBeNull();
  });

  it("pull returns null when owner does not match", async () => {
    const repo = new SqliteRepo(":memory:");
    await handleCliAgentsPush(SAMPLE_MANIFEST, OWNER_ID, repo);
    // Push creates agent under OWNER_ID; pull with wrong owner should fail
    const pushed = await handleCliAgentsPush(SAMPLE_MANIFEST, OWNER_ID, repo);
    assertPushResult(pushed);
    const result = await handleCliAgentPull(pushed.slug, "wrong-owner-uuid", repo);
    expect(result).toBeNull();
  });

  it("push creates a schedule when manifest has a schedule trigger", async () => {
    const repo = new SqliteRepo(":memory:");
    const scheduledManifest: AgentManifest = AgentManifestSchema.parse({
      manifestVersion: 1,
      name: "Scheduled Agent",
      description: "Runs daily",
      triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
      steps: [
        { id: "s1", type: "input", config: {}, after: [] },
        { id: "s2", type: "output", config: {}, after: ["s1"] },
      ],
      meta: {},
    });

    const result = await handleCliAgentsPush(scheduledManifest, OWNER_ID, repo);
    assertPushResult(result);

    const agent = await repo.getAgentBySlug(result.slug);
    expect(agent).not.toBeNull();
    const schedules = await repo.listSchedulesByAgents([agent!.id]);
    expect(schedules.length).toBe(1);
    expect(schedules[0].cron).toBe("0 9 * * *");
    expect(schedules[0].enabled).toBe(true);
  });
});

describe("CLI route auth — Bearer token extraction", () => {
  it("extracts owner from Authorization header", () => {
    const req = makeRequest("GET", "http://localhost/api/cli/agents", OWNER_ID);
    const authHeader = req.headers.get("Authorization");
    expect(authHeader).toBe(`Bearer ${OWNER_ID}`);
    const extracted = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;
    expect(extracted).toBe(OWNER_ID);
  });

  it("rejects missing Authorization header", () => {
    const req = new Request("http://localhost/api/cli/agents", { method: "GET" });
    const authHeader = req.headers.get("Authorization");
    expect(authHeader).toBeNull();
  });
});

describe("CLI push — rate limit", () => {
  it("returns rateLimited: true after 10 rapid pushes from the same owner", async () => {
    const repo = new SqliteRepo(":memory:");
    const rateLimitOwner = "rl-owner-" + Math.random().toString(36).slice(2, 10);

    const makeManifest = (n: number): AgentManifest =>
      AgentManifestSchema.parse({
        manifestVersion: 1,
        name: `rl-agent-${n}-${rateLimitOwner}`,
        triggers: [{ kind: "manual" }],
        steps: [
          { id: "n1", type: "input", config: {}, after: [] },
          { id: "n2", type: "output", config: {}, after: ["n1"] },
        ],
      });

    const results = [];
    for (let i = 0; i < 12; i++) {
      results.push(await handleCliAgentsPush(makeManifest(i), rateLimitOwner, repo));
    }

    // First 10 succeed
    expect(results.slice(0, 10).every((r) => r.ok === true)).toBe(true);
    // 11th is rate-limited
    const eleventh = results[10] as { ok: boolean; rateLimited?: boolean };
    expect(eleventh.ok).toBe(false);
    expect(eleventh.rateLimited).toBe(true);
  });
});
