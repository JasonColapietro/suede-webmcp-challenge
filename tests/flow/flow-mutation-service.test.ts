import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import Database from "better-sqlite3";
import {
  FlowMutationService,
  FlowMutationStoreUnavailableError,
} from "@/lib/flow/flow-mutation-service";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type { FlowCallableInterface, FlowGraphV2, SubflowReference } from "@/lib/flow/types";
import { SupabaseRepo } from "@/lib/db/supabase-repo";
import { hashFlowGraph } from "@/lib/projects/hash";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function store(): { repo: SqliteRepo; service: FlowMutationService; path: string } {
  const root = mkdtempSync(join(tmpdir(), "suede-flow-mutation-"));
  roots.push(root);
  const path = join(root, "studio.db");
  const repo = new SqliteRepo(path);
  return { repo, service: new FlowMutationService(repo), path };
}

function persistedState(path: string): unknown {
  const db = new Database(path, { readonly: true });
  try {
    return {
      flows: db.prepare("SELECT id, owner_id, name, graph, updated_at FROM flows ORDER BY id").all(),
      receipts: db.prepare(
        "SELECT id, owner_id, child_flow_id, old_interface_hash, proposed_interface_hash, dependent_set_hash, issued_at, expires_at, consumed_at FROM subflow_impact_receipts ORDER BY id",
      ).all(),
      integrity: db.prepare("PRAGMA integrity_check").all(),
      foreignKeys: db.prepare("PRAGMA foreign_key_check").all(),
    };
  } finally {
    db.close();
  }
}

function callable(id = "answer"): FlowCallableInterface {
  return {
    inputs: [],
    outputs: [{
      id, label: id, schema: { type: "string" }, required: true, cardinality: "one",
      source: { nodeId: "output", portId: "result" },
    }],
  };
}

function graph(id: string, interfaceValue: FlowCallableInterface = callable()): FlowGraphV2 {
  return {
    schemaVersion: 2, id, name: id,
    nodes: [{ id: "output", type: "output", params: {}, bindings: {}, position: { x: 0, y: 0 } }],
    edges: [], variables: [], groups: [], annotations: [], callableInterface: interfaceValue,
  };
}

function draft(flowId: string, abi: FlowCallableInterface): SubflowReference {
  return { kind: "draft", flowId, interface: abi, interfaceHash: hashCallableInterface(abi) };
}

function pinned(flowId: string, versionId: string, value: FlowGraphV2): SubflowReference {
  const abi = value.callableInterface!;
  return {
    kind: "pinned",
    flowId,
    versionId,
    interface: abi,
    interfaceHash: hashCallableInterface(abi),
    contentHash: hashFlowGraph(value, { semantic: true }),
  };
}

function parentGraph(id: string, references: readonly SubflowReference[]): FlowGraphV2 {
  return {
    schemaVersion: 2, id, name: id,
    nodes: references.map((reference, index) => ({
      id: `sub-${index}`, type: "subflow" as const,
      params: { reference } as never, bindings: {}, position: { x: index * 100, y: 0 },
    })),
    edges: [], variables: [], groups: [], annotations: [],
  };
}

describe("owner-scoped transactional flow mutations", () => {
  it("rejects foreign and transitive cycle references without changing bytes", async () => {
    const { service, repo, path } = store();
    const owner = "owner-a";
    const foreign = await service.save({ ownerId: "owner-b", name: "Foreign", graph: graph("foreign") });
    expect(foreign.status).toBe("saved");
    if (foreign.status !== "saved") return;

    const before = persistedState(path);
    const refused = await service.save({
      id: "parent-foreign", ownerId: owner, name: "Parent",
      graph: parentGraph("parent-foreign", [draft(foreign.flow.id, callable())]),
    });
    expect(refused.status).toBe("not-found");
    expect((await repo.getOwnedFlow("parent-foreign", owner))).toBeNull();
    expect(persistedState(path)).toEqual(before);

    const a = await service.save({ id: "flow-a", ownerId: owner, name: "A", graph: graph("flow-a") });
    const b = await service.save({
      id: "flow-b", ownerId: owner, name: "B",
      graph: parentGraph("flow-b", [draft("flow-a", callable())]),
    });
    expect(a.status).toBe("saved");
    expect(b.status).toBe("saved");
    const oldA = JSON.stringify((await repo.getOwnedFlow("flow-a", owner))?.graph);
    const cycle = await service.save({
      id: "flow-a", ownerId: owner, name: "A cycle",
      graph: parentGraph("flow-a", [draft("flow-b", callable())]),
    });
    expect(cycle).toMatchObject({ status: "cycle" });
    expect(JSON.stringify((await repo.getOwnedFlow("flow-a", owner))?.graph)).toBe(oldA);
  });

  it("uses the preallocated authoritative row id to refuse a new direct self-reference", async () => {
    const { service, repo } = store();
    const self = await service.save({
      id: "future-row", ownerId: "owner", name: "Self",
      graph: parentGraph("presentation-id", [draft("future-row", callable())]),
    });
    expect(self.status).toBe("cycle");
    expect(await repo.getOwnedFlow("future-row", "owner")).toBeNull();
  });

  it("issues one-use impact receipts and refuses a stale dependent-set retry atomically", async () => {
    const { service } = store();
    const ownerId = "owner-impact";
    expect((await service.save({ id: "child", ownerId, name: "Child", graph: graph("child") })).status).toBe("saved");
    expect((await service.save({
      id: "parent-one", ownerId, name: "Parent one",
      graph: parentGraph("parent-one", [draft("child", callable())]),
    })).status).toBe("saved");

    const proposed = graph("child", callable("revised"));
    const first = await service.save({ id: "child", ownerId, name: "Child revised", graph: proposed });
    expect(first.status).toBe("impact-required");
    if (first.status !== "impact-required") return;
    expect(first.impact.dependents).toEqual([{ flowId: "parent-one", name: "Parent one", nodeIds: ["sub-0"] }]);
    expect(first.receipt).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const repeated = await service.save({ id: "child", ownerId, name: "Child revised", graph: proposed });
    expect(repeated).toMatchObject({ status: "impact-required", receipt: first.receipt });

    expect((await service.save({
      id: "parent-two", ownerId, name: "Parent two",
      graph: parentGraph("parent-two", [draft("child", callable())]),
    })).status).toBe("saved");
    const raced = await service.save({
      id: "child", ownerId, name: "Child revised", graph: proposed, impactReceipt: first.receipt,
    });
    expect(raced.status).toBe("conflict");

    const refreshed = await service.save({ id: "child", ownerId, name: "Child revised", graph: proposed });
    expect(refreshed.status).toBe("impact-required");
    if (refreshed.status !== "impact-required") return;
    const saved = await service.save({
      id: "child", ownerId, name: "Child revised", graph: proposed, impactReceipt: refreshed.receipt,
    });
    expect(saved.status).toBe("saved");
    const reused = await service.save({
      id: "child", ownerId, name: "Again", graph: proposed, impactReceipt: refreshed.receipt,
    });
    expect(reused.status).toBe("conflict");
  });

  it("keeps one active receipt per child and invalidates it when the proposal changes", async () => {
    const { service, path } = store();
    const ownerId = "owner-receipt-cap";
    expect((await service.save({ id: "child", ownerId, name: "Child", graph: graph("child") })).status).toBe("saved");
    expect((await service.save({
      id: "parent", ownerId, name: "Parent", graph: parentGraph("parent", [draft("child", callable())]),
    })).status).toBe("saved");
    const firstGraph = graph("child", callable("first-change"));
    const first = await service.save({ id: "child", ownerId, name: "First", graph: firstGraph });
    expect(first.status).toBe("impact-required");
    if (first.status !== "impact-required") return;
    const secondGraph = graph("child", callable("second-change"));
    const second = await service.save({ id: "child", ownerId, name: "Second", graph: secondGraph });
    expect(second.status).toBe("impact-required");
    if (second.status !== "impact-required") return;
    expect(second.receipt).not.toBe(first.receipt);
    const db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM subflow_impact_receipts").get()).toEqual({ count: 1 });
    db.close();
    expect((await service.save({
      id: "child", ownerId, name: "First", graph: firstGraph, impactReceipt: first.receipt,
    })).status).toBe("conflict");
  });

  it("fails closed when a persistence adapter lacks the mutation boundary", async () => {
    const service = new FlowMutationService({} as never);
    await expect(service.save({ ownerId: "owner", name: "Nope", graph: graph("nope") }))
      .rejects.toBeInstanceOf(FlowMutationStoreUnavailableError);
  });

  it("forbids production saveFlow bypasses regardless of the Supabase mutation boundary", async () => {
    for (const path of [
      "src/app/api/flows/route.ts",
      "src/app/api/flows/[id]/route.ts",
      "src/lib/cli/agents-handler.ts",
    ]) {
      expect(readFileSync(path, "utf8"), path).not.toContain(".saveFlow(");
    }
  });

  /**
   * Fake single-table Supabase query builder good enough for
   * SupabaseRepo.mutateFlow's exact call shapes: select().eq().eq().
   * maybeSingle(), update(patch).eq().eq().select().maybeSingle(), and
   * insert(row).select().maybeSingle(). Not a general Supabase mock.
   */
  function fakeSupabaseFlowsClient(rows: Map<string, Record<string, unknown>>) {
    return {
      from(table: string) {
        if (table !== "flows") throw new Error(`fake client only supports "flows", got "${table}"`);
        let filters: Record<string, unknown> = {};
        let pendingRow: Record<string, unknown> | null = null;
        let isUpdate = false;
        const builder = {
          select() {
            return builder;
          },
          eq(column: string, value: unknown) {
            filters = { ...filters, [column]: value };
            return builder;
          },
          insert(row: Record<string, unknown>) {
            pendingRow = { ...row };
            isUpdate = false;
            return builder;
          },
          update(patch: Record<string, unknown>) {
            pendingRow = { ...patch };
            isUpdate = true;
            return builder;
          },
          async maybeSingle() {
            if (pendingRow === null) {
              const match = [...rows.values()].find((row) =>
                Object.entries(filters).every(([key, value]) => row[key] === value));
              return { data: match ?? null, error: null };
            }
            if (isUpdate) {
              const match = [...rows.entries()].find(([, row]) =>
                Object.entries(filters).every(([key, value]) => row[key] === value));
              if (!match) return { data: null, error: null };
              const [id, existingRow] = match;
              const updated = { ...existingRow, ...pendingRow };
              rows.set(id, updated);
              return { data: updated, error: null };
            }
            const id = pendingRow.id as string;
            if (rows.has(id)) return { data: null, error: { message: "duplicate key" } };
            rows.set(id, pendingRow);
            return { data: pendingRow, error: null };
          },
        };
        return builder;
      },
    };
  }

  function supabaseRepoWithFakeClient(rows: Map<string, Record<string, unknown>>): SupabaseRepo {
    const instance = Object.create(SupabaseRepo.prototype) as SupabaseRepo;
    Object.assign(instance, { db: fakeSupabaseFlowsClient(rows) });
    return instance;
  }

  it("saves a simple no-subflow-reference graph on Supabase (create then update)", async () => {
    expect(Object.prototype.hasOwnProperty.call(SupabaseRepo.prototype, "mutateFlow")).toBe(true);
    const rows = new Map<string, Record<string, unknown>>();
    const service = new FlowMutationService(supabaseRepoWithFakeClient(rows));

    const created = await service.save({ id: "flow-1", ownerId: "owner", name: "First", graph: graph("first") });
    expect(created.status).toBe("saved");
    if (created.status !== "saved") return;
    expect(created.flow.name).toBe("First");

    const updated = await service.save({ id: "flow-1", ownerId: "owner", name: "Second", graph: graph("second") });
    expect(updated.status).toBe("saved");
    if (updated.status !== "saved") return;
    expect(updated.flow.name).toBe("Second");
    expect(rows.size).toBe(1);
  });

  it("uses the exact Supabase revision predicate to refuse a stale update", async () => {
    const revision = Date.now() - 10_000;
    const rows = new Map<string, Record<string, unknown>>([
      ["flow-revision", {
        id: "flow-revision",
        owner_id: "owner",
        name: "Initial",
        graph: graph("initial"),
        updated_at: new Date(revision).toISOString(),
      }],
    ]);
    const service = new FlowMutationService(supabaseRepoWithFakeClient(rows));
    const updated = await service.save({
      id: "flow-revision",
      mustExist: true,
      expectedUpdatedAt: revision,
      ownerId: "owner",
      name: "Current",
      graph: graph("current"),
    });
    expect(updated.status).toBe("saved");
    if (updated.status !== "saved") return;
    expect(updated.flow.updatedAt).toBeGreaterThan(revision);

    await expect(service.save({
      id: "flow-revision",
      mustExist: true,
      expectedUpdatedAt: revision,
      ownerId: "owner",
      name: "Stale",
      graph: graph("stale"),
    })).resolves.toEqual({ status: "conflict" });
    expect(rows.get("flow-revision")).toMatchObject({
      name: "Current",
      graph: graph("current"),
    });
  });

  it("refuses a Supabase-owner mutation for a different owner's flow id", async () => {
    const rows = new Map<string, Record<string, unknown>>([
      ["flow-1", { id: "flow-1", owner_id: "owner-a", name: "Original", graph: graph("original"), updated_at: new Date().toISOString() }],
    ]);
    const service = new FlowMutationService(supabaseRepoWithFakeClient(rows));
    const result = await service.save({ id: "flow-1", ownerId: "owner-b", name: "Hijack", graph: graph("hijack") });
    // The owner-scoped select misses (id belongs to owner-a), so this falls
    // through to the create path, which then collides with the id's
    // existing primary key and fails closed as a conflict — never a write
    // to owner-a's row.
    expect(result.status).toBe("conflict");
    expect(rows.get("flow-1")).toMatchObject({ owner_id: "owner-a", name: "Original" });
  });

  it("refuses a graph containing a subflow reference on Supabase", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const service = new FlowMutationService(supabaseRepoWithFakeClient(rows));
    const withSubflow: FlowGraphV2 = {
      ...graph("has-subflow"),
      nodes: [
        { id: "sub", type: "subflow", params: { flowId: "some-other-flow" }, bindings: {}, position: { x: 0, y: 0 } },
      ],
    };
    const result = await service.save({ id: "flow-2", ownerId: "owner", name: "Has subflow", graph: withSubflow });
    expect(result.status).toBe("invalid-reference");
    expect(rows.size).toBe(0);
  });

  it("keeps the legacy save helper from overwriting a foreign row id", async () => {
    const { repo } = store();
    await repo.saveFlow({ id: "shared", ownerId: "owner-a", name: "Original", graph: graph("original") });
    await expect(repo.saveFlow({ id: "shared", ownerId: "owner-b", name: "Hijack", graph: graph("hijack") }))
      .rejects.toThrow(/ownership conflict/i);
    expect(await repo.getOwnedFlow("shared", "owner-a")).toMatchObject({ name: "Original" });
    expect(await repo.getOwnedFlow("shared", "owner-b")).toBeNull();
  });

  it("atomically rejects a stale SQLite revision and advances revisions monotonically", async () => {
    const { service, repo } = store();
    const created = await service.save({
      id: "revision-flow",
      ownerId: "revision-owner",
      name: "Initial",
      graph: graph("revision-initial"),
    });
    expect(created.status).toBe("saved");
    if (created.status !== "saved") return;

    const updated = await service.save({
      id: created.flow.id,
      mustExist: true,
      expectedUpdatedAt: created.flow.updatedAt,
      ownerId: created.flow.ownerId,
      name: "Current",
      graph: graph("revision-current"),
    });
    expect(updated.status).toBe("saved");
    if (updated.status !== "saved") return;
    expect(updated.flow.updatedAt).toBeGreaterThan(created.flow.updatedAt);

    await expect(service.save({
      id: created.flow.id,
      mustExist: true,
      expectedUpdatedAt: created.flow.updatedAt,
      ownerId: created.flow.ownerId,
      name: "Stale",
      graph: graph("revision-stale"),
    })).resolves.toEqual({ status: "conflict" });
    await expect(repo.getOwnedFlow(created.flow.id, created.flow.ownerId)).resolves.toMatchObject({
      name: "Current",
      graph: graph("revision-current"),
      updatedAt: updated.flow.updatedAt,
    });
  });

  it("atomically refuses missing and foreign legacy targets", async () => {
    const { service, path } = store();
    const ownerId = "owner-legacy";
    expect((await service.save({ id: "foreign", ownerId: "other", name: "Foreign", graph: graph("foreign") })).status)
      .toBe("saved");
    for (const flowId of ["missing", "foreign"]) {
      const { callableInterface: _callableInterface, ...base } = graph(`legacy-${flowId}`);
      const legacy: FlowGraphV2 = {
        ...base,
        nodes: [{
          id: "legacy", type: "subflow", params: { flowId }, bindings: {}, position: { x: 0, y: 0 },
        }],
      };
      const before = persistedState(path);
      expect((await service.save({ id: `parent-${flowId}`, ownerId, name: "Parent", graph: legacy })).status)
        .toBe("not-found");
      expect(persistedState(path)).toEqual(before);
    }
  });

  it("rejects bounded malformed direct objects and invalid names without touching rows", async () => {
    const { service, path } = store();
    const before = persistedState(path);
    for (const input of [
      { ownerId: "owner", name: "Bad", graph: { schemaVersion: 2, id: "bad" } as never },
      { ownerId: "owner", name: " ", graph: graph("bad-name") },
      { ownerId: "owner", name: "é".repeat(101), graph: graph("oversized-name") },
    ]) {
      expect((await service.save(input)).status).toBe("invalid-reference");
    }
    expect(persistedState(path)).toEqual(before);
  });

  it("bounds repeated references before an owner can amplify transactional reads", async () => {
    const { service, path } = store();
    const ownerId = "owner-amplification";
    expect((await service.save({ id: "child", ownerId, name: "Child", graph: graph("child") })).status)
      .toBe("saved");
    const repeated = Array.from({ length: 1_001 }, () => draft("child", callable()));
    const before = persistedState(path);
    expect((await service.save({
      id: "amplified", ownerId, name: "Amplified", graph: parentGraph("amplified", repeated),
    })).status).toBe("invalid-reference");
    expect(persistedState(path)).toEqual(before);
  });

  it("keeps opaque pinned tuple identities collision-free across punctuation and Unicode", async () => {
    const { service, path } = store();
    const ownerId = "owner-opaque-tuples";
    const fixtures = [
      { flowId: "a:b", versionId: "c", value: graph("first") },
      { flowId: "a", versionId: "b:c", value: graph("second", callable("second")) },
      { flowId: "slash/%2F/雪", versionId: "v:@/%", value: graph("unicode", callable("unicode")) },
    ];
    for (const fixture of fixtures) {
      expect((await service.save({
        id: fixture.flowId, ownerId, name: fixture.flowId, graph: fixture.value,
      })).status).toBe("saved");
    }
    const db = new Database(path);
    const insert = db.prepare(
      `INSERT INTO flow_versions
        (id, flow_id, version_number, schema_version, label, description, graph,
         semantic_hash, full_hash, created_by, created_at)
       VALUES (?, ?, 1, 2, NULL, NULL, ?, ?, ?, ?, ?)`,
    );
    for (const fixture of fixtures) {
      insert.run(
        fixture.versionId,
        fixture.flowId,
        JSON.stringify(fixture.value),
        hashFlowGraph(fixture.value, { semantic: true }),
        hashFlowGraph(fixture.value, { semantic: false }),
        ownerId,
        Date.now(),
      );
    }
    db.close();
    const result = await service.save({
      id: "parent", ownerId, name: "Parent",
      graph: parentGraph("parent", fixtures.map((fixture) =>
        pinned(fixture.flowId, fixture.versionId, fixture.value))),
    });
    expect(result.status).toBe("saved");
  });

  it("keeps validate-only snapshots incapable of issuing receipts or changing drafts", async () => {
    const { service, path } = store();
    const ownerId = "owner-validate-only";
    expect((await service.save({ id: "child", ownerId, name: "Child", graph: graph("child") })).status).toBe("saved");
    expect((await service.save({
      id: "parent", ownerId, name: "Parent", graph: parentGraph("parent", [draft("child", callable())]),
    })).status).toBe("saved");
    const db = new Database(path);
    const boundary = new SqliteRepo(db);
    const before = persistedState(path);
    const validate = db.transaction(() => boundary.mutateFlowInCurrentTransaction({
      id: "child",
      mustExist: true,
      validateOnly: true,
      ownerId,
      name: "Changed",
      graph: graph("child", callable("changed")),
    }));
    expect(validate.immediate().status).toBe("conflict");
    db.close();
    expect(persistedState(path)).toEqual(before);
  });

  it("refuses expired impact receipts without consuming them or changing the child", async () => {
    const { service, repo, path } = store();
    const ownerId = "owner-expiry";
    expect((await service.save({ id: "child", ownerId, name: "Child", graph: graph("child") })).status).toBe("saved");
    expect((await service.save({
      id: "parent", ownerId, name: "Parent",
      graph: parentGraph("parent", [draft("child", callable())]),
    })).status).toBe("saved");
    const proposed = graph("child", callable("changed"));
    const first = await service.save({ id: "child", mustExist: true, ownerId, name: "Changed", graph: proposed });
    expect(first.status).toBe("impact-required");
    if (first.status !== "impact-required") return;
    const db = new Database(path);
    db.prepare("UPDATE subflow_impact_receipts SET issued_at = 0, expires_at = 1 WHERE id = ?").run(first.receipt);
    db.close();
    const before = persistedState(path);
    expect((await service.save({
      id: "child", mustExist: true, ownerId, name: "Changed", graph: proposed,
      impactReceipt: first.receipt,
    })).status).toBe("conflict");
    expect(persistedState(path)).toEqual(before);
    expect((await repo.getOwnedFlow("child", ownerId))?.name).toBe("Child");
  });

  it("fails closed when a complete dependent scan encounters malformed owned bytes", async () => {
    const { service, path } = store();
    const ownerId = "owner-corrupt";
    expect((await service.save({ id: "child", ownerId, name: "Child", graph: graph("child") })).status).toBe("saved");
    const db = new Database(path);
    db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("corrupt", ownerId, "Corrupt", "{", Date.now());
    db.close();
    const before = persistedState(path);
    const result = await service.save({
      id: "child", mustExist: true, ownerId, name: "Changed", graph: graph("child", callable("changed")),
    });
    expect(result.status).toBe("invalid-reference");
    expect(persistedState(path)).toEqual(before);
  });
});
