import { describe, expect, it, vi } from "vitest";
import {
  UnsupportedSchemaVersionError,
  VersionClientError,
  createVersionBundle,
  createVersionClient,
} from "../src/version-client.js";

const SEMANTIC_HASH = "a".repeat(64);
const FULL_HASH = "b".repeat(64);
const OWNER_TOKEN = "workspace-key-that-must-never-escape";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: "version/one",
    flowId: "flow/opaque id",
    versionNumber: 1,
    schemaVersion: 1,
    label: "First",
    semanticHash: SEMANTIC_HASH,
    fullHash: FULL_HASH,
    createdBy: OWNER_TOKEN,
    createdAt: 1_720_000_000_000,
    dependencyCount: 1,
    ...overrides,
  };
}

function version(overrides: Record<string, unknown> = {}) {
  const { dependencyCount: _dependencyCount, ...base } = summary();
  return {
    ...base,
    description: "Immutable version",
    graph: { id: "graph-1", name: "Graph", nodes: [], edges: [] },
    dependencies: [
      {
        id: "pin-secret-db-id",
        flowVersionId: "version/one",
        kind: "connector",
        resourceId: "connector:search",
        version: "1.0.0",
        contentHash: "sha256:connector",
        createdAt: 1_720_000_000_000,
      },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("version client reads", () => {
  it("lists versions using the encoded v2 route and bearer auth", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ versions: [summary()] }));
    const client = createVersionClient({
      apiUrl: "https://agents.suedeai.ai/",
      workspaceKey: OWNER_TOKEN,
      fetch: fetchImpl,
    });

    const envelope = await client.listVersions("flow/opaque id");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://agents.suedeai.ai/api/v2/flows/flow%2Fopaque%20id/versions",
      {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${OWNER_TOKEN}`,
        },
      },
    );
    expect(envelope.versions).toHaveLength(1);
    expect(JSON.stringify(envelope)).not.toContain(OWNER_TOKEN);
    expect(envelope.versions[0]).not.toHaveProperty("createdBy");
  });

  it("gets one immutable version through encoded opaque ids", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: version() }));
    const client = createVersionClient({ apiUrl: "https://example.test", fetch: fetchImpl });

    const envelope = await client.getVersion("flow/opaque id", "version/one");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/api/v2/flows/flow%2Fopaque%20id/versions/version%2Fone",
      { method: "GET", redirect: "error", headers: { Accept: "application/json" } },
    );
    expect(envelope.version.dependencies).toEqual([
      {
        kind: "connector",
        resourceId: "connector:search",
        version: "1.0.0",
        contentHash: "sha256:connector",
      },
    ]);
    expect(JSON.stringify(envelope)).not.toContain(OWNER_TOKEN);
    expect(JSON.stringify(envelope)).not.toContain("pin-secret-db-id");
  });

  it.each([401, 404, 500])("surfaces HTTP %s without leaking request credentials", async (status) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: `server-${status}` }, status));
    const client = createVersionClient({
      apiUrl: "https://example.test",
      workspaceKey: OWNER_TOKEN,
      fetch: fetchImpl,
    });

    const error = await client.listVersions("flow-1").catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(VersionClientError);
    expect(error).toMatchObject({ status });
    expect(String(error)).toContain(`HTTP ${status}`);
    expect(String(error)).not.toContain(`server-${status}`);
    expect(String(error)).not.toContain(OWNER_TOKEN);
  });

  it("reports malformed JSON as a protocol error", async () => {
    const client = createVersionClient({
      apiUrl: "https://example.test",
      fetch: async () => new Response("not-json", { status: 200 }),
    });

    const error = await client.listVersions("flow-1").catch((candidate: unknown) => candidate);

    expect(error).toMatchObject({ name: "VersionClientError", kind: "protocol", status: 0 });
  });

  it("rejects envelopes with extra keys", async () => {
    const client = createVersionClient({
      apiUrl: "https://example.test",
      fetch: async () => jsonResponse({ versions: [summary()], surprise: true }),
    });

    await expect(client.listVersions("flow-1")).rejects.toMatchObject({ kind: "protocol" });
  });

  it("raises an explicit error for a future schema before returning data", async () => {
    const client = createVersionClient({
      apiUrl: "https://example.test",
      fetch: async () => jsonResponse({ version: version({ schemaVersion: 2 }) }),
    });

    await expect(client.getVersion("flow-1", "version-2")).rejects.toBeInstanceOf(
      UnsupportedSchemaVersionError,
    );
  });

  it.each([
    "ftp://example.test",
    "https://user:password@example.test",
    "https://example.test/#fragment",
    "https://example.test/?query=1",
    "https://example.test/base-path",
  ])("rejects the unsafe or ambiguous API URL %s", (apiUrl) => {
    expect(() => createVersionClient({ apiUrl })).toThrow(VersionClientError);
  });

  it.each(["", "   ", " workspace-key", "workspace-key ", "workspace key"])(
    "rejects the malformed workspace key %j",
    (workspaceKey) => {
      expect(() => createVersionClient({ apiUrl: "https://example.test", workspaceKey })).toThrow(
        VersionClientError,
      );
    },
  );

  it("encodes every opaque path character without changing leading hyphens", async () => {
    const opaque = "-/ ?#%雪";
    const fetchImpl = vi.fn(async () => jsonResponse({ version: version() }));
    const client = createVersionClient({ apiUrl: "https://example.test", fetch: fetchImpl });

    await client.getVersion(opaque, opaque);

    const encoded = encodeURIComponent(opaque);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://example.test/api/v2/flows/${encoded}/versions/${encoded}`,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("never reflects a server-controlled error sentinel", async () => {
    const reflected = "reflected-owner-or-token-sentinel";
    const client = createVersionClient({
      apiUrl: "https://example.test",
      fetch: async () => jsonResponse({ error: reflected }, 500),
    });

    const error = await client.listVersions("flow").catch((candidate: unknown) => candidate);

    expect(String(error)).toContain("HTTP 500");
    expect(String(error)).not.toContain(reflected);
  });

  it("canonically sorts dependency pins and rejects duplicate resource pairs", async () => {
    const unordered = [
      { kind: "skill", resourceId: "zeta", version: "2" },
      { kind: "connector", resourceId: "alpha", version: "1" },
    ];
    const sortedClient = createVersionClient({
      apiUrl: "https://example.test",
      fetch: async () => jsonResponse({ version: version({ dependencies: unordered }) }),
    });
    expect((await sortedClient.getVersion("flow", "version")).version.dependencies).toEqual([
      unordered[1],
      unordered[0],
    ]);

    const duplicateClient = createVersionClient({
      apiUrl: "https://example.test",
      fetch: async () =>
        jsonResponse({
          version: version({
            dependencies: [
              { kind: "skill", resourceId: "same", version: "1" },
              { kind: "skill", resourceId: "same", version: "2" },
            ],
          }),
        }),
    });
    await expect(duplicateClient.getVersion("flow", "version")).rejects.toMatchObject({
      kind: "protocol",
    });
  });
});

describe("portable version bundles", () => {
  it("is deterministic and omits owner tokens and persistence-only pin fields", () => {
    const raw = version();
    const client = createVersionClient({
      apiUrl: "https://example.test",
      fetch: async () => jsonResponse({ version: raw }),
    });

    return client.getVersion("flow-1", "version-1").then(({ version: portable }) => {
      const first = JSON.stringify(createVersionBundle(portable));
      const second = JSON.stringify(createVersionBundle(portable));

      expect(first).toBe(second);
      expect(JSON.parse(first)).toEqual({ bundleVersion: 1, version: portable });
      expect(first).not.toContain(OWNER_TOKEN);
      expect(first).not.toContain("createdBy");
      expect(first).not.toContain("pin-secret-db-id");
      expect(first).not.toContain("exportedAt");
    });
  });
});
