import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResourceSourcesPanel from "@/components/resources/ResourceSourcesPanel";
import {
  parseResourceRefreshRejection,
  parseResourceRefreshResponse,
} from "@/components/resources/client";
import { buildCatalog } from "@/lib/catalog";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { A2A_PROTOCOL_VERSION, handleA2ASendMessage } from "@/lib/discovery/a2a-http-json";
import { MCP_PREVIOUS_PROTOCOL_VERSION } from "@/lib/mcp/protocol";
import { handleMcpHttpRequest } from "@/lib/mcp/server";
import { createMcpDeps } from "@/lib/mcp/service";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import { RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";
import { aggregateResourceTrust } from "@/lib/resources/analytics";
import { ResourcePublishService } from "@/lib/resources/publish-service";
import type { ResourceRunReceipt } from "@/lib/resources/repository";
import { resourceRunEnvelopeAccepts } from "@/lib/resources/run-receipt";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { RESOURCE_TEST_NOW as NOW, resourcePack } from "./resources/fixture";

const PRIVATE_SOURCE_MARKER = "PRIVATE-SOURCE-SECRET-MARKER";

const providers = vi.hoisted(() => ({
  owner: "video-owner",
  flow: null as SqliteRepo | null,
  project: null as SqliteProjectRepo | null,
  resource: null as SqliteResourceRepository | null,
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
  getResourceRepository: async () => providers.resource!,
  ResourceStoreUnavailableError: class ResourceStoreUnavailableError extends Error {},
}));
vi.mock("@/lib/resources/flags", () => ({ RESOURCE_FOUNDRY_ENABLED: true }));

const { POST: runPublished } = await import("@/app/api/agents/[agent]/run/route");
const { GET: agentCard } = await import("@/app/api/agents/[agent]/.well-known/agent-card/route");
const { GET: agentX402 } = await import("@/app/api/agents/[agent]/.well-known/x402/route");
const { GET: agentA2A } = await import("@/app/api/agents/[agent]/a2a/route");
const { GET: agentTemplate } = await import("@/app/api/agents/[agent]/template/route");
const agentPage = await import("@/app/a/[slug]/page");
const agentOg = await import("@/app/a/[slug]/opengraph-image");
const { GET: openApi } = await import("@/app/openapi.json/route");
const refreshRoute = await import("@/app/api/v2/resources/[resourceId]/refresh/route");

describe("Resource Foundry video-principle executable acceptance", () => {
  let database: Database.Database;

  beforeEach(() => {
    database = new Database(":memory:");
    runSqliteMigrations(database);
    providers.owner = `video-owner-${Date.now()}-${Math.random()}`;
    providers.flow = new SqliteRepo(database);
    providers.project = new SqliteProjectRepo(database);
    providers.resource = new SqliteResourceRepository(database, { now: () => NOW });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    database.close();
  });

  async function publishResource(
    executionAccess: "free" | "paid" | "private",
    discoveryAccess: "public" | "unlisted" = "public",
    privateLocator = "manual://pricing",
  ) {
    const product = await providers.resource!.createProduct({
      ownerId: providers.owner,
      name: `Reviewed pricing ${executionAccess}`,
      slug: `reviewed-pricing-${executionAccess}-${Math.random().toString(16).slice(2)}`,
      executionAccess,
      discoveryAccess,
    });
    const snapshotId = `snapshot-${product.id}`;
    await providers.resource!.createSourceSnapshot({
      id: snapshotId, ownerId: providers.owner, resourceProductId: product.id,
      locator: privateLocator, sourceKind: "manual_text", capturedAt: NOW.toISOString(),
      contentHash: "a".repeat(64), freshnessDeadline: "2026-08-20T12:00:00.000Z",
    });
    const base = resourcePack();
    const candidate = await providers.resource!.replaceCandidate({
      ownerId: providers.owner, resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: {
        ...base,
        sourceSnapshotIds: [snapshotId],
        evidence: base.evidence.map((item) => ({ ...item, sourceSnapshotId: snapshotId })),
      },
      createdBy: providers.owner,
    });
    const approved = await providers.resource!.approveCandidate({
      ownerId: providers.owner, resourceProductId: product.id,
      candidatePackVersionId: candidate.id, expectedRevision: candidate.revision,
      expectedSemanticHash: candidate.semanticHash, approvedBy: providers.owner,
    });
    if (executionAccess === "paid") {
      await providers.flow!.saveWallet({
        ownerId: providers.owner, address: "0x2222222222222222222222222222222222222222",
      });
    }
    const published = await new ResourcePublishService({
      resourceRepo: providers.resource!, flowRepo: providers.flow!, projectRepo: providers.project!,
    }).publish(providers.owner, product.id, {
      idempotencyKey: `video-${executionAccess}-${product.id}`,
      priceUsdc: executionAccess === "paid" ? 0.05 : 0,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    });
    return { product, approved, published, snapshotId };
  }

  it("publishes immutable free, paid, and private resource doors across HTTP, MCP, A2A, OpenAPI, and x402", async () => {
    const free = await publishResource("free", "public", `manual://${PRIVATE_SOURCE_MARKER}`);
    const paid = await publishResource("paid");
    const privateResource = await publishResource("private");
    const catalog = await buildCatalog();
    const freeEntry = catalog.find((entry) => entry.id === free.published.agent.id)!;
    const paidEntry = catalog.find((entry) => entry.id === paid.published.agent.id)!;
    expect(freeEntry).toBeTruthy();
    expect(paidEntry).toBeTruthy();
    expect(catalog.some((entry) => entry.id === privateResource.published.agent.id)).toBe(false);
    expect(JSON.stringify(catalog)).not.toContain(PRIVATE_SOURCE_MARKER);
    const privateContext = {
      params: Promise.resolve({ agent: privateResource.published.agent.slug }),
    };
    const privateRequest = new Request(
      `https://agents.suedeai.ai/api/agents/${privateResource.published.agent.slug}`,
    );
    for (const route of [agentCard, agentX402, agentA2A, agentTemplate]) {
      const response = await route(privateRequest, privateContext);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "agent not found" });
    }
    const privatePageParams = Promise.resolve({ slug: privateResource.published.agent.slug });
    expect(await agentPage.generateMetadata({ params: privatePageParams })).toMatchObject({
      robots: { index: false, follow: true },
    });
    await expect(agentPage.default({
      params: Promise.resolve({ slug: privateResource.published.agent.slug }),
    })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    await expect(agentOg.default({
      params: Promise.resolve({ slug: privateResource.published.agent.slug }),
    })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    const privateRun = await runPublished(new Request(
      `https://agents.suedeai.ai${privateResource.published.urls.run}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { tier: "paid" } }),
      },
    ), privateContext);
    expect(privateRun.status).toBe(404);
    await expect(privateRun.json()).resolves.toEqual({ error: "agent not found" });
    for (const [entry, published, access] of [
      [freeEntry, free.published, "free"],
      [paidEntry, paid.published, "paid"],
    ] as const) {
      expect(entry.extensions).toBeTruthy();
      expect(entry.extensions).toEqual(expect.objectContaining({
        [RESOURCE_CONTRACT_EXTENSION_URI]: expect.objectContaining({
          resourceVersion: published.release.packVersionId,
          semanticHash: published.release.semanticHash,
          access: { execution: access, discovery: "public" },
        }),
      }));
    }
    expect(free.published.release.packVersionId).toBe(free.approved.id);
    expect(paid.published.release.packVersionId).toBe(paid.approved.id);
    const graph = await providers.flow!.getFlow(free.product.id);
    expect(graph?.graph.nodes.map((node) => node.type)).toEqual(["input", "resource.query", "output"]);
    expect(graph?.graph.nodes.some((node) => ["llm", "vector.search", "chat"].includes(node.type))).toBe(false);

    const mcpDeps = await createMcpDeps();
    const initialized = await handleMcpHttpRequest({
      httpMethod: "POST", headers: new Headers({ "content-type": "application/json" }),
      body: {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: MCP_PREVIOUS_PROTOCOL_VERSION, capabilities: {},
          clientInfo: { name: "Resource video acceptance", version: "1.0.0" },
        },
      },
      deps: mcpDeps,
    });
    expect(initialized).toMatchObject({
      status: 200,
      body: { result: { protocolVersion: MCP_PREVIOUS_PROTOCOL_VERSION, capabilities: { tools: {} } } },
    });
    const listed = await handleMcpHttpRequest({
      httpMethod: "POST",
      headers: new Headers({ "content-type": "application/json", "mcp-protocol-version": MCP_PREVIOUS_PROTOCOL_VERSION }),
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      deps: mcpDeps,
    });
    expect(listed.status).toBe(200);
    const tools = Reflect.get(Reflect.get(listed.body!, "result"), "tools") as Array<{
      name: string; outputSchema: Record<string, unknown>; _meta?: Record<string, unknown>;
    }>;
    expect(tools.some((tool) =>
      Reflect.get(
        tool._meta?.[RESOURCE_CONTRACT_EXTENSION_URI] ?? {},
        "resourceProductId",
      ) === privateResource.product.id,
    )).toBe(false);
    const freeTool = tools.find((tool) =>
      Reflect.get(tool._meta?.[RESOURCE_CONTRACT_EXTENSION_URI] ?? {}, "resourceProductId") === free.product.id,
    );
    expect(freeTool).toBeTruthy();
    const extension = freeTool!._meta![RESOURCE_CONTRACT_EXTENSION_URI] as {
      jobContract: ReturnType<typeof resourcePack>["jobContract"] & {
        resourceProductId: string; packVersionId: string; semanticHash: string;
      };
      sourceDisclosure: { sourceCount: number; sourceKinds: string[] };
    };
    expect(extension.jobContract).toEqual({
      ...resourcePack().jobContract,
      resourceProductId: free.product.id,
      packVersionId: free.approved.id,
      semanticHash: free.approved.semanticHash,
    });
    expect(extension.jobContract.jobStatement).toBe("Return an exact pricing record.");
    expect(extension.sourceDisclosure).toEqual({ sourceCount: 1, sourceKinds: ["manual_text"] });
    expect(free.approved.content.taxonomy).toEqual([{ id: "pricing", label: "Pricing" }]);

    const freeDiscoveryContext = {
      params: Promise.resolve({ agent: free.published.agent.slug }),
    };
    const freeDiscoveryRequest = new Request(
      `https://agents.suedeai.ai/api/agents/${free.published.agent.slug}`,
    );
    for (const route of [agentCard, agentX402, agentA2A, agentTemplate]) {
      const response = await route(freeDiscoveryRequest, freeDiscoveryContext);
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).not.toContain(PRIVATE_SOURCE_MARKER);
    }
    expect(JSON.stringify(await agentPage.generateMetadata({
      params: Promise.resolve({ slug: free.published.agent.slug }),
    }))).not.toContain(PRIVATE_SOURCE_MARKER);

    const freeContext = { params: Promise.resolve({ agent: free.published.agent.slug }) };
    const http = await runPublished(new Request(
      `https://agents.suedeai.ai${free.published.urls.run}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { tier: "paid" } }) },
    ), freeContext);
    expect(http.status).toBe(200);
    const envelope = await http.json();
    expect(JSON.stringify(envelope)).not.toContain(PRIVATE_SOURCE_MARKER);
    expect(resourceRunEnvelopeAccepts(freeTool!.outputSchema, envelope)).toBe(true);

    const called = await handleMcpHttpRequest({
      httpMethod: "POST",
      headers: new Headers({ "content-type": "application/json", "mcp-protocol-version": MCP_PREVIOUS_PROTOCOL_VERSION }),
      body: {
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: freeTool!.name, arguments: { tier: "paid" } },
      },
      deps: mcpDeps,
    });
    expect(called.status).toBe(200);
    const mcpResult = Reflect.get(Reflect.get(called.body!, "result"), "structuredContent");
    expect(JSON.stringify(mcpResult)).not.toContain(PRIVATE_SOURCE_MARKER);
    expect(resourceRunEnvelopeAccepts(freeTool!.outputSchema, mcpResult)).toBe(true);
    expect(Reflect.get(mcpResult, "resourceReceipt")).toEqual(Reflect.get(envelope, "resourceReceipt"));
    expect(Reflect.get(Reflect.get(mcpResult, "resourceReceipt"), "evidence")).toEqual(free.approved.content.evidence);

    const a2a = await handleA2ASendMessage(new Request(
      `https://agents.suedeai.ai/api/agents/${free.published.agent.slug}/a2a/message:send`,
      {
        method: "POST",
        headers: { "content-type": "application/a2a+json", "A2A-Version": A2A_PROTOCOL_VERSION },
        body: JSON.stringify({ message: {
          messageId: "video-message", contextId: "video-context", role: "ROLE_USER",
          parts: [{ data: { tier: "paid" }, mediaType: "application/json" }],
        } }),
      },
    ), freeContext, (request) => runPublished(request, freeContext));
    expect(a2a.status).toBe(200);
    const a2aBody = await a2a.json() as { message: { parts: Array<{ data: unknown }> } };
    const a2aEnvelope = a2aBody.message.parts[0]?.data;
    expect(JSON.stringify(a2aEnvelope)).not.toContain(PRIVATE_SOURCE_MARKER);
    expect(resourceRunEnvelopeAccepts(freeTool!.outputSchema, a2aEnvelope)).toBe(true);
    if (typeof a2aEnvelope !== "object" || a2aEnvelope === null) {
      throw new Error("expected Resource A2A envelope");
    }
    expect(Reflect.get(a2aEnvelope, "resourceReceipt")).toEqual(Reflect.get(envelope, "resourceReceipt"));
    expect(a2aEnvelope).toMatchObject({
      result: (envelope as { result: unknown }).result,
      resourceReceipt: {
        resourceVersion: free.published.release.packVersionId,
        semanticHash: free.published.release.semanticHash,
        freshness: "fresh",
        outputSchemaValid: true,
      },
      payment: { state: "free", priceUsdc: 0 },
    });

    const paidContext = { params: Promise.resolve({ agent: paid.published.agent.slug }) };
    await providers.flow!.updateAgent(paid.published.agent.id, { settlementLive: true });
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    const challenge = await runPublished(new Request(
      `https://agents.suedeai.ai${paid.published.urls.run}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { tier: "paid" } }) },
    ), paidContext);
    expect(challenge.status).toBe(402);
    const challengeBody = await challenge.json();
    const encoded = challenge.headers.get("payment-required");
    expect(encoded).toBeTruthy();
    expect(JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"))).toEqual(challengeBody);
    expect(challengeBody).toMatchObject({ x402Version: 2, error: "payment required", accepts: [{ amount: "50000" }] });

    const openApiResponse = await openApi();
    const document = await openApiResponse.json() as { paths: Record<string, unknown> };
    expect(JSON.stringify(document)).not.toContain(privateResource.product.id);
    expect(JSON.stringify(document)).not.toContain(PRIVATE_SOURCE_MARKER);
    for (const path of ["/api/mcp", "/api/agents/{agent}/run", "/api/agents/{agent}/a2a/message:send"]) {
      expect(document.paths).toHaveProperty(path);
    }
  });

  it("executes owner-scoped reviewed refresh and rejection through the private route and Sources UI", async () => {
    const seeded = await publishResource("free", "unlisted");
    const context = { params: Promise.resolve({ resourceId: seeded.product.id }) };
    const recollect = await refreshRoute.POST(new Request(
      `https://agents.suedeai.ai/api/v2/resources/${seeded.product.id}/refresh`,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "recollect",
          base: { packVersionId: seeded.approved.id, semanticHash: seeded.approved.semanticHash },
          candidate: null,
          replaceSourceSnapshotIds: [seeded.snapshotId],
          source: {
            kind: "json_rows", locator: "manual://pricing", freshnessDays: 30,
            rows: [{ name: "Alpha refreshed", tier: "paid" }],
          },
        }),
      },
    ), context);
    expect(recollect.status).toBe(201);
    expect(recollect.headers.get("cache-control")).toBe("private, no-store");
    const result = parseResourceRefreshResponse(await recollect.json());
    expect(result.diff).toMatchObject({
      changedRecordIds: ["record-1"], schemaChanged: false, taxonomyChanged: false,
      evidenceChanged: true, freshness: { before: "fresh", candidate: "fresh" },
    });
    const markup = renderToStaticMarkup(createElement(ResourceSourcesPanel, {
      disabled: false, busy: false, onAdd: vi.fn(),
      refreshDisabled: false, refreshBusy: false, rejectBusy: false, canReject: true,
      sourceSnapshotIds: result.candidate!.content.sourceSnapshotIds,
      refreshResult: result, onRefresh: vi.fn(), onReject: vi.fn(),
    }));
    for (const text of ["Add a manual source first", "Recollect reviewed source", "Candidate refresh diff", "Reject this candidate"]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain("supplied by you and not verified by Suede");
    expect(markup).toContain("does not disable approval or publication");

    const rejected = await refreshRoute.POST(new Request(
      `https://agents.suedeai.ai/api/v2/resources/${seeded.product.id}/refresh`,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "reject",
          base: { packVersionId: seeded.approved.id, semanticHash: seeded.approved.semanticHash },
          candidate: {
            packVersionId: result.candidate!.id,
            revision: result.candidate!.revision,
            semanticHash: result.candidate!.semanticHash,
          },
        }),
      },
    ), context);
    expect(parseResourceRefreshRejection(await rejected.json())).toEqual({
      decision: "rejected", approved: false, republished: false,
    });
    const summary = await providers.resource!.getOwnedPortfolioItem(providers.owner, seeded.product.id);
    expect(summary?.livePackVersionId).toBe(seeded.approved.id);
    expect(summary?.approvedPackVersionId).toBeNull();
    expect(summary?.releaseCount).toBe(1);
  });

  it("reports receipt facts without converting challenges, refunds, credit, or zero samples into revenue", () => {
    const receipt = (paymentState: ResourceRunReceipt["paymentState"], index: number): ResourceRunReceipt => ({
      id: `receipt-${index}`, ownerId: "owner", resourceProductId: "resource",
      packVersionId: "pack", agentId: "agent", runId: `run-${index}`,
      flowVersionId: "flow-version", deploymentId: "deployment",
      paymentId: paymentState === "credited" || paymentState === "settled" ? `payment-${index}` : null,
      paymentState, priceUsdc: 0.08, resourceVersion: "pack", semanticHash: "a".repeat(64),
      freshness: index === 2 ? "stale" : "fresh",
      evidence: index === 1 ? [{ id: "evidence", sourceSnapshotId: "snapshot", locator: "row:1", observedAt: NOW.toISOString() }] : [],
      unknowns: index === 1 ? ["unknown"] : [], conflicts: index === 2 ? ["conflict"] : [],
      outputSchemaValid: index !== 2, createdAt: NOW.toISOString(),
    });
    const trust = aggregateResourceTrust([
      receipt("challenged", 0), receipt("credited", 1), receipt("settled", 2), receipt("refunded", 3),
    ]);
    expect(trust.facts).toMatchObject({
      challenged: { count: null, basis: "not_recorded" },
      executed: { count: 3 }, credited: { count: 1, amountUsdc: 0.08 },
      settled: { count: 1, amountUsdc: 0.08 },
      refunded: { count: null, amountUsdc: null, basis: "not_recorded" },
      failed: { count: null, basis: "not_recorded" },
    });
    expect(trust.rates).toMatchObject({
      schemaValidRate: 0.666667, evidenceCoverageRate: 0.333333,
      freshRate: 0.666667, staleRate: 0.333333, unknownRate: 0.333333, conflictRate: 0.333333,
    });
    expect(trust.economics).toEqual({
      price: { executionCount: 3, totalUsdc: 0.24, averageUsdc: 0.08, basis: "resource_run_receipts" },
      cost: { status: "not_recorded", amountUsdc: null },
      margin: { status: "not_recorded", amountUsdc: null },
    });
    expect(trust.revenue).toEqual({ status: "not_measured", amountUsdc: null });
  });
});
