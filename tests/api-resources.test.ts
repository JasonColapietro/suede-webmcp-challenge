import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import type { ResourceRepository } from "@/lib/resources/repository";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { SupabaseResourceRepository } from "@/lib/resources/supabase-repository";
import { resourcePack } from "./resources/fixture";

const control = vi.hoisted(() => ({
  ownerId: "anonymous-resource-owner",
  enabled: true,
  allowed: true,
  retryAfterSec: 0,
  writes: 0,
  reads: 0,
  rateKeys: [] as string[],
  blockedRateKey: null as string | null,
  repository: null as ResourceRepository | null,
  adopt: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    resolveOwnerId: async () => { control.writes += 1; return control.ownerId; },
    resolveReadOnlyOwnerId: async () => { control.reads += 1; return control.ownerId; },
    adoptAnonymousWorkspaceForVerifiedOwnerOrThrow: async () => control.adopt(),
  };
});
vi.mock("@/lib/resources/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/provider")>()),
  getResourceRepository: async () => {
    if (!control.repository) throw new Error("resource-repository-canary");
    return control.repository;
  },
}));
vi.mock("@/lib/resources/flags", () => ({
  get RESOURCE_FOUNDRY_ENABLED() { return control.enabled; },
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: (key: string) => {
    control.rateKeys.push(key);
    return {
      allowed: control.allowed && key !== control.blockedRateKey,
      retryAfterSec: control.retryAfterSec,
    };
  },
}));

const objectSchema = {
  type: "object",
  properties: { tier: { type: "string" } },
  required: [],
  additionalProperties: false,
} as const;
const resultSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { name: { type: "string" }, tier: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

function createBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Pricing signals",
    slug: "pricing-signals",
    executionAccess: "paid",
    discoveryAccess: "unlisted",
    brief: {
      jobStatement: "Return one reviewed pricing record.",
      buyerIntent: "Compare a named pricing tier.",
      inputSchema: objectSchema,
      outputSchema: resultSchema,
      safeExample: [{ name: "Example", tier: "paid" }],
      recordSchema: resultSchema.items,
      filterFields: ["tier"],
      returnFields: ["name", "tier"],
    },
    ...extra,
  };
}

function request(
  method: string,
  path: string,
  body?: unknown,
  contentType = "application/json",
  host = "agents.suedeai.ai",
): Request {
  return new Request(`https://${host}${path}`, {
    method,
    headers: {
      host,
      ...(body === undefined ? {} : { "content-type": contentType }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function context(resourceId: unknown) {
  return { params: Promise.resolve({ resourceId }) } as unknown as { params: Promise<{ resourceId: string }> };
}

async function expectPrivate(response: Response, status: number, body: object): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).toBe(JSON.stringify(body));
}

beforeEach(() => {
  control.ownerId = "anonymous-resource-owner";
  control.enabled = true;
  control.allowed = true;
  control.retryAfterSec = 0;
  control.writes = 0;
  control.reads = 0;
  control.rateKeys = [];
  control.blockedRateKey = null;
  control.repository = new SqliteResourceRepository(":memory:");
  control.adopt.mockReset().mockResolvedValue(undefined);
});

describe("private owner Resource Product APIs", () => {
  it("exports the collection and item handlers", async () => {
    const [collection, item, lifecycle, releases] = await Promise.all([
      import("@/app/api/v2/resources/route"),
      import("@/app/api/v2/resources/[resourceId]/route"),
      import("@/app/api/v2/resources/[resourceId]/lifecycle/route"),
      import("@/app/api/v2/resources/[resourceId]/releases/route"),
    ]);
    expect(collection).toMatchObject({ runtime: "nodejs", dynamic: "force-dynamic" });
    expect(item).toMatchObject({ runtime: "nodejs", dynamic: "force-dynamic" });
    expect(collection.GET).toBeTypeOf("function");
    expect(collection.POST).toBeTypeOf("function");
    expect(item.GET).toBeTypeOf("function");
    expect(item.PATCH).toBeTypeOf("function");
    expect(lifecycle.POST).toBeTypeOf("function");
    expect(releases.GET).toBeTypeOf("function");
  });

  it("returns only a bounded owner release history and keeps foreign/missing IDs opaque", async () => {
    const currentRelease = {
      id: "release-1", resourceProductId: "resource-1",
      packVersionId: "pack-1", semanticHash: "a".repeat(64),
      publicationKey: "publication-1", publicationRequestHash: "b".repeat(64),
      priceUsdc: 0.08, executionAccess: "paid" as const, discoveryAccess: "unlisted" as const,
      freshness: "fresh" as const, payoutReady: true, settlementState: "on" as const,
      agentId: "agent-1", agentStatus: "live" as const, flowVersionId: "version-1",
      deploymentId: "deployment-1", deploymentStatus: "live" as const,
      deploymentRetiredAt: null,
      createdAt: "2026-08-16T12:00:00.000Z",
      urls: { run: "/run", card: "/card", x402: "/x402", a2a: "/a2a", public: "/public" },
    };
    const history = [currentRelease, {
      ...currentRelease,
      id: "release-prior", agentStatus: "draft" as const,
      deploymentId: "deployment-prior", deploymentStatus: "retired" as const,
      deploymentRetiredAt: "2026-08-15T13:00:00.000Z",
      createdAt: "2026-08-15T12:00:00.000Z",
    }];
    const getOwnedPortfolioItem = vi.fn(async (ownerId: string, productId: string) =>
      ownerId === "anonymous-resource-owner" && productId === "resource-1"
        ? { id: productId }
        : null);
    const listOwnedReleaseHistory = vi.fn(async () => history);
    control.repository = {
      getOwnedPortfolioItem,
      listOwnedReleaseHistory,
    } as unknown as ResourceRepository;
    const releases = await import("@/app/api/v2/resources/[resourceId]/releases/route");

    await expectPrivate(
      await releases.GET(request("GET", "/api/v2/resources/resource-1/releases"), context("resource-1")),
      200,
      { releases: history },
    );
    expect(listOwnedReleaseHistory).toHaveBeenCalledWith(
      "anonymous-resource-owner", "resource-1", 20,
    );
    expect(JSON.stringify(history)).not.toMatch(/content|sourceSnapshotIds|source body/iu);

    control.ownerId = "foreign-resource-owner";
    const foreign = await releases.GET(
      request("GET", "/api/v2/resources/resource-1/releases"), context("resource-1"),
    );
    control.ownerId = "anonymous-resource-owner";
    const missing = await releases.GET(
      request("GET", "/api/v2/resources/missing/releases"), context("missing"),
    );
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
    expect(listOwnedReleaseHistory).toHaveBeenCalledTimes(1);
  });

  it("denies direct Play-host Resource mutations before owner or repository work", async () => {
    const collection = await import("@/app/api/v2/resources/route");
    const item = await import("@/app/api/v2/resources/[resourceId]/route");
    const lifecycle = await import("@/app/api/v2/resources/[resourceId]/lifecycle/route");

    await expectPrivate(
      await collection.POST(
        request("POST", "/api/v2/resources", createBody(), "application/json", "android-agents.suedeai.ai"),
      ),
      403,
      { error: "This endpoint is unavailable in this Google Play build." },
    );
    await expectPrivate(
      await item.PATCH(
        request(
          "PATCH",
          "/api/v2/resources/resource-1",
          { name: "Blocked" },
          "application/json",
          "android-agents.suedeai.ai",
        ),
        context("resource-1"),
      ),
      403,
      { error: "This endpoint is unavailable in this Google Play build." },
    );
    await expectPrivate(
      await lifecycle.POST(
        request(
          "POST",
          "/api/v2/resources/resource-1/lifecycle",
          {
            action: "pause", expectedStatus: "live", releaseId: "release-1",
            agentId: "agent-1", deploymentId: "deployment-1",
          },
          "application/json",
          "android-agents.suedeai.ai",
        ),
        context("resource-1"),
      ),
      403,
      { error: "This endpoint is unavailable in this Google Play build." },
    );
    expect(control.writes).toBe(0);
    expect(control.repository).toBeInstanceOf(SqliteResourceRepository);
  });

  it("lets an anonymous owner create a bounded draft and read it with the read-only resolver", async () => {
    const collection = await import("@/app/api/v2/resources/route");
    const item = await import("@/app/api/v2/resources/[resourceId]/route");
    const created = await collection.POST(request("POST", "/api/v2/resources", createBody()));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("private, no-store");
    const payload = await created.json() as {
      resource: { id: string; ownerId: string; status: string };
      candidate: { id: string; revision: number; status: string; semanticHash: string };
    };
    expect(payload.resource).toMatchObject({ ownerId: control.ownerId, status: "draft" });
    expect(payload.candidate).toMatchObject({ revision: 1, status: "candidate" });
    expect(control.writes).toBe(1);

    const detail = await item.GET(request("GET", `/api/v2/resources/${payload.resource.id}`), context(payload.resource.id));
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toBe("private, no-store");
    await expect(detail.json()).resolves.toMatchObject({
      resource: {
        id: payload.resource.id,
        candidateRevision: 1,
        currentCandidate: {
          packVersionId: payload.candidate.id,
          revision: 1,
          semanticHash: payload.candidate.semanticHash,
        },
      },
    });
    expect(control.reads).toBe(1);
  });

  it("explicitly adopts an anonymous SQLite resource before the first signed-in list and detail read", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const workspace = new SqliteRepo(db);
    control.repository = new SqliteResourceRepository(db);
    const collection = await import("@/app/api/v2/resources/route");
    const item = await import("@/app/api/v2/resources/[resourceId]/route");
    const adoption = await import("@/app/api/v2/resources/adopt/route");

    const created = await collection.POST(request("POST", "/api/v2/resources", createBody()));
    const id = (await created.json() as { resource: { id: string } }).resource.id;
    control.ownerId = "sb:signed-in-owner";
    control.adopt.mockImplementation(async () => {
      await workspace.adoptOwner("anonymous-resource-owner", control.ownerId);
    });

    const adopted = await adoption.POST(request("POST", "/api/v2/resources/adopt"));
    await expectPrivate(adopted, 200, { adopted: true });
    const listed = await collection.GET();
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
    await expect(listed.json()).resolves.toMatchObject({
      resources: [{ id, ownerId: "sb:signed-in-owner" }],
    });
    const detail = await item.GET(
      request("GET", `/api/v2/resources/${id}`),
      context(id),
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      resource: { id, ownerId: "sb:signed-in-owner" },
    });
    expect(control.adopt).toHaveBeenCalledOnce();
    db.close();
  });

  it("explicitly adopts through the Supabase adapter before immediate list and detail reads", async () => {
    let storedOwner = "anonymous-resource-owner";
    let semanticHash = "";
    let content: unknown;
    const portfolioRow = () => ({
      id: "supabase-resource", owner_id: storedOwner, name: "Pricing signals",
      slug: "pricing-signals", status: "draft", execution_access: "paid",
      discovery_access: "unlisted", candidate_revision: 1,
      approved_pack_version_id: null, live_pack_version_id: null,
      current_candidate: {
        packVersionId: "supabase-candidate", revision: 1, semanticHash,
      },
      approved_pack: null, live_pack: null, portfolio_freshness: "fresh",
      portfolio_payments: {
        attempted: null, free: 0, challenged: 0, executed: 0,
        credited: { count: 0, amountUsdc: 0 }, settled: { count: 0, amountUsdc: 0 },
        refunded: { count: 0, amountUsdc: 0 }, failed: 0,
      },
      current_release: null, release_count: 0, run_receipt_count: 0,
    });
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "agent_studio_resource_create_product_with_candidate") {
        const input = args.p_input as Record<string, unknown>;
        semanticHash = String(input.semanticHash);
        content = input.content;
        return { data: {
          product: {
            id: "supabase-resource", owner_id: storedOwner, name: "Pricing signals",
            slug: "pricing-signals", status: "draft", execution_access: "paid",
            discovery_access: "unlisted",
          },
          candidate: {
            id: "supabase-candidate", resource_product_id: "supabase-resource",
            revision: 1, status: "candidate", semantic_hash: semanticHash, content,
            created_by: storedOwner, created_at: "2026-08-15T00:00:00.000Z",
          },
        }, error: null };
      }
      if (name === "agent_studio_adopt_owner_with_connections") {
        if (args.p_from_owner_id === storedOwner) storedOwner = String(args.p_to_owner_id);
        return { data: null, error: null };
      }
      if (name === "agent_studio_resource_list_owned_products") {
        return { data: args.p_owner_id === storedOwner ? [portfolioRow()] : [], error: null };
      }
      if (name === "agent_studio_resource_get_owned_portfolio_item") {
        return { data: args.p_owner_id === storedOwner ? portfolioRow() : null, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    const repository = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);
    control.repository = repository;
    const collection = await import("@/app/api/v2/resources/route");
    const item = await import("@/app/api/v2/resources/[resourceId]/route");
    const adoption = await import("@/app/api/v2/resources/adopt/route");

    expect((await collection.POST(request("POST", "/api/v2/resources", createBody()))).status).toBe(201);
    control.ownerId = "sb:supabase-owner";
    control.adopt.mockImplementation(async () => {
      await repository.adoptOwner("anonymous-resource-owner", control.ownerId);
    });
    expect((await adoption.POST(request("POST", "/api/v2/resources/adopt"))).status).toBe(200);
    const listed = await collection.GET();
    await expect(listed.json()).resolves.toMatchObject({
      resources: [{ id: "supabase-resource", ownerId: "sb:supabase-owner" }],
    });
    const detail = await item.GET(
      request("GET", "/api/v2/resources/supabase-resource"),
      context("supabase-resource"),
    );
    await expect(detail.json()).resolves.toMatchObject({
      resource: { id: "supabase-resource", ownerId: "sb:supabase-owner" },
    });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "agent_studio_resource_create_product_with_candidate",
      "agent_studio_resource_get_owned_portfolio_item",
      "agent_studio_adopt_owner_with_connections",
      "agent_studio_resource_list_owned_products",
      "agent_studio_resource_get_owned_portfolio_item",
    ]);
  });

  it("rolls product creation back when the initial candidate cannot be persisted", async () => {
    const ids = ["seed-product", "shared-pack", "rolled-back-product", "shared-pack"];
    control.repository = new SqliteResourceRepository(":memory:", { id: () => ids.shift() ?? "unexpected-id" });
    const seed = await control.repository.createProduct({
      ownerId: control.ownerId, name: "Seed", slug: "seed",
      executionAccess: "private", discoveryAccess: "unlisted",
    });
    const base = resourcePack();
    await control.repository.replaceCandidate({
      ownerId: control.ownerId, resourceProductId: seed.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: { ...base, records: [], evidence: [], sourceSnapshotIds: [] },
      createdBy: control.ownerId,
    });

    const collection = await import("@/app/api/v2/resources/route");
    const failed = await collection.POST(request("POST", "/api/v2/resources", createBody({ slug: "rollback" })));
    await expectPrivate(failed, 409, { error: "resource conflict" });
    await expect(control.repository.getOwnedProduct(control.ownerId, "rolled-back-product")).resolves.toBeNull();
  });

  it("lists only the current owner's products and keeps foreign/missing IDs byte-identical", async () => {
    const collection = await import("@/app/api/v2/resources/route");
    const item = await import("@/app/api/v2/resources/[resourceId]/route");
    const created = await collection.POST(request("POST", "/api/v2/resources", createBody()));
    const product = (await created.json() as { resource: { id: string } }).resource;

    control.ownerId = "foreign-resource-owner";
    await expectPrivate(await collection.GET(), 200, { resources: [] });
    const foreign = await item.GET(request("GET", "/api/v2/resources/foreign"), context(product.id));
    const missing = await item.GET(request("GET", "/api/v2/resources/missing"), context("missing-resource"));
    await expectPrivate(foreign, 404, { error: "not found" });
    await expectPrivate(missing, 404, { error: "not found" });
  });

  it("reads and mutates the 101st older owner resource without widening the bounded portfolio", async () => {
    let tick = 0;
    control.repository = new SqliteResourceRepository(":memory:", {
      now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1_000),
    });
    const oldest = await control.repository.createProduct({
      ownerId: control.ownerId, name: "Oldest exact resource", slug: "oldest-exact-resource",
      executionAccess: "private", discoveryAccess: "unlisted",
    });
    for (let index = 0; index < 100; index += 1) {
      await control.repository.createProduct({
        ownerId: control.ownerId, name: `Newer resource ${index}`, slug: `newer-resource-${index}`,
        executionAccess: "private", discoveryAccess: "unlisted",
      });
    }
    const portfolio = await control.repository.listOwnedProducts(control.ownerId);
    expect(portfolio).toHaveLength(100);
    expect(portfolio.some((resource) => resource.id === oldest.id)).toBe(false);

    const item = await import("@/app/api/v2/resources/[resourceId]/route");
    const detail = await item.GET(
      request("GET", `/api/v2/resources/${oldest.id}`),
      context(oldest.id),
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      resource: {
        id: oldest.id,
        currentCandidate: null,
        approvedPack: null,
        livePack: null,
        portfolioFreshness: null,
        currentRelease: null,
      },
    });

    const updated = await item.PATCH(
      request("PATCH", `/api/v2/resources/${oldest.id}`, { name: "Updated exact resource" }),
      context(oldest.id),
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      resource: { id: oldest.id, name: "Updated exact resource" },
    });

    control.ownerId = "foreign-resource-owner";
    const foreign = await item.GET(request("GET", `/api/v2/resources/${oldest.id}`), context(oldest.id));
    const missing = await item.GET(request("GET", "/api/v2/resources/missing-101"), context("missing-101"));
    await expectPrivate(foreign, 404, { error: "not found" });
    await expectPrivate(missing, 404, { error: "not found" });
  });

  it("patches only draft presentation/access fields and refuses lifecycle mutation", async () => {
    const collection = await import("@/app/api/v2/resources/route");
    const item = await import("@/app/api/v2/resources/[resourceId]/route");
    const created = await collection.POST(request("POST", "/api/v2/resources", createBody()));
    const id = (await created.json() as { resource: { id: string } }).resource.id;

    const updated = await item.PATCH(
      request("PATCH", `/api/v2/resources/${id}`, { name: "Current pricing", executionAccess: "private" }),
      context(id),
    );
    await expectPrivate(updated, 200, {
      resource: {
        id,
        ownerId: control.ownerId,
        name: "Current pricing",
        slug: "pricing-signals",
        status: "draft",
        executionAccess: "private",
        discoveryAccess: "unlisted",
      },
    });

    await expectPrivate(
      await item.PATCH(request("PATCH", `/api/v2/resources/${id}`, { status: "live" }), context(id)),
      400,
      { error: "invalid request" },
    );
  });

  it("refuses unsupported media, extra keys, authorization mutation, and over-budget writes", async () => {
    const collection = await import("@/app/api/v2/resources/route");
    await expectPrivate(
      await collection.POST(request("POST", "/api/v2/resources", createBody(), "text/plain")),
      400,
      { error: "invalid request" },
    );
    await expectPrivate(
      await collection.POST(request("POST", "/api/v2/resources", createBody({ unexpected: "private-canary" }))),
      400,
      { error: "invalid request" },
    );
    const authorized = request("POST", "/api/v2/resources", createBody());
    authorized.headers.set("authorization", "Bearer caller-selected-owner");
    await expectPrivate(await collection.POST(authorized), 401, { error: "Authentication required" });

    control.allowed = false;
    control.retryAfterSec = 17;
    const limited = await collection.POST(request("POST", "/api/v2/resources", createBody()));
    await expectPrivate(limited, 429, { error: "rate limit exceeded", retryAfterSec: 17 });
    expect(limited.headers.get("retry-after")).toBe("17");
  });

  it("gates lifecycle mutation before repository work and validates one bounded strict body", async () => {
    const lifecycle = await import("@/app/api/v2/resources/[resourceId]/lifecycle/route");
    const path = "/api/v2/resources/resource-1/lifecycle";
    const body = {
      action: "pause", expectedStatus: "live", releaseId: "release-1",
      agentId: "agent-1", deploymentId: "deployment-1",
    };
    const authorized = request("POST", path, body);
    authorized.headers.set("authorization", "Bearer caller-selected-owner");
    await expectPrivate(await lifecycle.POST(authorized, context("resource-1")), 401, {
      error: "Authentication required",
    });

    await expectPrivate(await lifecycle.POST(
      request("POST", path, { ...body, unexpected: "private-canary" }),
      context("resource-1"),
    ), 400, { error: "invalid request" });

    control.blockedRateKey = `resource-lifecycle:${control.ownerId}:resource-1`;
    control.retryAfterSec = 29;
    const limited = await lifecycle.POST(request("POST", path, body), context("resource-1"));
    await expectPrivate(limited, 429, { error: "rate limit exceeded", retryAfterSec: 29 });
    expect(limited.headers.get("retry-after")).toBe("29");
  });

  it("keeps one server-derived create bucket when an anonymous caller rotates owner headers", async () => {
    const collection = await import("@/app/api/v2/resources/route");
    const first = request("POST", "/api/v2/resources", createBody());
    first.headers.set("x-real-ip", "203.0.113.44");
    expect((await collection.POST(first)).status).toBe(201);

    control.ownerId = "rotated-anonymous-resource-owner";
    control.retryAfterSec = 23;
    control.blockedRateKey = "resource-create-ip:203.0.113.44";
    const rotated = request("POST", "/api/v2/resources", createBody());
    rotated.headers.set("x-real-ip", "203.0.113.44");
    await expectPrivate(await collection.POST(rotated), 429, {
      error: "rate limit exceeded",
      retryAfterSec: 23,
    });
    expect(control.rateKeys).toContain("resource-create:anonymous-resource-owner");
    expect(control.rateKeys).toContain("resource-create:rotated-anonymous-resource-owner");
    expect(control.rateKeys.filter((key) => key === "resource-create-ip:203.0.113.44")).toHaveLength(2);
  });

  it("uses RESOURCE_FOUNDRY_ENABLED=0 as the only operational refusal", async () => {
    const collection = await import("@/app/api/v2/resources/route");
    control.enabled = false;
    await expectPrivate(await collection.GET(), 503, { error: "resource foundry unavailable" });
    await expectPrivate(
      await collection.POST(request("POST", "/api/v2/resources", createBody())),
      503,
      { error: "resource foundry unavailable" },
    );
  });
});
