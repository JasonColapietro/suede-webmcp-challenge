import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlowGraphV2 } from "@/lib/flow/types";
import {
  assertPinnedResourceDependenciesCurrent,
  derivePinnedResourceDependencies,
  rejectCallerResourceDependencies,
  resourceDependencyPinsFromGraph,
} from "@/lib/projects/resource-dependencies";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import { SupabaseProjectRepo } from "@/lib/projects/supabase-project-repo";
import { VersionService } from "@/lib/projects/version-service";
import type { OwnerScopedResourcePackResolver } from "@/lib/projects/resource-dependencies";
import { resourcePack } from "../resources/fixture";
import { resourcePackSemanticHash } from "@/lib/resources/pack-hash";
import { hashFlowGraph } from "@/lib/projects/hash";
import { compareFlowVersionDetails } from "@/lib/projects/version-diff";
import type { DependencyPin, FlowVersionRecord } from "@/lib/projects/types";
import {
  createOwnerScopedResourcePackResolver,
  createSqliteOwnerScopedResourcePackResolver,
} from "@/lib/projects/resource-dependencies";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { RESOURCE_TEST_NOW } from "../resources/fixture";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { CreateFlowVersionRequestSchema } from "@/lib/projects/request-schema";

const OWNER = "owner-resource-pins";
const FOREIGN = "owner-foreign";
const content = resourcePack();
const contentHash = resourcePackSemanticHash(content).semanticHash;

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: "resource",
    type: "resource.query" as const,
    params: {
      resourceProductId: "resource-1",
      packVersionId: "pack-1",
      resourcePackContentHash: contentHash,
      filterFields: ["tier"],
      returnFields: ["name"],
      ...overrides,
    },
    bindings: {},
    position: { x: 0, y: 0 },
  };
}

function graph(nodes = [node()]): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "flow-graph",
    name: "Resource flow",
    nodes,
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
  };
}

function resolved(status: "candidate" | "approved" | "live" = "approved") {
  return {
    status,
    bundle: {
      resourceProductId: "resource-1",
      packVersionId: "pack-1",
      semanticHash: contentHash,
      freshness: "fresh" as const,
      content,
    },
  };
}

const resolver: OwnerScopedResourcePackResolver = () => resolved();

function dependencyView(dependencies: readonly { kind: string; resourceId: string; version: string; contentHash?: string }[]) {
  return dependencies.map(({ kind, resourceId, version, contentHash: hash }) => ({
    kind,
    resourceId,
    version,
    ...(hash === undefined ? {} : { contentHash: hash }),
  }));
}

function query(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order"] as const) value[method] = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => result);
  value.then = (resolve: (input: typeof result) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return value;
}

describe("server-derived Resource Pack dependencies", () => {
  it("rejects caller-supplied resource pins and derives only exact node params", async () => {
    const forged = { kind: "resource" as const, resourceId: "resource-1", version: "latest" };
    expect(CreateFlowVersionRequestSchema.safeParse({ dependencies: [forged] }).success).toBe(false);
    expect(() => rejectCallerResourceDependencies([forged])).toThrow(/resource.*server|caller.*resource/i);
    await expect(derivePinnedResourceDependencies(graph(), resolver)).resolves.toEqual([{
      kind: "resource",
      resourceId: "resource-1",
      version: "pack-1",
      contentHash,
    }]);
  });

  it("refuses drafts, missing or mismatched hashes, foreign products, and conflicting versions", async () => {
    for (const value of [null, resolved("candidate"), {
      ...resolved(), bundle: { ...resolved().bundle, semanticHash: "f".repeat(64) },
    }]) {
      await expect(derivePinnedResourceDependencies(graph(), async () => value as never))
        .rejects.toThrow(/resource|pack|approved|live|unavailable/i);
    }
    const foreignResolver: OwnerScopedResourcePackResolver = async (reference) =>
      reference.resourceProductId === "resource-1" ? null : resolved();
    await expect(derivePinnedResourceDependencies(graph(), foreignResolver))
      .rejects.toThrow(/resource|pack|unavailable/i);

    await expect(derivePinnedResourceDependencies(graph([
      node(),
      { ...node({ packVersionId: "pack-2", resourcePackContentHash: "b".repeat(64) }), id: "other" },
    ]), resolver)).rejects.toThrow(/multiple|conflict|version/i);
  });

  it("mirrors runtime resource ID and field-list bounds during pin extraction", () => {
    const tooManyFields = Array.from({ length: 65 }, (_, index) => `field-${index}`);
    for (const overrides of [
      { resourceProductId: "é".repeat(65) },
      { packVersionId: "p".repeat(129) },
      { filterFields: tooManyFields },
      { returnFields: tooManyFields },
      { filterFields: ["tier", "tier"] },
      { returnFields: ["n".repeat(129)] },
    ]) {
      expect(() => resourceDependencyPinsFromGraph(graph([node(overrides)])))
        .toThrow(/resource|dependency|refused/i);
    }
  });

  it("revalidates the complete resource pin set against the current approved or Live pack", async () => {
    const pins = await derivePinnedResourceDependencies(graph(), resolver);
    await expect(assertPinnedResourceDependenciesCurrent(graph(), pins, resolver)).resolves.toBeUndefined();
    await expect(assertPinnedResourceDependenciesCurrent(graph(), [
      { ...pins[0]!, contentHash: "f".repeat(64) },
    ], resolver)).rejects.toThrow(/resource|pack|current|unavailable/i);
  });

  it("rejects a superseded approval identically in async and SQLite resolution", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteResourceRepository(db, {
      now: () => RESOURCE_TEST_NOW,
    });
    const product = await repository.createProduct({
      ownerId: OWNER,
      name: "Approval parity",
      slug: "approval-parity",
      executionAccess: "private",
      discoveryAccess: "unlisted",
    });
    await repository.createSourceSnapshot({
      id: "snapshot-contract",
      ownerId: OWNER,
      resourceProductId: product.id,
      locator: "manual://approval-parity",
      sourceKind: "manual",
      capturedAt: RESOURCE_TEST_NOW.toISOString(),
      contentHash: "a".repeat(64),
      freshnessDeadline: "2026-08-20T12:00:00.000Z",
    });
    const firstCandidate = await repository.replaceCandidate({
      ownerId: OWNER,
      resourceProductId: product.id,
      expectedCandidatePackVersionId: null,
      expectedRevision: 0,
      content: resourcePack("First approval"),
      createdBy: OWNER,
    });
    const first = await repository.approveCandidate({
      ownerId: OWNER,
      resourceProductId: product.id,
      candidatePackVersionId: firstCandidate.id,
      expectedRevision: firstCandidate.revision,
      expectedSemanticHash: firstCandidate.semanticHash,
      approvedBy: OWNER,
    });
    const secondCandidate = await repository.replaceCandidate({
      ownerId: OWNER,
      resourceProductId: product.id,
      expectedCandidatePackVersionId: null,
      expectedRevision: first.revision,
      content: resourcePack("Second approval"),
      createdBy: OWNER,
    });
    const second = await repository.approveCandidate({
      ownerId: OWNER,
      resourceProductId: product.id,
      candidatePackVersionId: secondCandidate.id,
      expectedRevision: secondCandidate.revision,
      expectedSemanticHash: secondCandidate.semanticHash,
      approvedBy: OWNER,
    });
    const oldReference = {
      resourceProductId: product.id,
      packVersionId: first.id,
      contentHash: first.semanticHash,
    };
    const currentReference = {
      resourceProductId: product.id,
      packVersionId: second.id,
      contentHash: second.semanticHash,
    };
    const asyncResolver = createOwnerScopedResourcePackResolver(OWNER, repository);
    const sqliteResolver = createSqliteOwnerScopedResourcePackResolver(db, OWNER);
    await expect(asyncResolver(oldReference)).resolves.toBeNull();
    expect(sqliteResolver(oldReference)).toBeNull();
    await expect(asyncResolver(currentReference)).resolves.toMatchObject({ status: "approved" });
    expect(sqliteResolver(currentReference)).toMatchObject({ status: "approved" });
    db.close();
  });

  it("persists the same derived pin through SQLite and Supabase version paths", async () => {
    const db = new Database(":memory:");
    const sqliteRepo = new SqliteProjectRepo(db, { resolveResourcePack: resolver });
    db.prepare("INSERT INTO flows (id,owner_id,name,graph,updated_at) VALUES (?,?,?,?,?)")
      .run("flow-sqlite", OWNER, graph().name, JSON.stringify(graph()), 1);
    const sqlite = await new VersionService(sqliteRepo).createFlowVersion({
      flowId: "flow-sqlite",
      ownerId: OWNER,
    });

    const persistedDependencies: Array<Record<string, unknown>> = [];
    const versionRow = {
      id: "version-supabase",
      flow_id: "flow-supabase",
      version_number: 1,
      schema_version: 2,
      label: "resource pin",
      description: null,
      graph: graph(),
      semantic_hash: "a".repeat(64),
      full_hash: "b".repeat(64),
      created_by: OWNER,
      created_at: "2026-08-13T12:00:00.000Z",
    };
    const from = vi.fn((table: string) => table === "flows"
      ? query({ data: { graph: graph() }, error: null })
      : query({ data: persistedDependencies, error: null }));
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      persistedDependencies.push(...((args.p_dependencies ?? []) as Array<Record<string, unknown>>)
        .map((pin) => ({
          id: "pin-supabase",
          flow_version_id: versionRow.id,
          kind: pin.kind,
          resource_id: pin.resource_id,
          version: pin.version,
          content_hash: pin.content_hash,
          created_at: versionRow.created_at,
        })));
      return { data: versionRow, error: null };
    });
    const supabaseRepo = new SupabaseProjectRepo(
      { from, rpc } as unknown as SupabaseClient,
      { resolveResourcePack: resolver },
    );
    const supabase = await new VersionService(supabaseRepo).createFlowVersion({
      flowId: "flow-supabase",
      ownerId: OWNER,
      label: "resource pin",
    });

    expect(sqlite).not.toBeNull();
    expect(supabase).not.toBeNull();
    expect(dependencyView(sqlite!.dependencies)).toEqual(dependencyView(supabase!.dependencies));
    expect(dependencyView(sqlite!.dependencies)).toEqual([{
      kind: "resource",
      resourceId: "resource-1",
      version: "pack-1",
      contentHash,
    }]);
    expect(from).toHaveBeenCalledWith("dependency_pins");
    db.close();
  });

  it("keeps owner scope outside graph params and resolver calls", async () => {
    const seen: unknown[] = [];
    await derivePinnedResourceDependencies(graph(), async (reference) => {
      seen.push(reference);
      return resolved();
    });
    expect(seen).toEqual([{
      resourceProductId: "resource-1",
      packVersionId: "pack-1",
      contentHash,
    }]);
    expect(JSON.stringify(graph())).not.toContain(OWNER);
    expect(JSON.stringify(graph())).not.toContain(FOREIGN);
  });

  it("includes Resource Pack pins in immutable equality, diff, and graph hashes", async () => {
    const [pin] = await derivePinnedResourceDependencies(graph(), resolver);
    const changed = { ...pin!, contentHash: "e".repeat(64) };
    expect(hashFlowGraph(graph(), { semantic: true }, [pin!]))
      .not.toBe(hashFlowGraph(graph(), { semantic: true }, [changed]));

    const version = (
      id: string,
      dependency: typeof pin,
    ): FlowVersionRecord => ({
      id,
      flowId: "flow-resource",
      versionNumber: id === "before" ? 1 : 2,
      schemaVersion: 2,
      graph: graph(),
      semanticHash: "a".repeat(64),
      fullHash: "b".repeat(64),
      createdBy: OWNER,
      createdAt: 1,
      dependencies: [{
        ...dependency!,
        id: `pin-${id}`,
        flowVersionId: id,
        createdAt: 1,
      } as DependencyPin],
    });
    const diff = compareFlowVersionDetails(version("before", pin), version("after", changed));
    expect(diff.semanticEqual).toBe(false);
    expect(diff.changedSections).toContain("dependencies");
    expect(diff.entries).toContainEqual(expect.objectContaining({
      kind: "dependency",
      change: "changed",
      fields: ["contentHash"],
    }));
  });
});
