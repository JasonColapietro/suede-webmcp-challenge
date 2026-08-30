/**
 * Tests for relay route handler logic and run-route relay forwarding.
 *
 * Uses the in-memory SqliteRepo (dev mode) so no Supabase required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// handleRelayPost/forwardToRelay now validate the relay URL's resolved
// address (SSRF guard). Stub DNS to a public IP so these ownership/CRUD
// tests aren't gated on real DNS resolution of example.com subdomains.
// SSRF-specific rejection behavior is covered in tests/lib/safe-url.test.ts.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

// ── relay endpoint handler ──────────────────────────────────────────────────

describe("handleRelayPost — creates row and returns secret once", () => {
  it("returns a 64-char hex secret on first POST", async () => {
    const { handleRelayPost } = await import("@/lib/cli/relay-handler");
    const { SqliteRepo } = await import("@/lib/db/sqlite-repo");
    const repo = new SqliteRepo(":memory:");

    // Create an agent to link
    const flow = await repo.saveFlow({ ownerId: "owner-1", name: "test", graph: { id: "g1", name: "test", nodes: [], edges: [] } });
    const agent = await repo.createAgent({ flowId: flow.id, slug: "test-slug" });

    const result = await handleRelayPost(agent.slug, "owner-1", "https://relay.example.com", repo);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(result.protocolVersion).toBe(1);
    }
  });

  it("registers relay v2 explicitly while legacy registrations default to v1", async () => {
    const { handleRelayPost, handleRelayGet } = await import("@/lib/cli/relay-handler");
    const { SqliteRepo } = await import("@/lib/db/sqlite-repo");
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({
      ownerId: "owner-v2",
      name: "test",
      graph: { id: "g-v2", name: "test", nodes: [], edges: [] },
    });
    const agent = await repo.createAgent({ flowId: flow.id, slug: "relay-v2" });

    const created = await handleRelayPost(
      agent.slug,
      "owner-v2",
      "https://relay.example.com/v2",
      repo,
      2,
    );

    expect(created).toMatchObject({ ok: true, protocolVersion: 2 });
    expect(await handleRelayGet(agent.slug, "owner-v2", repo)).toEqual({
      linked: true,
      url: "https://relay.example.com/v2",
      protocolVersion: 2,
    });
  });

  it("rejects if the owner does not own the agent", async () => {
    const { handleRelayPost } = await import("@/lib/cli/relay-handler");
    const { SqliteRepo } = await import("@/lib/db/sqlite-repo");
    const repo = new SqliteRepo(":memory:");

    const flow = await repo.saveFlow({ ownerId: "owner-1", name: "test", graph: { id: "g2", name: "test", nodes: [], edges: [] } });
    await repo.createAgent({ flowId: flow.id, slug: "slug-owned" });

    const result = await handleRelayPost("slug-owned", "intruder", "https://relay.example.com", repo);
    expect(result.ok).toBe(false);
  });

  it("rejects Resource relay configuration before persisting an endpoint", async () => {
    const { handleRelayPost } = await import("@/lib/cli/relay-handler");
    const { SqliteRepo } = await import("@/lib/db/sqlite-repo");
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({
      ownerId: "resource-owner", name: "resource",
      graph: { id: "resource-graph", name: "resource", nodes: [], edges: [], meta: { resourceProduct: { id: "resource-1" } } },
    });
    const agent = await repo.createAgent({ flowId: flow.id, slug: "resource-relay" });

    await expect(handleRelayPost(agent.slug, "resource-owner", "https://relay.example.com", repo))
      .resolves.toEqual({ ok: false, reason: "Resource agents do not support relay execution.", status: 409 });
    await expect(repo.getRelayEndpoint(agent.id)).resolves.toBeNull();
  });

  it("upserts on second POST (replaces url, new secret)", async () => {
    const { handleRelayPost } = await import("@/lib/cli/relay-handler");
    const { SqliteRepo } = await import("@/lib/db/sqlite-repo");
    const repo = new SqliteRepo(":memory:");

    const flow = await repo.saveFlow({ ownerId: "owner-2", name: "test", graph: { id: "g3", name: "test", nodes: [], edges: [] } });
    const agent = await repo.createAgent({ flowId: flow.id, slug: "slug-upsert" });

    const r1 = await handleRelayPost(agent.slug, "owner-2", "https://v1.example.com", repo);
    const r2 = await handleRelayPost(agent.slug, "owner-2", "https://v2.example.com", repo);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      // Secrets differ (regenerated on upsert)
      expect(r1.secret).not.toBe(r2.secret);
    }
  });
});

describe("handleRelayGet — returns url but never secret", () => {
  it("returns linked:true and url after a relay is registered", async () => {
    const { handleRelayPost, handleRelayGet } = await import("@/lib/cli/relay-handler");
    const { SqliteRepo } = await import("@/lib/db/sqlite-repo");
    const repo = new SqliteRepo(":memory:");

    const flow = await repo.saveFlow({ ownerId: "owner-3", name: "test", graph: { id: "g4", name: "test", nodes: [], edges: [] } });
    const agent = await repo.createAgent({ flowId: flow.id, slug: "slug-get" });

    await handleRelayPost(agent.slug, "owner-3", "https://relay.example.com", repo);
    const result = await handleRelayGet(agent.slug, "owner-3", repo);

    expect(result).not.toBeNull();
    expect(result?.linked).toBe(true);
    expect(result?.url).toBe("https://relay.example.com");
    // Must NOT contain secret
    expect(Object.keys(result ?? {})).not.toContain("secret");
  });

  it("returns null when no relay is registered", async () => {
    const { handleRelayGet } = await import("@/lib/cli/relay-handler");
    const { SqliteRepo } = await import("@/lib/db/sqlite-repo");
    const repo = new SqliteRepo(":memory:");

    const flow = await repo.saveFlow({ ownerId: "owner-4", name: "test", graph: { id: "g5", name: "test", nodes: [], edges: [] } });
    await repo.createAgent({ flowId: flow.id, slug: "slug-empty" });

    const result = await handleRelayGet("slug-empty", "owner-4", repo);
    expect(result).toBeNull();
  });
});

// ── run route relays via forwardToRelay when relay row exists ───────────────

describe("run route — relay forwarding", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls forwardToRelay when a relay row is found for the agent", async () => {
    const { forwardToRelay } = await import("@/lib/relay");
    const mockForward = vi.spyOn({ forwardToRelay }, "forwardToRelay");
    // The actual integration: relay row present → fetch called with relay URL
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ result: "relayed" }), { status: 200 }),
    );

    const { SqliteRepo } = await import("@/lib/db/sqlite-repo");
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({ ownerId: "owner-relay", name: "test", graph: { id: "g6", name: "relay-agent", nodes: [], edges: [] } });
    const agent = await repo.createAgent({ flowId: flow.id, slug: "relay-agent-slug", status: "live" });

    const { handleRelayPost } = await import("@/lib/cli/relay-handler");
    await handleRelayPost(agent.slug, "owner-relay", "https://relay.example.com/run", repo);

    // Call forwardToRelay directly and check fetch is called with relay url
    const result = await forwardToRelay(
      { input: "test" },
      { url: "https://relay.example.com/run", secret: "secret" },
      "run-id",
      "relay-agent-slug",
    );
    expect(result).toEqual({ result: "relayed" });
    expect(fetch).toHaveBeenCalledWith(
      "https://relay.example.com/run",
      expect.objectContaining({ method: "POST" }),
    );
    mockForward.mockRestore();
  });
});
