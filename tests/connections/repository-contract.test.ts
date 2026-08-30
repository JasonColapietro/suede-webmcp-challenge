import { describe, expect, it } from "vitest";
import type {
  ConnectionListResult,
  ConnectionRepository,
  ConnectionUsageResult,
  MutationResult,
} from "@/lib/connections/repository";
import type {
  ConnectionCreateInput,
  ConnectionEnvironment,
  ConnectionSecretInput,
  ConnectionView,
} from "@/lib/connections/types";

const slot = (environment: ConnectionEnvironment) => ({
  environment,
  status: "missing" as const,
  secretVersion: 0,
  updatedAt: null,
  revokedAt: null,
});

function view(overrides: Partial<ConnectionView> = {}): ConnectionView {
  return Object.freeze({
    id: "connection-1",
    name: "Example",
    kind: "bearer" as const,
    publicConfig: Object.freeze(Object.create(null) as Record<string, never>),
    lifecycleRevision: 1,
    slots: Object.freeze({ test: Object.freeze(slot("test")), live: Object.freeze(slot("live")) }),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

/** A deliberately small fake proving the public contract can enforce receipts. */
class ContractRepository implements ConnectionRepository {
  current = view();
  owner = "owner-a";

  async create(_ownerId: string, _input: ConnectionCreateInput, _now: number): Promise<ConnectionView> {
    return this.current;
  }

  async list(ownerId: string, _page: { cursor?: string; limit: number }): Promise<ConnectionListResult> {
    return { items: ownerId === this.owner ? [this.current] : [], nextCursor: null };
  }

  async get(ownerId: string, connectionId: string): Promise<ConnectionView | null> {
    return ownerId === this.owner && connectionId === this.current.id ? this.current : null;
  }

  async rename(
    ownerId: string,
    connectionId: string,
    expectedLifecycleRevision: number,
    name: string,
    now: number,
  ): Promise<MutationResult> {
    if (ownerId !== this.owner || connectionId !== this.current.id) return { status: "not-found" };
    if (expectedLifecycleRevision !== this.current.lifecycleRevision) return { status: "conflict" };
    this.current = view({ ...this.current, name, updatedAt: now, lifecycleRevision: expectedLifecycleRevision + 1 });
    return { status: "updated", connection: this.current };
  }

  async configureSlot(
    ownerId: string,
    connectionId: string,
    environment: ConnectionEnvironment,
    expectedLifecycleRevision: number,
    _secret: ConnectionSecretInput,
    now: number,
  ): Promise<MutationResult> {
    if (ownerId !== this.owner || connectionId !== this.current.id) return { status: "not-found" };
    if (expectedLifecycleRevision !== this.current.lifecycleRevision) return { status: "conflict" };
    const previous = this.current.slots[environment];
    const nextSlot = Object.freeze({
      environment,
      status: "configured" as const,
      secretVersion: previous.secretVersion + 1,
      updatedAt: now,
      revokedAt: null,
    });
    this.current = view({
      ...this.current,
      lifecycleRevision: expectedLifecycleRevision + 1,
      updatedAt: now,
      slots: Object.freeze({ ...this.current.slots, [environment]: nextSlot }),
    });
    return { status: "updated", connection: this.current };
  }

  async revokeSlot(
    ownerId: string,
    connectionId: string,
    environment: ConnectionEnvironment,
    expectedLifecycleRevision: number,
    now: number,
  ): Promise<MutationResult> {
    if (ownerId !== this.owner || connectionId !== this.current.id) return { status: "not-found" };
    if (expectedLifecycleRevision !== this.current.lifecycleRevision) return { status: "conflict" };
    const previous = this.current.slots[environment];
    const nextSlot = Object.freeze({ ...previous, status: "revoked" as const, updatedAt: now, revokedAt: now });
    this.current = view({
      ...this.current,
      lifecycleRevision: expectedLifecycleRevision + 1,
      updatedAt: now,
      slots: Object.freeze({ ...this.current.slots, [environment]: nextSlot }),
    });
    return { status: "updated", connection: this.current };
  }

  async resolveHeaders(
    ownerId: string,
    connectionId: string,
    environment: ConnectionEnvironment,
    _field: "headers",
  ): Promise<Readonly<Record<string, string>> | null> {
    if (ownerId !== this.owner || connectionId !== this.current.id) return null;
    return this.current.slots[environment].status === "configured"
      ? Object.freeze({ Authorization: "Bearer private" })
      : null;
  }

  async usage(
    ownerId: string,
    connectionId: string,
    _page: { cursor?: string; limit: number },
  ): Promise<ConnectionUsageResult | null> {
    if (ownerId !== this.owner || connectionId !== this.current.id) return null;
    return {
      items: Object.freeze([{
        artifactKind: "draft",
        flowId: "flow-1",
        flowName: "Draft",
        flowVersionId: null,
        environment: "draft",
        updatedAt: 1,
      }]),
      nextCursor: "more-artifacts",
      matchedLowerBound: 1,
      truncated: true,
      lifecycleRevision: this.current.lifecycleRevision,
    };
  }
}

function serializedKeys(value: unknown): readonly string[] {
  const keys = new Set<string>();
  JSON.stringify(value, (key, item) => {
    if (key) keys.add(key);
    return item;
  });
  return [...keys].sort();
}

describe("ConnectionRepository contract", () => {
  it("makes foreign and missing resources indistinguishable before resolution", async () => {
    const repo = new ContractRepository();
    expect(await repo.get("owner-b", repo.current.id)).toBeNull();
    expect(await repo.get("owner-a", "missing")).toBeNull();
    expect(await repo.resolveHeaders("owner-b", repo.current.id, "live", "headers")).toBeNull();
    expect(await repo.resolveHeaders("owner-a", "missing", "live", "headers")).toBeNull();
  });

  it("uses a monotonic receipt even when mutation timestamps collide", async () => {
    const repo = new ContractRepository();
    const first = await repo.rename(repo.owner, repo.current.id, 1, "First", 10);
    expect(first.status).toBe("updated");
    const stale = await repo.rename(repo.owner, repo.current.id, 1, "Stale", 10);
    expect(stale).toEqual({ status: "conflict" });
    expect(repo.current).toMatchObject({ name: "First", lifecycleRevision: 2, updatedAt: 10 });
  });

  it("keeps Test and Live slot transitions independent", async () => {
    const repo = new ContractRepository();
    const configured = await repo.configureSlot(
      repo.owner,
      repo.current.id,
      "test",
      1,
      { kind: "bearer", token: "private" },
      20,
    );
    expect(configured.status).toBe("updated");
    expect(repo.current.slots.test.status).toBe("configured");
    expect(repo.current.slots.live.status).toBe("missing");
    expect(await repo.resolveHeaders(repo.owner, repo.current.id, "live", "headers")).toBeNull();
  });

  it("labels incomplete usage as an observed lower bound tied to a lifecycle receipt", async () => {
    const repo = new ContractRepository();
    const result = await repo.usage(repo.owner, repo.current.id, { limit: 1 });
    expect(result).toMatchObject({ matchedLowerBound: 1, truncated: true, lifecycleRevision: 1 });
    expect(result?.nextCursor).toBeTruthy();
    expect(result?.items).toHaveLength(1);
  });

  it("keeps metadata results free of secret and encrypted-row fields", async () => {
    const repo = new ContractRepository();
    const results = [
      await repo.list(repo.owner, { limit: 20 }),
      await repo.get(repo.owner, repo.current.id),
      await repo.usage(repo.owner, repo.current.id, { limit: 20 }),
    ];
    const forbidden = new Set([
      "apiKey", "token", "username", "password", "values",
      "ciphertext", "nonce", "authTag", "keyVersion",
    ]);
    for (const key of results.flatMap(serializedKeys)) expect(forbidden.has(key), key).toBe(false);
  });
});
