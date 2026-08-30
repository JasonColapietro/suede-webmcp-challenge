import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";
import { catalogEntryToTool } from "@/lib/mcp/tools";
import { MCP_PREVIOUS_PROTOCOL_VERSION } from "@/lib/mcp/protocol";
import { handleMcpHttpRequest } from "@/lib/mcp/server";
import { createMcpDeps } from "@/lib/mcp/service";
import { resourceRunEnvelopeAccepts } from "@/lib/resources/run-receipt";
import { RESOURCE_TEST_NOW as NOW, resourcePack } from "./resources/fixture";

const providers = vi.hoisted(() => ({
  owner: "owner-api",
  flow: null as SqliteRepo | null,
  project: null as SqliteProjectRepo | null,
  resource: null as SqliteResourceRepository | null,
  enabled: true,
  now: new Date("2026-08-13T12:00:00.000Z"),
  resourceProviderCalls: 0,
  resourceExecutionCalls: 0,
  resourceEnvelopeWrites: 0,
  verifyAndSettle: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (key: string) => key === "x-owner-id" ? providers.owner : null }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/db/repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/repo")>()),
  getRepo: async () => providers.flow!,
}));
vi.mock("@/lib/projects/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/projects/provider")>()),
  getProjectRepo: async () => providers.project!,
}));
vi.mock("@/lib/resources/provider", () => ({
  getResourceRepository: async () => {
    providers.resourceProviderCalls += 1;
    return providers.resource!;
  },
  ResourceStoreUnavailableError: class ResourceStoreUnavailableError extends Error {},
}));
vi.mock("@/lib/resources/flags", () => ({
  get RESOURCE_FOUNDRY_ENABLED() { return providers.enabled; },
}));
vi.mock("@/lib/rails/x402-verify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rails/x402-verify")>()),
  verifyAndSettle: (...args: unknown[]) => providers.verifyAndSettle(...args),
}));
vi.mock("@/lib/run-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/run-service")>();
  return {
    ...actual,
    runPreparedPublishedLiveDryRunToCompletion: (
      ...args: Parameters<typeof actual.runPreparedPublishedLiveDryRunToCompletion>
    ) => {
      providers.resourceExecutionCalls += 1;
      return actual.runPreparedPublishedLiveDryRunToCompletion(...args);
    },
    runPreparedPublishedLiveToCompletion: (
      ...args: Parameters<typeof actual.runPreparedPublishedLiveToCompletion>
    ) => {
      providers.resourceExecutionCalls += 1;
      return actual.runPreparedPublishedLiveToCompletion(...args);
    },
  };
});
vi.mock("@/lib/resources/run-receipt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/resources/run-receipt")>();
  return {
    ...actual,
    buildAndPersistResourceRunEnvelope: (
      ...args: Parameters<typeof actual.buildAndPersistResourceRunEnvelope>
    ) => {
      providers.resourceEnvelopeWrites += 1;
      return actual.buildAndPersistResourceRunEnvelope(...args);
    },
  };
});

const { POST: materialize } = await import("@/app/api/v2/resources/[resourceId]/materialize/route");
const { POST: publish } = await import("@/app/api/v2/resources/[resourceId]/publish/route");
const { POST: transitionLifecycle } = await import("@/app/api/v2/resources/[resourceId]/lifecycle/route");
const { POST: runPublished } = await import("@/app/api/agents/[agent]/run/route");
const { GET: getAgentCard } = await import("@/app/api/agents/[agent]/.well-known/agent-card/route");
const { GET: getX402 } = await import("@/app/api/agents/[agent]/.well-known/x402/route");
const { GET: getA2A } = await import("@/app/api/agents/[agent]/a2a/route");
const { GET: getOpenApi } = await import("@/app/openapi.json/route");
const { buildCatalog } = await import("@/lib/catalog");
const { buildX402DiscoveryIndex } = await import("@/app/.well-known/x402/route");

describe("private resource materialize/publish routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runSqliteMigrations(db);
    providers.owner = `owner-api-${Date.now()}-${Math.random()}`;
    providers.enabled = true;
    providers.now = NOW;
    providers.resourceProviderCalls = 0;
    providers.resourceExecutionCalls = 0;
    providers.resourceEnvelopeWrites = 0;
    providers.verifyAndSettle.mockReset().mockResolvedValue({ ok: false, reason: "invalid" });
    providers.flow = new SqliteRepo(db);
    providers.project = new SqliteProjectRepo(db);
    providers.resource = new SqliteResourceRepository(db, { now: () => providers.now });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
  });

  async function approved(
    executionAccess: "free" | "paid" | "private" = "paid",
    discoveryAccess: "public" | "unlisted" = "public",
    suffix: string = executionAccess,
    recordName = "Alpha",
  ) {
    const resource = providers.resource!;
    const product = await resource.createProduct({
      ownerId: providers.owner, name: `Pricing signals ${suffix}`, slug: `pricing-${suffix}-${Date.now()}`,
      executionAccess, discoveryAccess,
    });
    const snapshotId = `snapshot-contract-${suffix}`;
    await resource.createSourceSnapshot({
      id: snapshotId, ownerId: providers.owner, resourceProductId: product.id,
      locator: "manual://pricing", sourceKind: "manual", capturedAt: NOW.toISOString(),
      contentHash: "a".repeat(64), freshnessDeadline: "2026-08-20T12:00:00.000Z",
    });
    const candidate = await resource.replaceCandidate({
      ownerId: providers.owner, resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: (() => {
        const base = resourcePack(recordName);
        return {
          ...base,
          sourceSnapshotIds: [snapshotId],
          evidence: base.evidence.map((item) => ({ ...item, sourceSnapshotId: snapshotId })),
        };
      })(), createdBy: providers.owner,
    });
    await resource.approveCandidate({
      ownerId: providers.owner, resourceProductId: product.id,
      candidatePackVersionId: candidate.id, expectedRevision: 1,
      expectedSemanticHash: candidate.semanticHash, approvedBy: providers.owner,
    });
    return product;
  }

  function request(path: string, body: unknown, authorization = false): Request {
    return new Request(`https://agents.suedeai.ai${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization: "Bearer forbidden" } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("materializes the server-current approved pointer and rejects caller pins", async () => {
    const product = await approved();
    const path = `/api/v2/resources/${product.id}/materialize`;
    const ok = await materialize(request(path, {}), { params: Promise.resolve({ resourceId: product.id }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    await expect(ok.json()).resolves.toMatchObject({ materialized: { resourceProductId: product.id } });

    const pinned = await materialize(request(path, { packVersionId: "caller-pin" }), {
      params: Promise.resolve({ resourceId: product.id }),
    });
    expect(pinned.status).toBe(400);
    await expect(pinned.json()).resolves.toEqual({ error: "invalid request" });
  });

  it("publishes privately and returns normal run, Agent Card, x402, A2A, and public URLs", async () => {
    const product = await approved();
    await providers.flow!.saveWallet({
      ownerId: providers.owner, address: "0x2222222222222222222222222222222222222222",
    });
    const path = `/api/v2/resources/${product.id}/publish`;
    const pinned = await publish(request(path, {
      priceUsdc: 0.05,
      packVersionId: "caller-pin",
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    }), { params: Promise.resolve({ resourceId: product.id }) });
    expect(pinned.status).toBe(400);
    const publishBody = {
      idempotencyKey: "publish-api-retry",
      priceUsdc: 0.05,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    };
    const response = await publish(request(path, publishBody), { params: Promise.resolve({ resourceId: product.id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json() as { published: { agent: { settlementLive: boolean }; urls: Record<string, string> } };
    expect(body.published.agent.settlementLive).toBe(false);
    expect(Object.keys(body.published.urls).sort()).toEqual(["a2a", "card", "public", "run", "x402"]);
    const replay = await publish(request(path, publishBody), { params: Promise.resolve({ resourceId: product.id }) });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(body);
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 1 });
  });

  it("removes paused and retired releases before discovery or payment and restores only the exact paused identity", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    const product = await approved();
    await providers.flow!.saveWallet({
      ownerId: providers.owner, address: "0x2222222222222222222222222222222222222222",
    });
    const publishPath = `/api/v2/resources/${product.id}/publish`;
    const publishedResponse = await publish(request(publishPath, {
      idempotencyKey: "publish-lifecycle",
      priceUsdc: 0.05,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    }), { params: Promise.resolve({ resourceId: product.id }) });
    const published = (await publishedResponse.json() as {
      published: {
        agent: { id: string; slug: string };
        release: { id: string; agentId: string; deploymentId: string; publicationKey: string };
      };
    }).published;
    await providers.flow!.updateAgent(published.agent.id, { settlementLive: true });
    const lifecyclePath = `/api/v2/resources/${product.id}/lifecycle`;
    const pins = {
      releaseId: published.release.id,
      agentId: published.release.agentId,
      deploymentId: published.release.deploymentId,
    };
    const lifecycle = (action: "pause" | "resume" | "retire", expectedStatus: "live" | "paused") =>
      transitionLifecycle(request(lifecyclePath, { action, expectedStatus, ...pins }), {
        params: Promise.resolve({ resourceId: product.id }),
      });
    const publicContext = { params: Promise.resolve({ agent: published.agent.slug }) };
    const runRequest = () => new Request(
      `https://agents.suedeai.ai/api/agents/${published.agent.slug}/run`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { tier: "paid" } }) },
    );

    const paused = await lifecycle("pause", "live");
    expect(paused.status).toBe(200);
    await expect(paused.json()).resolves.toMatchObject({
      resource: {
        status: "paused",
        currentRelease: { id: published.release.id, deploymentId: published.release.deploymentId },
      },
    });
    expect((await buildCatalog()).map((entry) => entry.id)).not.toContain(published.agent.id);
    expect((await getAgentCard(new Request(
      `https://agents.suedeai.ai/api/agents/${published.agent.slug}/.well-known/agent-card.json`,
    ), publicContext)).status).toBe(404);
    expect((await runPublished(runRequest(), publicContext)).status).toBe(404);

    const stale = await transitionLifecycle(request(lifecyclePath, {
      action: "resume", expectedStatus: "paused", ...pins, deploymentId: "superseded-deployment",
    }), { params: Promise.resolve({ resourceId: product.id }) });
    expect(stale.status).toBe(409);
    const resumed = await lifecycle("resume", "paused");
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({ resource: { status: "live" } });
    expect((await buildCatalog()).map((entry) => entry.id)).toContain(published.agent.id);
    expect((await getAgentCard(new Request(
      `https://agents.suedeai.ai/api/agents/${published.agent.slug}/.well-known/agent-card.json`,
    ), publicContext)).status).toBe(200);
    expect((await runPublished(runRequest(), publicContext)).status).toBe(402);

    expect((await lifecycle("pause", "live")).status).toBe(200);
    const retired = await lifecycle("retire", "paused");
    expect(retired.status).toBe(200);
    await expect(retired.json()).resolves.toMatchObject({
      resource: {
        status: "retired",
        currentRelease: { id: published.release.id, deploymentId: published.release.deploymentId },
        releaseCount: 1,
      },
    });
    expect((await buildCatalog()).map((entry) => entry.id)).not.toContain(published.agent.id);
    expect((await runPublished(runRequest(), publicContext)).status).toBe(404);
    expect(await providers.resource!.getOwnedPublishedReleaseByPublicationKey(
      providers.owner, product.id, published.release.publicationKey,
    )).toMatchObject({ id: published.release.id });
    expect((await lifecycle("resume", "paused")).status).toBe(409);
  });

  it("keeps foreign resources opaque and rejects Authorization mutations", async () => {
    const product = await approved();
    const path = `/api/v2/resources/${product.id}/materialize`;
    providers.owner = "foreign-owner";
    const foreign = await materialize(request(path, {}), { params: Promise.resolve({ resourceId: product.id }) });
    expect(foreign.status).toBe(404);
    await expect(foreign.json()).resolves.toEqual({ error: "not found" });
    const auth = await materialize(request(path, {}, true), { params: Promise.resolve({ resourceId: product.id }) });
    expect(auth.status).toBe(401);
    expect(auth.headers.get("cache-control")).toBe("private, no-store");
  });

  it("hides and refuses a published Resource across HTTP, catalog, OpenAPI, and MCP before payment when the operational flag is off", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    await providers.flow!.saveWallet({
      ownerId: providers.owner,
      address: "0x2222222222222222222222222222222222222222",
    });
    const product = await approved("paid", "public", "flag-off");
    const response = await publish(request(`/api/v2/resources/${product.id}/publish`, {
      idempotencyKey: "publish-flag-off",
      priceUsdc: 0.05,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    }), { params: Promise.resolve({ resourceId: product.id }) });
    const published = (await response.json() as {
      published: { agent: { id: string; slug: string } };
    }).published;
    await providers.flow!.updateAgent(published.agent.id, { settlementLive: true });
    expect((await buildCatalog()).some((entry) => entry.id === published.agent.id)).toBe(true);

    const before = {
      runs: (db.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count,
      settlements: (db.prepare("SELECT COUNT(*) count FROM settlements").get() as { count: number }).count,
      receipts: (db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get() as { count: number }).count,
    };
    providers.enabled = false;
    const resourceProviderCalls = providers.resourceProviderCalls;

    expect((await buildCatalog()).some((entry) => entry.id === published.agent.id)).toBe(false);
    expect(JSON.stringify(await (await getOpenApi()).json())).not.toContain(product.id);
    const routeContext = { params: Promise.resolve({ agent: published.agent.slug }) };
    for (const route of [getAgentCard, getX402, getA2A]) {
      const discovery = await route(
        new Request(`https://agents.suedeai.ai/api/agents/${published.agent.slug}`),
        routeContext,
      );
      expect(discovery.status).toBe(404);
    }

    const mcp = await handleMcpHttpRequest({
      httpMethod: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PREVIOUS_PROTOCOL_VERSION,
      }),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      deps: await createMcpDeps(),
    });
    expect(JSON.stringify(mcp.body)).not.toContain(product.id);

    const refused = await runPublished(new Request(
      `https://agents.suedeai.ai/api/agents/${published.agent.slug}/run`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "payment-signature": "invalid-but-present",
          "x-real-ip": "192.0.2.10",
        },
        body: JSON.stringify({ input: { tier: "paid" } }),
      },
    ), routeContext);
    expect(refused.status).toBe(404);
    await expect(refused.json()).resolves.toEqual({ error: "agent not found" });
    expect({
      runs: (db.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count,
      settlements: (db.prepare("SELECT COUNT(*) count FROM settlements").get() as { count: number }).count,
      receipts: (db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get() as { count: number }).count,
    }).toEqual(before);
    expect(providers.resourceProviderCalls).toBe(resourceProviderCalls);
  });

  it("never executes a paid Resource pack as a free public preview", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    await providers.flow!.saveWallet({
      ownerId: providers.owner,
      address: "0x2222222222222222222222222222222222222222",
    });
    const product = await approved("paid", "public", "paid-preview");
    const response = await publish(request(`/api/v2/resources/${product.id}/publish`, {
      idempotencyKey: "publish-paid-preview",
      priceUsdc: 0.05,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    }), { params: Promise.resolve({ resourceId: product.id }) });
    const published = (await response.json() as {
      published: { agent: { id: string; slug: string } };
    }).published;
    const context = { params: Promise.resolve({ agent: published.agent.slug }) };
    const counts = () => ({
      runs: (db.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count,
      receipts: (db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get() as { count: number }).count,
    });
    const before = counts();

    const disabledSettlement = (await buildCatalog()).find((entry) => entry.id === published.agent.id);
    expect(disabledSettlement).toMatchObject({
      paymentState: "unavailable",
      acceptsPayment: false,
      previewAvailable: false,
    });
    for (const suffix of ["", "?dryRun=1"]) {
      const preview = await runPublished(new Request(
        `https://agents.suedeai.ai/api/agents/${published.agent.slug}/run${suffix}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": "192.0.2.20" },
          body: JSON.stringify({ input: { tier: "paid" } }),
        },
      ), context);
      expect(preview.status).toBe(403);
      await expect(preview.json()).resolves.toEqual({
        error: "resource_public_preview_forbidden",
        message: "Paid Resources do not expose public previews.",
      });
    }
    expect(counts()).toEqual(before);

    await providers.flow!.updateAgent(published.agent.id, { settlementLive: true });
    const paymentEnabled = (await buildCatalog()).find((entry) => entry.id === published.agent.id);
    expect(paymentEnabled).toMatchObject({
      paymentState: "payment-enabled",
      acceptsPayment: true,
      previewAvailable: false,
    });
    const explicitPreview = await runPublished(new Request(
      `https://agents.suedeai.ai/api/agents/${published.agent.slug}/run?dryRun=1`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "192.0.2.20" },
        body: JSON.stringify({ input: { tier: "paid" } }),
      },
    ), context);
    expect(explicitPreview.status).toBe(403);
    expect(counts()).toEqual(before);
  });

  it("returns only the immutable synthetic example for public Resource dry-runs without private reads or writes", async () => {
    const publishVariant = async (
      executionAccess: "free" | "paid" | "private",
      suffix: string,
      priceUsdc: number,
      recordName = "Alpha",
    ) => {
      const product = await approved(executionAccess, "public", suffix, recordName);
      if (executionAccess === "paid") {
        await providers.flow!.saveWallet({
          ownerId: providers.owner,
          address: "0x2222222222222222222222222222222222222222",
        });
      }
      const response = await publish(request(`/api/v2/resources/${product.id}/publish`, {
        idempotencyKey: `publish-preview-${suffix}`,
        priceUsdc,
        representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
      }), { params: Promise.resolve({ resourceId: product.id }) });
      expect(response.status).toBe(200);
      return {
        product,
        published: (await response.json() as {
          published: {
            agent: { id: string; slug: string };
            release: { packVersionId: string; semanticHash: string };
          };
        }).published,
      };
    };

    const free = await publishVariant("free", "synthetic-free", 0, "PRIVATE_PACK_CANARY");
    const paid = await publishVariant("paid", "synthetic-paid", 0.05);
    const privateResource = await publishVariant("private", "synthetic-private", 0);
    const repository = providers.resource!;
    const getOwnedPack = vi.spyOn(repository, "getOwnedPack");
    const recordRunReceipt = vi.spyOn(repository, "recordRunReceipt");
    const before = {
      providerCalls: providers.resourceProviderCalls,
      executionCalls: providers.resourceExecutionCalls,
      envelopeWrites: providers.resourceEnvelopeWrites,
      runs: (db.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count,
      settlements: (db.prepare("SELECT COUNT(*) count FROM settlements").get() as { count: number }).count,
      receipts: (db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get() as { count: number }).count,
    };
    const dryRun = (slug: string) => runPublished(new Request(
      `https://agents.suedeai.ai/api/agents/${slug}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "192.0.2.25" },
        body: JSON.stringify({ input: { tier: "paid" }, dryRun: true }),
      },
    ), { params: Promise.resolve({ agent: slug }) });

    const freeResponse = await dryRun(free.published.agent.slug);
    expect(freeResponse.status).toBe(200);
    const freeEnvelope = await freeResponse.json();
    expect(freeEnvelope).toEqual({
      result: [{ name: "Example", tier: "paid" }],
      resourceReceipt: {
        resourceProductId: free.product.id,
        resourceVersion: free.published.release.packVersionId,
        semanticHash: free.published.release.semanticHash,
        freshness: "fresh",
        evidence: [],
        unknowns: [],
        conflicts: [],
        outputSchemaValid: true,
      },
      payment: { priceUsdc: 0, state: "free", receiptId: null },
    });
    expect(JSON.stringify(freeEnvelope)).not.toContain("PRIVATE_PACK_CANARY");

    const paidResponse = await dryRun(paid.published.agent.slug);
    expect(paidResponse.status).toBe(403);
    await expect(paidResponse.json()).resolves.toMatchObject({ error: "resource_public_preview_forbidden" });
    const privateResponse = await dryRun(privateResource.published.agent.slug);
    expect(privateResponse.status).toBe(404);
    await expect(privateResponse.json()).resolves.toEqual({ error: "agent not found" });

    expect(providers.verifyAndSettle).not.toHaveBeenCalled();
    expect(getOwnedPack).not.toHaveBeenCalled();
    expect(recordRunReceipt).not.toHaveBeenCalled();
    expect({
      providerCalls: providers.resourceProviderCalls,
      executionCalls: providers.resourceExecutionCalls,
      envelopeWrites: providers.resourceEnvelopeWrites,
      runs: (db.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count,
      settlements: (db.prepare("SELECT COUNT(*) count FROM settlements").get() as { count: number }).count,
      receipts: (db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get() as { count: number }).count,
    }).toEqual({ ...before, providerCalls: before.providerCalls + 1 });
  });

  it("refuses a stale free Resource public dry-run without private reads, execution, payment, or writes", async () => {
    const product = await approved("free", "public", "stale-free-preview", "PRIVATE_STALE_CANARY");
    const response = await publish(request(`/api/v2/resources/${product.id}/publish`, {
      idempotencyKey: "publish-stale-free-preview",
      priceUsdc: 0,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    }), { params: Promise.resolve({ resourceId: product.id }) });
    expect(response.status).toBe(200);
    const published = (await response.json() as {
      published: { agent: { slug: string } };
    }).published;
    const repository = providers.resource!;
    const getOwnedPack = vi.spyOn(repository, "getOwnedPack");
    const recordRunReceipt = vi.spyOn(repository, "recordRunReceipt");
    const before = {
      executionCalls: providers.resourceExecutionCalls,
      envelopeWrites: providers.resourceEnvelopeWrites,
      runs: (db.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count,
      settlements: (db.prepare("SELECT COUNT(*) count FROM settlements").get() as { count: number }).count,
      receipts: (db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get() as { count: number }).count,
    };

    providers.now = new Date("2026-08-20T12:00:00.001Z");
    const preview = await runPublished(new Request(
      `https://agents.suedeai.ai/api/agents/${published.agent.slug}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "192.0.2.26" },
        body: JSON.stringify({ input: { tier: "paid" }, dryRun: true }),
      },
    ), { params: Promise.resolve({ agent: published.agent.slug }) });

    expect(preview.status).toBe(503);
    await expect(preview.json()).resolves.toEqual({ error: "published run unavailable" });
    expect(providers.verifyAndSettle).not.toHaveBeenCalled();
    expect(getOwnedPack).not.toHaveBeenCalled();
    expect(recordRunReceipt).not.toHaveBeenCalled();
    expect({
      executionCalls: providers.resourceExecutionCalls,
      envelopeWrites: providers.resourceEnvelopeWrites,
      runs: (db.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count,
      settlements: (db.prepare("SELECT COUNT(*) count FROM settlements").get() as { count: number }).count,
      receipts: (db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get() as { count: number }).count,
    }).toEqual(before);
  });

  it("removes a Resource from discovery and refuses it before payment when its exact pack becomes stale", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    await providers.flow!.saveWallet({
      ownerId: providers.owner,
      address: "0x2222222222222222222222222222222222222222",
    });
    const product = await approved("paid", "public", "stale-after-publish");
    const response = await publish(request(`/api/v2/resources/${product.id}/publish`, {
      idempotencyKey: "publish-stale-after-publish",
      priceUsdc: 0.05,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    }), { params: Promise.resolve({ resourceId: product.id }) });
    const published = (await response.json() as {
      published: { agent: { id: string; slug: string } };
    }).published;
    await providers.flow!.updateAgent(published.agent.id, { settlementLive: true });
    const liveEntry = (await buildCatalog()).find((entry) => entry.id === published.agent.id);
    expect(liveEntry?.extensions?.[RESOURCE_CONTRACT_EXTENSION_URI]).toMatchObject({ freshness: "fresh" });

    const before = {
      runs: (db.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count,
      settlements: (db.prepare("SELECT COUNT(*) count FROM settlements").get() as { count: number }).count,
      receipts: (db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get() as { count: number }).count,
    };
    providers.now = new Date("2026-08-20T12:00:00.001Z");

    expect((await buildCatalog()).some((entry) => entry.id === published.agent.id)).toBe(false);
    expect(JSON.stringify(await (await getOpenApi()).json())).not.toContain(product.id);
    const context = { params: Promise.resolve({ agent: published.agent.slug }) };
    for (const route of [getAgentCard, getX402, getA2A]) {
      expect((await route(
        new Request(`https://agents.suedeai.ai/api/agents/${published.agent.slug}`),
        context,
      )).status).toBe(404);
    }
    const mcp = await handleMcpHttpRequest({
      httpMethod: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PREVIOUS_PROTOCOL_VERSION,
      }),
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      deps: await createMcpDeps(),
    });
    expect(JSON.stringify(mcp.body)).not.toContain(product.id);

    const refused = await runPublished(new Request(
      `https://agents.suedeai.ai/api/agents/${published.agent.slug}/run`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "payment-signature": "invalid-but-present",
          "x-real-ip": "192.0.2.30",
        },
        body: JSON.stringify({ input: { tier: "paid" } }),
      },
    ), context);
    expect(refused.status).toBe(404);
    await expect(refused.json()).resolves.toEqual({ error: "agent not found" });
    expect({
      runs: (db.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count,
      settlements: (db.prepare("SELECT COUNT(*) count FROM settlements").get() as { count: number }).count,
      receipts: (db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get() as { count: number }).count,
    }).toEqual(before);
  });

  it("rechecks freshness after contract preflight and refuses a clock transition before settlement", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    await providers.flow!.saveWallet({
      ownerId: providers.owner,
      address: "0x2222222222222222222222222222222222222222",
    });
    const product = await approved("paid", "public", "stale-between-preflight-and-payment");
    const response = await publish(request(`/api/v2/resources/${product.id}/publish`, {
      idempotencyKey: "publish-stale-between-preflight-and-payment",
      priceUsdc: 0.05,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    }), { params: Promise.resolve({ resourceId: product.id }) });
    const published = (await response.json() as {
      published: { agent: { id: string; slug: string } };
    }).published;
    await providers.flow!.updateAgent(published.agent.id, { settlementLive: true });

    const before = {
      runs: (db.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count,
      settlements: (db.prepare("SELECT COUNT(*) count FROM settlements").get() as { count: number }).count,
      receipts: (db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get() as { count: number }).count,
    };
    const resource = providers.resource!;
    const getOwnedPack = resource.getOwnedPack.bind(resource);
    let exactPackReads = 0;
    vi.spyOn(resource, "getOwnedPack").mockImplementation(async (reference) => {
      const pack = await getOwnedPack(reference);
      exactPackReads += 1;
      if (exactPackReads === 1) {
        providers.now = new Date("2026-08-20T12:00:00.001Z");
      }
      return pack;
    });

    const refused = await runPublished(new Request(
      `https://agents.suedeai.ai/api/agents/${published.agent.slug}/run`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "payment-signature": "settle-if-reached",
          "x-real-ip": "192.0.2.40",
        },
        body: JSON.stringify({ input: { tier: "paid" } }),
      },
    ), { params: Promise.resolve({ agent: published.agent.slug }) });

    expect(exactPackReads).toBe(2);
    expect(refused.status).toBe(503);
    await expect(refused.json()).resolves.toEqual({ error: "published run unavailable" });
    expect(providers.verifyAndSettle).not.toHaveBeenCalled();
    expect({
      runs: (db.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count,
      settlements: (db.prepare("SELECT COUNT(*) count FROM settlements").get() as { count: number }).count,
      receipts: (db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get() as { count: number }).count,
    }).toEqual(before);
  });

  it("projects published free/paid/private/unlisted access into the public catalog and run route", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    await providers.flow!.saveWallet({
      ownerId: providers.owner, address: "0x2222222222222222222222222222222222222222",
    });
    const variants = [
      { executionAccess: "free", discoveryAccess: "public", priceUsdc: 0, suffix: "free" },
      { executionAccess: "paid", discoveryAccess: "public", priceUsdc: 0.05, suffix: "paid" },
      { executionAccess: "private", discoveryAccess: "public", priceUsdc: 0, suffix: "private" },
      { executionAccess: "paid", discoveryAccess: "unlisted", priceUsdc: 0.05, suffix: "unlisted" },
    ] as const;
    const published: Array<{
      agent: { id: string; slug: string };
      release: { packVersionId: string; semanticHash: string };
      urls: Record<string, string>;
    }> = [];
    for (const variant of variants) {
      const product = await approved(variant.executionAccess, variant.discoveryAccess, variant.suffix);
      const path = `/api/v2/resources/${product.id}/publish`;
      const response = await publish(request(path, {
        idempotencyKey: `publish-${variant.suffix}`,
        priceUsdc: variant.priceUsdc,
        representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
      }), { params: Promise.resolve({ resourceId: product.id }) });
      expect(response.status).toBe(200);
      published.push((await response.json() as { published: typeof published[number] }).published);
    }
    await providers.flow!.updateAgent(published[1]!.agent.id, { settlementLive: true });

    const catalog = await buildCatalog();
    expect(catalog.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      published[0]!.agent.id, published[1]!.agent.id,
    ]));
    expect(catalog.map((entry) => entry.id)).not.toContain(published[2]!.agent.id);
    expect(catalog.map((entry) => entry.id)).not.toContain(published[3]!.agent.id);

    const paid = published[1]!;
    const paidEntry = catalog.find((entry) => entry.id === paid.agent.id)!;
    const exactContract = paidEntry.extensions?.[RESOURCE_CONTRACT_EXTENSION_URI];
    expect(exactContract).toMatchObject({
      resourceVersion: paid.release.packVersionId,
      semanticHash: paid.release.semanticHash,
    });
    expect(paid.urls).toEqual({
      run: `/api/agents/${paid.agent.slug}/run`,
      card: `/api/agents/${paid.agent.slug}/.well-known/agent-card.json`,
      x402: `/api/agents/${paid.agent.slug}/.well-known/x402`,
      a2a: `/api/agents/${paid.agent.slug}/a2a`,
      public: `/a/${paid.agent.slug}`,
    });
    const routeContext = { params: Promise.resolve({ agent: paid.agent.slug }) };
    const [cardResponse, x402Response, a2aResponse] = await Promise.all([
      getAgentCard(new Request(`https://agents.suedeai.ai${paid.urls.card}`), routeContext),
      getX402(new Request(`https://agents.suedeai.ai${paid.urls.x402}`), routeContext),
      getA2A(new Request(`https://agents.suedeai.ai${paid.urls.a2a}`), routeContext),
    ]);
    expect([cardResponse.status, x402Response.status, a2aResponse.status]).toEqual([200, 200, 200]);
    const [card, x402, a2a] = await Promise.all([
      cardResponse.json() as Promise<{ "x-suede": { outputSchema: unknown; extensions: Record<string, unknown> } }>,
      x402Response.json() as Promise<{ outputSchema: unknown; extensions: Record<string, unknown> }>,
      a2aResponse.json() as Promise<{ "x-suede": { outputSchema: unknown; extensions: Record<string, unknown> } }>,
    ]);
    expect(card["x-suede"].extensions[RESOURCE_CONTRACT_EXTENSION_URI]).toEqual(exactContract);
    expect(x402.extensions[RESOURCE_CONTRACT_EXTENSION_URI]).toEqual(exactContract);
    expect(a2a["x-suede"].extensions[RESOURCE_CONTRACT_EXTENSION_URI]).toEqual(exactContract);
    const resourceTool = catalogEntryToTool(paidEntry);
    expect(resourceTool._meta?.[RESOURCE_CONTRACT_EXTENSION_URI]).toEqual(exactContract);
    const rootDiscovery = await buildX402DiscoveryIndex();
    const rootEndpoint = rootDiscovery.endpoints.find((entry) => entry.resource.endsWith(`/api/agents/${paid.agent.slug}/run`));
    expect(rootEndpoint).toBeDefined();

    const free = published[0]!;
    const representativeResponse = await runPublished(new Request(
      `https://agents.suedeai.ai/api/agents/${free.agent.slug}/run?dryRun=1`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { tier: "paid" } }) },
    ), { params: Promise.resolve({ agent: free.agent.slug }) });
    expect(representativeResponse.status).toBe(200);
    const normalEnvelope = await representativeResponse.json();
    const ap2Envelope = {
      ...normalEnvelope,
      ap2: {
        profile: "ap2-v0.2-experimental",
        authorizationMode: "direct",
        checkoutReceipt: "signed-checkout-receipt",
      },
    };
    for (const advertisedSchema of [
      card["x-suede"].outputSchema,
      x402.outputSchema,
      a2a["x-suede"].outputSchema,
      rootEndpoint!.outputSchema,
      resourceTool.outputSchema,
    ]) {
      expect(resourceRunEnvelopeAccepts(advertisedSchema, normalEnvelope)).toBe(true);
      expect(resourceRunEnvelopeAccepts(advertisedSchema, ap2Envelope)).toBe(true);
    }
    const challengeResponse = await runPublished(new Request(
      `https://agents.suedeai.ai/api/agents/${paid.agent.slug}/run`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { tier: "paid" } }) },
    ), routeContext);
    expect(challengeResponse.status).toBe(402);
    const challenge = await challengeResponse.json() as { extensions: Record<string, unknown> };
    type Bazaar = {
      info: { output: { example: unknown } };
      schema: { properties: { output: { properties: { example: unknown } } } };
    };
    for (const extension of [x402.extensions, rootEndpoint!.extensions!, challenge.extensions]) {
      const bazaar = extension.bazaar as Bazaar;
      const responseSchema = bazaar.schema.properties.output.properties.example;
      expect(resourceRunEnvelopeAccepts(responseSchema, normalEnvelope)).toBe(true);
      expect(resourceRunEnvelopeAccepts(responseSchema, ap2Envelope)).toBe(true);
      expect(resourceRunEnvelopeAccepts(x402.outputSchema, bazaar.info.output.example)).toBe(true);
    }

    const privateResponse = await runPublished(new Request(
      `https://agents.suedeai.ai/api/agents/${published[2]!.agent.id}/run`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { tier: "paid" } }) },
    ), { params: Promise.resolve({ agent: published[2]!.agent.id }) });
    expect(privateResponse.status).toBe(404);

    for (const callable of [published[0]!]) {
      const response = await runPublished(new Request(
        `https://agents.suedeai.ai/api/agents/${callable.agent.slug}/run?dryRun=1`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { tier: "paid" } }) },
      ), { params: Promise.resolve({ agent: callable.agent.slug }) });
      expect(response.status).toBe(200);
      const envelope = await response.json();
      const entry = catalog.find((candidate) => candidate.id === callable.agent.id);
      if (entry) {
        expect(resourceRunEnvelopeAccepts(catalogEntryToTool(entry).outputSchema, envelope)).toBe(true);
      }
    }
    for (const paidPreview of [published[1]!, published[3]!]) {
      const response = await runPublished(new Request(
        `https://agents.suedeai.ai/api/agents/${paidPreview.agent.slug}/run?dryRun=1`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { tier: "paid" } }) },
      ), { params: Promise.resolve({ agent: paidPreview.agent.slug }) });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: "resource_public_preview_forbidden" });
    }
  });
});
