import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import { ResourcePublishService } from "@/lib/resources/publish-service";
import type { ResourceRepository } from "@/lib/resources/repository";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { ResourceFoundryService } from "@/lib/resources/service";

const DEFAULT_OWNER = "1c1f7a1e-0000-4000-8000-000000000001";
const control = vi.hoisted(() => ({
  ownerId: "1c1f7a1e-0000-4000-8000-000000000001",
  repository: null as ResourceRepository | null,
  crawl: vi.fn(),
  rateKeys: [] as string[],
  resolveOwner: vi.fn(),
  checkRate: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  resolveOwnerId: () => control.resolveOwner(),
}));
vi.mock("@/lib/resources/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/provider")>()),
  getResourceRepository: async () => control.repository,
}));
vi.mock("@/lib/resources/flags", () => ({ RESOURCE_FOUNDRY_ENABLED: true }));
vi.mock("@/lib/site/crawl", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/site/crawl")>()), crawlSite: control.crawl }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: (key: string) => control.checkRate(key),
  ipFromRequest: () => "198.51.100.22",
}));

function request(body: unknown, host = "agents.suedeai.ai"): Request {
  return new Request(`https://${host}/api/v2/resources/import/site-agent`, { method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify(body) });
}

let database: Database.Database;

beforeEach(() => {
  database = new Database(":memory:");
  runSqliteMigrations(database);
  control.repository = new SqliteResourceRepository(database);
  control.ownerId = DEFAULT_OWNER;
  control.rateKeys = [];
  control.resolveOwner.mockReset().mockImplementation(async () => control.ownerId);
  control.checkRate.mockReset().mockImplementation((key: string) => {
    control.rateKeys.push(key);
    return { allowed: true, retryAfterSec: 0 };
  });
  control.crawl.mockReset().mockImplementation(async (url: string, options?: { includeUrls?: readonly string[]; maxPages?: number }) => ({
    homeUrl: new URL(url).toString(), origin: new URL(url).origin, host: new URL(url).host,
    pages: [
      { url: new URL(url).toString(), title: "Acme", description: "Public facts", siteName: "Acme", ogTitle: null, ogDescription: null, canonical: new URL(url).toString(), text: "A sufficiently long bounded public page collected again through the hardened crawler boundary.", headings: ["Acme"] },
      { url: new URL("/duplicate", url).toString(), title: "Acme duplicate", description: "Duplicate public facts", siteName: "Acme", ogTitle: null, ogDescription: null, canonical: new URL(url).toString(), text: "A duplicate page with the same canonical URL must not create a second private record.", headings: ["Acme"] },
      ...(options?.includeUrls ?? []).filter((entry) => entry !== new URL(url).toString()).map((entry) => ({ url: entry, title: "Selected", description: "Selected public facts", siteName: "Acme", ogTitle: null, ogDescription: null, canonical: entry, text: "A specifically selected page handled inside the one aggregate bounded crawl budget.", headings: ["Selected"] })),
    ],
    skippedByRobots: [], truncated: false,
  }));
});

afterEach(() => database.close());

describe("POST /api/v2/resources/import/site-agent", () => {
  it("recollects bounded URLs into an owner draft and returns only a private navigation receipt", async () => {
    const route = await import("@/app/api/v2/resources/import/site-agent/route");
    const response = await route.POST(request({
      url: "https://acme.example/", name: "Acme pricing resource",
      sourceUrls: ["https://acme.example/", "https://acme.example/pricing"],
      suggestedJob: "Return one reviewed answer to a recurring pricing question.", priceUsdc: 0.08,
    }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    expect(text).not.toContain("hardened crawler boundary");
    expect(text).not.toContain("provenance");
    const payload = JSON.parse(text) as { resourceId: string; redirectTo: string; sourceCount: number; suggestedPriceUsdc: number; collectionStatus: string; warnings: string[] };
    expect(payload).toMatchObject({ sourceCount: 2, suggestedPriceUsdc: 0.08, collectionStatus: "collected", warnings: [] });
    expect(payload.redirectTo).toBe(`/resources/${encodeURIComponent(payload.resourceId)}?tab=sources`);
    expect(control.crawl).toHaveBeenCalledTimes(1);
    expect(control.crawl).toHaveBeenCalledWith("https://acme.example/", {
      includeUrls: ["https://acme.example/", "https://acme.example/pricing"],
      maxPages: 6,
    });
    expect(control.rateKeys).toEqual([
      "resource-site-import-ip:198.51.100.22",
      `resource-site-import:${DEFAULT_OWNER}`,
    ]);
    const product = await control.repository!.getOwnedPortfolioItem(control.ownerId, payload.resourceId);
    expect(product).toMatchObject({ status: "draft", approvedPackVersionId: null, livePackVersionId: null, releaseCount: 0 });
  });

  it("keeps imported text private through approve, real dry-run, and publication", async () => {
    const route = await import("@/app/api/v2/resources/import/site-agent/route");
    const response = await route.POST(request({
      url: "https://acme.example/", name: "Acme public resource", sourceUrls: [],
      suggestedJob: "Return one reviewed website record.", priceUsdc: 0,
    }));
    const imported = await response.json() as { resourceId: string };
    const foundry = new ResourceFoundryService(control.repository!);
    const product = await control.repository!.getOwnedPortfolioItem(control.ownerId, imported.resourceId);
    const candidate = product!.currentCandidate!;
    const approved = await foundry.approveCandidate(control.ownerId, imported.resourceId, {
      candidatePackVersionId: candidate.packVersionId,
      expectedRevision: candidate.revision,
      expectedSemanticHash: candidate.semanticHash,
    });
    const pack = await foundry.getPack(control.ownerId, imported.resourceId, {
      packVersionId: approved.id, semanticHash: approved.semanticHash,
    });
    expect(pack.content.records[0]?.fields).toHaveProperty("text");
    expect([...pack.content.returnFields].sort()).toEqual(["description", "title", "url"]);
    const outputItems = pack.content.jobContract.outputSchema.items as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(outputItems.properties).sort()).toEqual(["description", "title", "url"]);
    expect([...outputItems.required].sort()).toEqual(["description", "title", "url"]);

    const tested = await foundry.dryRun(control.ownerId, imported.resourceId, {
      packVersionId: approved.id, semanticHash: approved.semanticHash,
      input: {}, filters: {}, filterFields: [], returnFields: ["url", "title", "description"],
    });
    expect(tested.outputSchemaValid).toBe(true);
    expect(tested.result).toEqual([{ url: "https://acme.example/", title: "Acme", description: "Public facts" }]);
    expect(JSON.stringify(tested.result)).not.toContain("hardened crawler boundary");

    const published = await new ResourcePublishService({
      resourceRepo: control.repository!, flowRepo: new SqliteRepo(database),
      projectRepo: new SqliteProjectRepo(database),
    }).publish(control.ownerId, imported.resourceId, {
      idempotencyKey: "site-import-lifecycle", priceUsdc: 0,
      representative: { input: {}, filters: {} },
    });
    expect(published.release.packVersionId).toBe(approved.id);
    expect(published.agent.status).toBe("live");
  });

  it("rejects extra fields, oversized URL lists, bearer mutations, and Play-host mutations before collection", async () => {
    const route = await import("@/app/api/v2/resources/import/site-agent/route");
    const valid = { url: "https://acme.example/", name: "Acme", sourceUrls: ["https://acme.example/"], suggestedJob: "Return one reviewed recurring answer.", priceUsdc: 0 };
    expect((await route.POST(request({ ...valid, rightsVerified: true }))).status).toBe(400);
    expect((await route.POST(request({ ...valid, sourceUrls: Array.from({ length: 7 }, (_, index) => `https://acme.example/${index}`) }))).status).toBe(400);
    const bearer = request(valid); bearer.headers.set("authorization", "Bearer private");
    expect((await route.POST(bearer)).status).toBe(401);
    expect((await route.POST(request(valid, "android-agents.suedeai.ai"))).status).toBe(403);
    expect(control.crawl).not.toHaveBeenCalled();
  });

  it("short-circuits a blocked IP before resolving or allocating an owner bucket", async () => {
    const route = await import("@/app/api/v2/resources/import/site-agent/route");
    control.checkRate.mockImplementation((key: string) => {
      control.rateKeys.push(key);
      return key.startsWith("resource-site-import-ip:")
        ? { allowed: false, retryAfterSec: 20 }
        : { allowed: true, retryAfterSec: 0 };
    });

    const response = await route.POST(request({
      url: "https://acme.example/", name: "Acme", sourceUrls: [],
      suggestedJob: "Return one reviewed recurring answer.", priceUsdc: 0,
    }));

    expect(response.status).toBe(429);
    expect(control.resolveOwner).not.toHaveBeenCalled();
    expect(control.rateKeys).toEqual(["resource-site-import-ip:198.51.100.22"]);
  });

  it("caps rotated-owner bucket allocation behind the shared IP burst", async () => {
    const route = await import("@/app/api/v2/resources/import/site-agent/route");
    let ipChecks = 0;
    let ownerSequence = 1;
    control.resolveOwner.mockImplementation(async () =>
      `1c1f7a1e-0000-4000-8000-${String(ownerSequence++).padStart(12, "0")}`,
    );
    control.checkRate.mockImplementation((key: string) => {
      control.rateKeys.push(key);
      if (key.startsWith("resource-site-import-ip:")) {
        ipChecks += 1;
        return { allowed: ipChecks <= 4, retryAfterSec: ipChecks <= 4 ? 0 : 20 };
      }
      return { allowed: true, retryAfterSec: 0 };
    });
    const body = {
      url: "https://acme.example/", name: "Acme", sourceUrls: [],
      suggestedJob: "Return one reviewed recurring answer.", priceUsdc: 0,
    };

    for (let requestIndex = 0; requestIndex < 4; requestIndex += 1) {
      expect((await route.POST(request(body))).status).toBe(201);
    }
    expect((await route.POST(request(body))).status).toBe(429);

    expect(control.resolveOwner).toHaveBeenCalledTimes(4);
    expect(control.rateKeys.filter((key) => key.startsWith("resource-site-import:"))).toHaveLength(4);
  });

  it.each(["rotated-owner", DEFAULT_OWNER.toUpperCase(), "1c1f7a1e-0000-1000-8000-000000000001"])(
    "rejects a non-canonical anonymous owner %j before repository work",
    async (ownerId) => {
      const route = await import("@/app/api/v2/resources/import/site-agent/route");
      control.ownerId = ownerId;
      const response = await route.POST(request({
        url: "https://acme.example/", name: "Acme", sourceUrls: [],
        suggestedJob: "Return one reviewed recurring answer.", priceUsdc: 0,
      }));

      expect(response.status).toBe(401);
      expect(control.crawl).not.toHaveBeenCalled();
      expect(control.rateKeys).toEqual(["resource-site-import-ip:198.51.100.22"]);
    },
  );

  it("returns a strict private error when recollection fails and never creates an approved or Live pack", async () => {
    const route = await import("@/app/api/v2/resources/import/site-agent/route");
    control.crawl.mockRejectedValueOnce(new Error("private upstream canary"));
    const response = await route.POST(request({
      url: "https://failed.example/", name: "Failed source",
      sourceUrls: ["https://failed.example/"],
      suggestedJob: "Return one recurring reviewed answer.", priceUsdc: 0.08,
    }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = await response.json() as { resourceId: string; redirectTo: string; sourceCount: number; collectionStatus: string; warnings: string[] };
    expect(payload).toEqual({
      resourceId: expect.any(String), sourceCount: 0, suggestedPriceUsdc: 0.08,
      collectionStatus: "failed", warnings: ["source collection failed"],
      redirectTo: `/resources/${encodeURIComponent(payload.resourceId)}?tab=sources`,
    });
    const drafts = await control.repository!.listOwnedProducts(control.ownerId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "draft", approvedPackVersionId: null, livePackVersionId: null, releaseCount: 0 });
    expect(drafts[0]?.currentCandidate).not.toBeNull();
    const candidate = drafts[0]!.currentCandidate!;
    const pack = await control.repository!.getOwnedPack({
      ownerId: control.ownerId, resourceProductId: drafts[0]!.id,
      packVersionId: candidate.packVersionId, semanticHash: candidate.semanticHash,
    });
    expect(pack?.content.records).toEqual([]);
  });
});
