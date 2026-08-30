import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canonicalConnectionPublicConfig,
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "@/lib/connections/crypto";
import {
  ConnectionRepositoryUnavailableError,
  InvalidConnectionPageError,
} from "@/lib/connections/repository";
import { SupabaseConnectionRepository } from "@/lib/connections/supabase-repository";

const KEY = Buffer.alloc(32, 7);

type Result = Readonly<{ data: unknown; error: null | Readonly<{ message: string }> }>;
type Operation = Readonly<{ name: string; args: readonly unknown[] }>;

class FakeQuery implements PromiseLike<Result> {
  readonly operations: Operation[] = [];

  constructor(readonly result: Result) {}

  #operation(name: string, ...args: readonly unknown[]): this {
    this.operations.push(Object.freeze({ name, args }));
    return this;
  }

  select(...args: readonly unknown[]): this { return this.#operation("select", ...args); }
  insert(...args: readonly unknown[]): this { return this.#operation("insert", ...args); }
  update(...args: readonly unknown[]): this { return this.#operation("update", ...args); }
  eq(...args: readonly unknown[]): this { return this.#operation("eq", ...args); }
  lt(...args: readonly unknown[]): this { return this.#operation("lt", ...args); }
  order(...args: readonly unknown[]): this { return this.#operation("order", ...args); }
  limit(...args: readonly unknown[]): this { return this.#operation("limit", ...args); }
  single(): Promise<Result> { this.#operation("single"); return Promise.resolve(this.result); }
  maybeSingle(): Promise<Result> { this.#operation("maybeSingle"); return Promise.resolve(this.result); }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

interface QueryPlan {
  readonly table: string;
  readonly result: Result;
}

interface RpcPlan {
  readonly name: string;
  readonly result: Result;
}

class FakeClient {
  readonly queries: Array<Readonly<{ table: string; query: FakeQuery }>> = [];
  readonly calls: Array<Readonly<{ name: string; args: Record<string, unknown> }>> = [];
  readonly #queryPlans: QueryPlan[];
  readonly #rpcPlans: RpcPlan[];

  constructor(queryPlans: readonly QueryPlan[] = [], rpcPlans: readonly RpcPlan[] = []) {
    this.#queryPlans = [...queryPlans];
    this.#rpcPlans = [...rpcPlans];
  }

  from(table: string): FakeQuery {
    const plan = this.#queryPlans.shift();
    if (!plan || plan.table !== table) throw new Error(`Unexpected table ${table}`);
    const query = new FakeQuery(plan.result);
    this.queries.push(Object.freeze({ table, query }));
    return query;
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<Result> {
    const plan = this.#rpcPlans.shift();
    if (!plan || plan.name !== name) throw new Error(`Unexpected RPC ${name}`);
    this.calls.push(Object.freeze({ name, args: Object.freeze({ ...args }) }));
    return plan.result;
  }

  client(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

function result(data: unknown): Result {
  return Object.freeze({ data, error: null });
}

function failure(message = "private-db-canary"): Result {
  return Object.freeze({ data: null, error: Object.freeze({ message }) });
}

function slot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: "live",
    status: "configured",
    secret_version: 1,
    updated_at: 20,
    revoked_at: null,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Production API",
    kind: "bearer",
    public_config: {},
    schema_version: 1,
    lifecycle_revision: 1,
    created_at: 10,
    updated_at: 10,
    connection_slots: [],
    ...overrides,
  };
}

function graph(connectionId: string): string {
  return JSON.stringify({
    schemaVersion: 2,
    id: "flow",
    name: "Flow",
    nodes: [{
      id: "http",
      type: "http",
      params: {},
      bindings: { headers: { kind: "secret", connectionId, field: "headers" } },
      position: { x: 0, y: 0 },
    }],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
  });
}

function operation(query: FakeQuery, name: string): readonly Operation[] {
  return query.operations.filter((candidate) => candidate.name === name);
}

describe("SupabaseConnectionRepository", () => {
  it("creates metadata under both access and immutable crypto ownership without returning the crypto anchor", async () => {
    const persisted = row();
    delete persisted.connection_slots;
    const fake = new FakeClient([{ table: "connections", result: result(persisted) }]);
    const repo = new SupabaseConnectionRepository(KEY, fake.client());

    const created = await repo.create("owner-a", {
      name: "Production API",
      kind: "bearer",
      publicConfig: {},
    }, 10);

    expect(created).toMatchObject({
      id: persisted.id,
      name: "Production API",
      lifecycleRevision: 1,
      slots: { test: { status: "missing" }, live: { status: "missing" } },
    });
    expect(JSON.stringify(created)).not.toMatch(/owner|crypto_owner|ciphertext|nonce|authTag/u);
    const inserted = operation(fake.queries[0]!.query, "insert")[0]?.args[0] as Record<string, unknown>;
    expect(inserted).toMatchObject({ owner_id: "owner-a", crypto_owner_id: "owner-a" });
    expect(JSON.stringify(inserted)).not.toMatch(/token|password|apiKey|ciphertext/u);
  });

  it("wipes its copied key once and terminally refuses every operation", async () => {
    const observed: boolean[] = [];
    const source = Buffer.from(KEY);
    const repo = new SupabaseConnectionRepository(source, new FakeClient().client(), {
      onKeyWiped: (zeroed) => observed.push(zeroed),
    });

    repo.close();
    repo.close();
    repo.dispose();

    expect(observed).toEqual([true]);
    expect(source).toEqual(KEY);
    await expect(repo.get("owner-a", "connection")).rejects.toBeInstanceOf(ConnectionRepositoryUnavailableError);
  });

  it("paginates with typed owner/timestamp/id filters and never uses a raw OR filter", async () => {
    const newest = row({
      id: "00000000-0000-4000-8000-000000000002",
      updated_at: 200,
    });
    const older = row({
      id: "00000000-0000-4000-8000-000000000001",
      updated_at: 100,
    });
    const fake = new FakeClient([
      { table: "connections", result: result([newest, older]) },
      { table: "connections", result: result([]) },
      { table: "connections", result: result([older]) },
    ]);
    const repo = new SupabaseConnectionRepository(KEY, fake.client());

    const first = await repo.list("owner-a", { limit: 1 });
    expect(first.items.map(({ id }) => id)).toEqual([newest.id]);
    expect(first.nextCursor).toBeTruthy();
    const second = await repo.list("owner-a", { limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.items.map(({ id }) => id)).toEqual([older.id]);

    for (const { query } of fake.queries) {
      expect(query.operations.some(({ name }) => name === "or")).toBe(false);
      expect(operation(query, "eq")).toContainEqual({ name: "eq", args: ["owner_id", "owner-a"] });
    }
    expect(operation(fake.queries[1]!.query, "eq")).toContainEqual({ name: "eq", args: ["updated_at", 200] });
    expect(operation(fake.queries[1]!.query, "lt")).toContainEqual({
      name: "lt", args: ["id", newest.id],
    });
    expect(operation(fake.queries[2]!.query, "lt")).toContainEqual({ name: "lt", args: ["updated_at", 200] });
  });

  it("renames through an owner-and-revision compare-and-swap and returns refreshed metadata", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const fake = new FakeClient([
      { table: "connections", result: result(row({ id })) },
      { table: "connections", result: result({ id }) },
      { table: "connections", result: result(row({ id, name: "Renamed", lifecycle_revision: 2, updated_at: 20 })) },
    ]);
    const repo = new SupabaseConnectionRepository(KEY, fake.client());

    const renamed = await repo.rename("owner-a", id, 1, "Renamed", 20);

    expect(renamed).toMatchObject({
      status: "updated",
      connection: { id, name: "Renamed", lifecycleRevision: 2, updatedAt: 20 },
    });
    expect(operation(fake.queries[1]!.query, "update")[0]?.args[0]).toEqual({
      name: "Renamed",
      updated_at: 20,
      lifecycle_revision: 2,
    });
    expect(operation(fake.queries[1]!.query, "eq")).toEqual([
      { name: "eq", args: ["owner_id", "owner-a"] },
      { name: "eq", args: ["id", id] },
      { name: "eq", args: ["lifecycle_revision", 1] },
    ]);
  });

  it("encrypts with the immutable crypto owner and maps the atomic configure RPC receipt", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const internal = row({
      id,
      crypto_owner_id: "anonymous-crypto-anchor",
      connection_slots: [slot({ status: "revoked", revoked_at: 20 })],
    });
    const updated = row({
      id,
      lifecycle_revision: 2,
      updated_at: 30,
      connection_slots: [slot({ secret_version: 2, updated_at: 30 })],
    });
    const fake = new FakeClient([
      { table: "connections", result: result(internal) },
      { table: "connections", result: result(updated) },
    ], [{ name: "agent_studio_configure_connection_slot", result: result("updated") }]);
    const repo = new SupabaseConnectionRepository(KEY, fake.client());

    const configured = await repo.configureSlot(
      "sb:current-owner",
      id,
      "live",
      1,
      { kind: "bearer", token: "private-configure-canary" },
      30,
    );

    expect(configured).toMatchObject({
      status: "updated",
      connection: { lifecycleRevision: 2, slots: { live: { secretVersion: 2 } } },
    });
    const args = fake.calls[0]!.args;
    expect(args).toMatchObject({
      p_owner_id: "sb:current-owner",
      p_connection_id: id,
      p_environment: "live",
      p_expected_lifecycle_revision: 1,
      p_expected_secret_version: 2,
      p_key_version: 1,
      p_now: 30,
    });
    expect(String(args.p_nonce)).toMatch(/^\\x[0-9a-f]{24}$/u);
    expect(String(args.p_auth_tag)).toMatch(/^\\x[0-9a-f]{32}$/u);
    expect(JSON.stringify(args)).not.toContain("private-configure-canary");

    const canonical = canonicalConnectionPublicConfig("bearer", {});
    const plaintext = decryptConnectionSecret({
      key: KEY,
      ownerId: "anonymous-crypto-anchor",
      connectionId: id,
      kind: "bearer",
      environment: "live",
      schemaVersion: 1,
      secretVersion: 2,
      publicConfigSha256: canonical.sha256,
      envelope: {
        keyVersion: 1,
        nonce: Buffer.from(String(args.p_nonce).slice(2), "hex"),
        ciphertext: Buffer.from(String(args.p_ciphertext).slice(2), "hex"),
        authTag: Buffer.from(String(args.p_auth_tag).slice(2), "hex"),
      },
    });
    expect(JSON.parse(plaintext.toString("utf8"))).toEqual({ kind: "bearer", token: "private-configure-canary" });
    plaintext.fill(0);
  });

  it.each(["conflict", "not-found"] as const)("maps an atomic configure %s without a follow-up read", async (status) => {
    const fake = new FakeClient([{
      table: "connections",
      result: result(row({ crypto_owner_id: "crypto-owner" })),
    }], [{ name: "agent_studio_configure_connection_slot", result: result({ status }) }]);
    const repo = new SupabaseConnectionRepository(KEY, fake.client());

    await expect(repo.configureSlot(
      "owner-a",
      "00000000-0000-4000-8000-000000000001",
      "live",
      1,
      { kind: "bearer", token: "private" },
      20,
    )).resolves.toEqual({ status });
    expect(fake.queries).toHaveLength(1);
  });

  it("maps revoke through its owner-bound CAS RPC and returns refreshed secret-free metadata", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const revoked = row({
      id,
      lifecycle_revision: 2,
      updated_at: 30,
      connection_slots: [slot({ status: "revoked", updated_at: 30, revoked_at: 30 })],
    });
    const fake = new FakeClient(
      [{ table: "connections", result: result(revoked) }],
      [{ name: "agent_studio_revoke_connection_slot", result: result([{ status: "updated" }]) }],
    );
    const repo = new SupabaseConnectionRepository(KEY, fake.client());

    const response = await repo.revokeSlot("owner-a", id, "live", 1, 30);

    expect(response).toMatchObject({
      status: "updated",
      connection: { lifecycleRevision: 2, slots: { live: { status: "revoked", revokedAt: 30 } } },
    });
    expect(fake.calls[0]).toEqual({
      name: "agent_studio_revoke_connection_slot",
      args: {
        p_owner_id: "owner-a",
        p_connection_id: id,
        p_environment: "live",
        p_expected_lifecycle_revision: 1,
        p_now: 30,
      },
    });
  });

  it("filters owner, environment, and status in SQL before decrypting with the private crypto anchor", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const canonical = canonicalConnectionPublicConfig("bearer", {});
    const envelope = encryptConnectionSecret({
      key: KEY,
      ownerId: "original-anonymous-owner",
      connectionId: id,
      kind: "bearer",
      environment: "live",
      schemaVersion: 1,
      secretVersion: 1,
      publicConfigSha256: canonical.sha256,
      plaintext: Buffer.from(JSON.stringify({ kind: "bearer", token: "private-resolve-canary" }), "utf8"),
    });
    const fake = new FakeClient([{
      table: "connection_slots",
      result: result({
        connection_id: id,
        environment: "live",
        status: "configured",
        secret_version: 1,
        key_version: 1,
        nonce: `\\x${envelope.nonce.toString("hex")}`,
        ciphertext: `\\x${envelope.ciphertext.toString("hex")}`,
        auth_tag: `\\x${envelope.authTag.toString("hex")}`,
        connections: {
          id,
          owner_id: "sb:current-owner",
          crypto_owner_id: "original-anonymous-owner",
          kind: "bearer",
          public_config: {},
          schema_version: 1,
        },
      }),
    }]);
    const repo = new SupabaseConnectionRepository(KEY, fake.client());

    await expect(repo.resolveHeaders("sb:current-owner", id, "live", "headers"))
      .resolves.toEqual({ Authorization: "Bearer private-resolve-canary" });

    const filters = operation(fake.queries[0]!.query, "eq");
    expect(filters).toEqual([
      { name: "eq", args: ["connection_id", id] },
      { name: "eq", args: ["environment", "live"] },
      { name: "eq", args: ["status", "configured"] },
      { name: "eq", args: ["connections.owner_id", "sb:current-owner"] },
    ]);
    envelope.nonce.fill(0);
    envelope.ciphertext.fill(0);
    envelope.authTag.fill(0);
  });

  it("fails closed on malformed protected rows and database errors without echoing either canary", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const malformed = new FakeClient([{
      table: "connection_slots",
      result: result({
        connection_id: id,
        environment: "live",
        status: "configured",
        secret_version: 1,
        key_version: 1,
        nonce: "private-row-canary",
        ciphertext: "\\x01",
        auth_tag: `\\x${"01".repeat(16)}`,
        connections: {
          id,
          owner_id: "owner-a",
          crypto_owner_id: "crypto-owner",
          kind: "bearer",
          public_config: {},
          schema_version: 1,
        },
      }),
    }]);
    const malformedRepo = new SupabaseConnectionRepository(KEY, malformed.client());
    let protectedFailure: unknown;
    try { await malformedRepo.resolveHeaders("owner-a", id, "live", "headers"); } catch (error) { protectedFailure = error; }
    expect(protectedFailure).toBeInstanceOf(Error);
    expect(String((protectedFailure as Error).message)).toBe("Connection secret unavailable");
    expect(JSON.stringify(protectedFailure)).not.toContain("private-row-canary");

    const failed = new FakeClient([{ table: "connections", result: failure("private-db-canary") }]);
    const failedRepo = new SupabaseConnectionRepository(KEY, failed.client());
    await expect(failedRepo.get("owner-a", id)).rejects.toMatchObject({
      message: "Connection service unavailable",
    });
  });

  it("scans only bounded usage RPC artifacts and returns an opaque resumable lower-bound receipt", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const text = graph(id);
    const fake = new FakeClient([], [{
      name: "agent_studio_connection_usage_artifacts",
      result: result({
        status: "ok",
        lifecycleRevision: 4,
        artifacts: [{
          artifactKind: "draft",
          flowId: "00000000-0000-4000-8000-000000000101",
          flowName: "Current draft",
          flowVersionId: null,
          environment: "draft",
          sortAt: 50,
          graphBytes: Buffer.byteLength(text, "utf8"),
          graph: text,
        }],
        truncated: true,
      }),
    }]);
    const repo = new SupabaseConnectionRepository(KEY, fake.client());

    const usage = await repo.usage("owner-a", id, { limit: 1 });

    expect(usage).toMatchObject({
      lifecycleRevision: 4,
      matchedLowerBound: 1,
      truncated: true,
      items: [{ artifactKind: "draft", flowId: "00000000-0000-4000-8000-000000000101", updatedAt: 50 }],
    });
    expect(usage?.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(fake.calls[0]?.args).toMatchObject({
      p_owner_id: "owner-a",
      p_connection_id: id,
      p_cursor_artifact_order: null,
      p_artifact_limit: 501,
      p_graph_byte_limit: 2 * 1024 * 1024,
      p_total_byte_limit: 16 * 1024 * 1024,
    });
  });

  it("stops before oversized usage graphs and rejects an RPC that exceeds the artifact transport cap", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const oversizedFake = new FakeClient([], [{
      name: "agent_studio_connection_usage_artifacts",
      result: result({
        status: "ok",
        lifecycleRevision: 1,
        artifacts: [{
          artifactKind: "draft",
          flowId: "00000000-0000-4000-8000-000000000101",
          flowName: "Large draft",
          flowVersionId: null,
          environment: "draft",
          sortAt: 1,
          graphBytes: 2 * 1024 * 1024 + 1,
          graph: "{}",
        }],
        truncated: false,
      }),
    }]);
    const oversizedRepo = new SupabaseConnectionRepository(KEY, oversizedFake.client());
    await expect(oversizedRepo.usage("owner-a", id, { limit: 1 })).resolves.toMatchObject({
      items: [], matchedLowerBound: 0, truncated: true,
    });

    const artifact = {
      artifactKind: "draft",
      flowId: "00000000-0000-4000-8000-000000000101",
      flowName: "Flow",
      flowVersionId: null,
      environment: "draft",
      sortAt: 1,
      graphBytes: 2,
      graph: "{}",
    };
    const excessiveFake = new FakeClient([], [{
      name: "agent_studio_connection_usage_artifacts",
      result: result({
        status: "ok",
        lifecycleRevision: 1,
        artifacts: Array.from({ length: 502 }, () => artifact),
        truncated: true,
      }),
    }]);
    const excessiveRepo = new SupabaseConnectionRepository(KEY, excessiveFake.client());
    await expect(excessiveRepo.usage("owner-a", id, { limit: 1 }))
      .rejects.toBeInstanceOf(ConnectionRepositoryUnavailableError);
  });

  it("maps absent owner rows and malformed metadata without exposing internal ownership", async () => {
    const missingId = "00000000-0000-4000-8000-000000000099";
    const absent = new FakeClient([{ table: "connections", result: result(null) }]);
    const absentRepo = new SupabaseConnectionRepository(KEY, absent.client());
    await expect(absentRepo.get("owner-a", missingId)).resolves.toBeNull();
    expect(operation(absent.queries[0]!.query, "eq")).toEqual([
      { name: "eq", args: ["owner_id", "owner-a"] },
      { name: "eq", args: ["id", missingId] },
    ]);

    const malformed = new FakeClient([{
      table: "connections",
      result: result(row({ lifecycle_revision: "private-malformed-canary", crypto_owner_id: "must-not-return" })),
    }]);
    const malformedRepo = new SupabaseConnectionRepository(KEY, malformed.client());
    await expect(malformedRepo.get("owner-a", "00000000-0000-4000-8000-000000000001"))
      .rejects.toBeInstanceOf(ConnectionRepositoryUnavailableError);
  });

  it("maps forged non-UUID identifiers before any query or RPC and rejects forged cursor UUIDs", async () => {
    const fake = new FakeClient();
    const repo = new SupabaseConnectionRepository(KEY, fake.client());

    await expect(repo.get("owner-a", "forged-id")).resolves.toBeNull();
    await expect(repo.resolveHeaders("owner-a", "forged-id", "live", "headers")).resolves.toBeNull();
    await expect(repo.usage("owner-a", "forged-id", { limit: 1 })).resolves.toBeNull();
    await expect(repo.rename("owner-a", "forged-id", 0, "Name", 0)).resolves.toEqual({ status: "not-found" });
    await expect(repo.configureSlot(
      "owner-a", "forged-id", "live", 1, { kind: "bearer", token: "private" }, 1,
    )).resolves.toEqual({ status: "not-found" });
    await expect(repo.revokeSlot("owner-a", "forged-id", "live", 1, 1))
      .resolves.toEqual({ status: "not-found" });
    expect(fake.queries).toEqual([]);
    expect(fake.calls).toEqual([]);

    const forgedListCursor = Buffer.from(JSON.stringify({ updatedAt: 1, id: "forged-id" }), "utf8").toString("base64url");
    await expect(repo.list("owner-a", { limit: 1, cursor: forgedListCursor }))
      .rejects.toBeInstanceOf(InvalidConnectionPageError);
    const forgedUsageCursor = Buffer.from(JSON.stringify({
      artifactKind: "draft",
      sortAt: 1,
      flowId: "forged-flow",
      flowVersionId: null,
      environment: "draft",
    }), "utf8").toString("base64url");
    await expect(repo.usage("owner-a", "forged-id", { limit: 1, cursor: forgedUsageCursor })).resolves.toBeNull();
    await expect(repo.usage(
      "owner-a",
      "00000000-0000-4000-8000-000000000001",
      { limit: 1, cursor: forgedUsageCursor },
    )).rejects.toBeInstanceOf(InvalidConnectionPageError);
    expect(fake.queries).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});
