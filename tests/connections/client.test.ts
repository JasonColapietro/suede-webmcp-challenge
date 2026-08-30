import { describe, expect, it, vi } from "vitest";
import {
  ConnectionClientError,
  connectionChoices,
  createConnectionClient,
  parseClientConnectionEnvelope,
  parseClientConnectionListEnvelope,
  parseClientPrivateErrorEnvelope,
  parseClientUsageEnvelope,
  readBoundedConnectionJson,
} from "@/lib/connections/client";
import type { ConnectionView } from "@/lib/connections/types";

function view(input: {
  readonly id?: string;
  readonly name?: string;
  readonly kind?: ConnectionView["kind"];
  readonly test?: ConnectionView["slots"]["test"]["status"];
  readonly live?: ConnectionView["slots"]["live"]["status"];
} = {}): ConnectionView {
  const kind = input.kind ?? "bearer";
  const slot = (environment: "test" | "live", status: "missing" | "configured" | "revoked") => ({
    environment,
    status,
    secretVersion: status === "missing" ? 0 : 1,
    updatedAt: status === "missing" ? null : 2,
    revokedAt: status === "revoked" ? 3 : null,
  });
  return {
    id: input.id ?? "conn_1",
    name: input.name ?? "Production API",
    kind,
    publicConfig: kind === "api_key"
      ? { headerName: "X-API-Key" }
      : kind === "custom_headers"
        ? { headerNames: ["X-Custom-One", "X-Custom-Two"] }
        : {},
    lifecycleRevision: 4,
    slots: {
      test: slot("test", input.test ?? "missing"),
      live: slot("live", input.live ?? "configured"),
    },
    createdAt: 1,
    updatedAt: 2,
  };
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function escapedVariants(...values: readonly string[]): readonly string[] {
  return [...new Set(values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))];
}

describe("strict connection browser response contracts", () => {
  it("parses every exact envelope and returns deeply frozen metadata choices", () => {
    const connection = view();
    expect(parseClientConnectionEnvelope({ connection })).toEqual({ connection });
    const list = parseClientConnectionListEnvelope({
      connections: [connection, view({ id: "conn_2", name: "Revoked", test: "revoked", live: "missing" })],
      nextCursor: null,
    });
    expect(list).not.toBeNull();
    const choices = connectionChoices(list!);
    expect(choices).toEqual([
      {
        id: "conn_1", label: "Production API", kind: "bearer", lifecycleRevision: 4,
        publicHeaderNames: ["authorization"],
        slots: { test: "missing", live: "configured" },
      },
      {
        id: "conn_2", label: "Revoked", kind: "bearer", lifecycleRevision: 4,
        publicHeaderNames: ["authorization"],
        slots: { test: "revoked", live: "missing" },
      },
    ]);
    expect(Object.isFrozen(choices)).toBe(true);
    expect(Object.isFrozen(choices[0])).toBe(true);
    expect(Object.isFrozen(choices[0]?.publicHeaderNames)).toBe(true);
    expect(Object.isFrozen(choices[0]?.slots)).toBe(true);

    const headerChoices = connectionChoices(parseClientConnectionListEnvelope({
      connections: [view({ id: "conn_api", kind: "api_key" }), view({ id: "conn_custom", kind: "custom_headers" })],
      nextCursor: null,
    })!);
    expect(headerChoices.map((choice) => choice.publicHeaderNames)).toEqual([
      ["x-api-key"],
      ["x-custom-one", "x-custom-two"],
    ]);
    expect(Object.isFrozen(headerChoices[0]?.publicHeaderNames)).toBe(true);
    expect(Object.isFrozen(headerChoices[1]?.publicHeaderNames)).toBe(true);
    const reversedCustom = { ...view({ id: "conn_sorted", kind: "custom_headers" }), publicConfig: { headerNames: ["Z-Key", "a-key"] } };
    expect(connectionChoices(parseClientConnectionListEnvelope({ connections: [reversedCustom], nextCursor: null })!)[0]?.publicHeaderNames)
      .toEqual(["a-key", "z-key"]);
    expect(parseClientUsageEnvelope({
      usage: [{
        artifactKind: "draft", flowId: "flow 1", flowName: "Draft", flowVersionId: null,
        environment: "draft", updatedAt: 2,
      }],
      nextCursor: null,
      matchedLowerBound: 1,
      truncated: false,
      lifecycleRevision: 4,
    })).not.toBeNull();
    expect(parseClientPrivateErrorEnvelope({ error: "conflict" })).toEqual({ error: "conflict" });
  });

  it("rejects extra keys, hostile accessors, and recursive secret-shaped keys or values", () => {
    expect(parseClientConnectionEnvelope({ connection: view(), extra: true })).toBeNull();
    expect(parseClientUsageEnvelope({
      usage: [], nextCursor: null, matchedLowerBound: 0, truncated: false, lifecycleRevision: 1, token: "private",
    })).toBeNull();
    expect(parseClientConnectionEnvelope({ connection: view({ name: "Bearer private-token" }) })).toBeNull();
    expect(parseClientPrivateErrorEnvelope({ error: "conflict", password: "private" })).toBeNull();

    let invoked = false;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "connection", {
      enumerable: true,
      get() { invoked = true; return view(); },
    });
    expect(parseClientConnectionEnvelope(hostile)).toBeNull();
    expect(invoked).toBe(false);
  });

  it("bounds raw JSON bytes, depth, and value count before envelope parsing", async () => {
    expect(await readBoundedConnectionJson(json({ ok: true }))).toEqual({ ok: true });
    expect(await readBoundedConnectionJson(json({ ok: true }, 200, { "content-length": "262145" }))).toBeNull();

    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 34; index += 1) deep = { nested: deep };
    expect(await readBoundedConnectionJson(json(deep))).toBeNull();

    const many = { valuesById: Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`item_${index}`, index])) };
    expect(await readBoundedConnectionJson(json(many))).toBeNull();
    expect(await readBoundedConnectionJson(json({ nested: { apiKey: "private" } }))).toBeNull();
    expect(await readBoundedConnectionJson(json({ label: "Basic dXNlcjpwYXNz" }))).toBeNull();
  });

  it("detects credential signatures at safe boundaries anywhere and accepts near misses", async () => {
    for (const value of [
      "prefix Bearer opaque-token suffix",
      "wrapped (Basic dXNlcjpwYXNz) value",
      "prefix sk_live_1234567890abcdef suffix",
      "prefix pk_test_1234567890abcdef suffix",
      "prefix ghp_1234567890abcdefghijkl suffix",
      "prefix xoxb-1234567890-abcdef suffix",
      "prefix -----BEGIN PRIVATE KEY----- suffix",
    ]) {
      expect(await readBoundedConnectionJson(json({ label: value }))).toBeNull();
    }
    for (const value of [
      "NotBearer opaque-token",
      "Basicly dXNlcjpwYXNz",
      "task_sketch_is_not_a_key",
      "pk context",
      "ghp-short",
      "xoxbow",
      "-----BEGIN PUBLIC NOTE-----",
    ]) {
      expect(await readBoundedConnectionJson(json({ label: value }))).toEqual({ label: value });
    }
  });

  it("rejects request-local canaries recursively in allowed strings and property names", async () => {
    const canary = "arbitrary-request-local-canary";
    for (const value of [
      { name: `prefix-${canary}-suffix` },
      { flowName: canary },
      { error: `before ${canary} after` },
      { nested: { [`prefix-${canary}-suffix`]: "otherwise safe" } },
    ]) {
      expect(await readBoundedConnectionJson(json(value), undefined, [canary])).toBeNull();
    }
    expect(await readBoundedConnectionJson(json({ name: "safe" }), undefined, [canary]))
      .toEqual({ name: "safe" });
  });

  it("rejects literal JSON-escaped canaries in generic response keys while allowing near misses", async () => {
    const raw = "generic-\"quote\\slash-canary";
    const escaped = JSON.stringify(raw).slice(1, -1);
    expect(escaped).not.toBe(raw);
    expect(await readBoundedConnectionJson(
      json({ [`prefix-${escaped}-suffix`]: "otherwise safe" }),
      undefined,
      escapedVariants(raw),
    )).toBeNull();
    const nearMiss = escaped.replace("canary", "near-miss");
    expect(await readBoundedConnectionJson(
      json({ [`prefix-${nearMiss}-suffix`]: "otherwise safe" }),
      undefined,
      escapedVariants(raw),
    )).toEqual({ [`prefix-${nearMiss}-suffix`]: "otherwise safe" });
  });
});

describe("same-origin connection browser client", () => {
  it("fetches all metadata envelopes with relative no-store requests and validated page kinds", async () => {
    const responses = [
      json({ connections: [view()], nextCursor: null }),
      json({ connection: view() }),
      json({ connection: view() }, 201),
      json({ connection: view({ name: "Renamed" }) }),
      json({ connection: view({ test: "configured" }) }, 201),
      json({ connection: view({ live: "revoked" }) }),
      json({ usage: [], nextCursor: null, matchedLowerBound: 0, truncated: false, lifecycleRevision: 4 }),
    ];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url.startsWith("/api/v2/connections")).toBe(true);
      expect(url.startsWith("http://") || url.startsWith("https://") || url.startsWith("//")).toBe(false);
      expect(init?.cache).toBe("no-store");
      expect(init?.credentials).toBe("same-origin");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return responses.shift()!;
    });
    const client = createConnectionClient(fetcher);

    expect((await client.list({ limit: 50 })).connections).toHaveLength(1);
    expect((await client.get("conn_1")).connection.id).toBe("conn_1");
    expect((await client.create({ name: "Production API", kind: "bearer", publicConfig: {} })).connection.kind).toBe("bearer");
    expect((await client.rename("conn_1", { name: "Renamed", expectedLifecycleRevision: 4 })).connection.name).toBe("Renamed");
    expect((await client.configureSlot("conn_1", "test", {
      expectedLifecycleRevision: 4,
      secret: { kind: "bearer", token: "submitted-only" },
    })).connection.slots.test.status).toBe("configured");
    expect((await client.revokeSlot("conn_1", "live", { expectedLifecycleRevision: 4 })).connection.slots.live.status).toBe("revoked");
    expect((await client.usage("conn_1", { limit: 50 })).lifecycleRevision).toBe(4);
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it("returns exact private errors and rejects mismatched or malformed error receipts", async () => {
    const conflict = createConnectionClient(vi.fn(async () => json({ error: "conflict" }, 409)));
    await expect(conflict.get("conn_1")).rejects.toMatchObject({
      name: "ConnectionClientError", status: 409, error: "conflict",
    });
    expect(await conflict.get("conn_1").catch((error: unknown) => error)).toBeInstanceOf(ConnectionClientError);

    const mismatch = createConnectionClient(vi.fn(async () => json({ error: "not found" }, 409)));
    await expect(mismatch.get("conn_1")).rejects.toMatchObject({ status: 0, error: "connection service unavailable" });
    const malformed = createConnectionClient(vi.fn(async () => json({ error: "conflict", detail: "private" }, 409)));
    await expect(malformed.get("conn_1")).rejects.toMatchObject({ status: 0, error: "connection service unavailable" });
  });

  it("refuses invalid list and usage cursors before fetch and never touches browser persistence", async () => {
    const fetcher = vi.fn();
    const localSet = vi.fn();
    const sessionSet = vi.fn();
    vi.stubGlobal("localStorage", { setItem: localSet });
    vi.stubGlobal("sessionStorage", { setItem: sessionSet });
    const client = createConnectionClient(fetcher);
    await expect(client.list({ limit: 50, cursor: "not-a-canonical-list-cursor" }))
      .rejects.toMatchObject({ status: 400, error: "invalid request" });
    await expect(client.usage("conn_1", { limit: 50, cursor: "not-a-canonical-usage-cursor" }))
      .rejects.toMatchObject({ status: 400, error: "invalid request" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects exact or embedded request-local echoes for every submitted secret string", async () => {
    const cases = [
      {
        kind: "api_key" as const,
        input: { kind: "api_key" as const, apiKey: "crimson-\"orbit\\api-canary" },
        echoes: escapedVariants("crimson-\"orbit\\api-canary"),
      },
      {
        kind: "bearer" as const,
        input: { kind: "bearer" as const, token: "violet-\"river\\bearer-canary" },
        echoes: escapedVariants("violet-\"river\\bearer-canary"),
      },
      {
        kind: "basic" as const,
        input: {
          kind: "basic" as const,
          username: "basic-\"user\\canary",
          password: "basic-\"password\\canary",
        },
        echoes: escapedVariants("basic-\"user\\canary", "basic-\"password\\canary"),
      },
      {
        kind: "custom_headers" as const,
        input: {
          kind: "custom_headers" as const,
          values: {
            "X-Custom-One": "custom-\"one\\canary",
            "X-Custom-Two": "custom-\"two\\canary",
          },
        },
        echoes: escapedVariants("custom-\"one\\canary", "custom-\"two\\canary"),
      },
    ];
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const localSet = vi.fn();
    const sessionSet = vi.fn();
    vi.stubGlobal("localStorage", { setItem: localSet });
    vi.stubGlobal("sessionStorage", { setItem: sessionSet });
    try {
      for (const candidate of cases) {
        for (const echo of candidate.echoes) {
          const fetcher = vi.fn(async () => json({
            connection: view({ kind: candidate.kind, name: `prefix-${echo}-suffix` }),
          }));
          const client = createConnectionClient(fetcher);
          await expect(client.configureSlot("conn_1", "live", {
            expectedLifecycleRevision: 4,
            secret: candidate.input,
          })).rejects.toMatchObject({ status: 0, error: "connection service unavailable" });
        }
      }
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      expect(localSet).not.toHaveBeenCalled();
      expect(sessionSet).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
      consoleError.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
