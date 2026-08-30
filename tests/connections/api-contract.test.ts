import { describe, expect, it, vi } from "vitest";
import {
  CONNECTION_API_STATUS,
  CONNECTION_BODY_LIMIT_BYTES,
  PRIVATE_ERROR_STATUS,
  parseConfigureSlotBody,
  parseConnectionEnvelope,
  parseConnectionEnvironmentPath,
  parseConnectionListEnvelope,
  parseConnectionListPage,
  parseCreateBody,
  parsePrivateErrorEnvelope,
  parseRenameBody,
  parseUsageEnvelope,
  preflightConnectionMutation,
  preflightConnectionRead,
} from "@/lib/connections/api-contract";
import type { ConnectionView } from "@/lib/connections/types";

const connection = Object.freeze({
  id: "conn_1",
  name: "API",
  kind: "bearer" as const,
  publicConfig: Object.freeze(Object.create(null) as Record<string, never>),
  lifecycleRevision: 2,
  slots: Object.freeze({
    test: Object.freeze({ environment: "test" as const, status: "missing" as const, secretVersion: 0, updatedAt: null, revokedAt: null }),
    live: Object.freeze({ environment: "live" as const, status: "configured" as const, secretVersion: 1, updatedAt: 2, revokedAt: null }),
  }),
  createdAt: 1,
  updatedAt: 2,
}) satisfies ConnectionView;

const mutationHeaders = {
  "content-type": "application/json; charset=utf-8",
  origin: "https://studio.test",
  "sec-fetch-site": "same-origin",
};

function mutationRequest(body: BodyInit, headers: HeadersInit = mutationHeaders): Request {
  return new Request("https://studio.test/api/v2/connections", {
    method: "POST",
    headers,
    body,
  });
}

class BodyObservedRequest extends Request {
  bodyReads = 0;

  override get body(): Request["body"] {
    this.bodyReads += 1;
    return super.body;
  }
}

class ThrowingBodyRequest extends Request {
  override get body(): Request["body"] {
    throw new Error("must-not-escape-body-getter");
  }
}

function observedMutationRequest(body: BodyInit): BodyObservedRequest {
  return new BodyObservedRequest("https://studio.test/api/v2/connections", {
    method: "POST",
    headers: mutationHeaders,
    body,
  });
}

function cursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const LIST_CURSOR = cursor({ updatedAt: 2, id: "conn_1" });
const USAGE_CURSOR = cursor({
  artifactKind: "active_deployment",
  sortAt: 2,
  flowId: "flow_1",
  flowVersionId: "version_1",
  environment: "live",
});
const LEGACY_USAGE_CURSOR = cursor({
  artifactKind: "active_deployment",
  sortAt: 2,
  flowId: "flow with space",
  flowVersionId: "version with space",
  environment: "test",
});
const ASTRAL_USAGE_ID = "😀".repeat(256);
const ASTRAL_USAGE_CURSOR = cursor({
  artifactKind: "active_deployment",
  sortAt: 2,
  flowId: ASTRAL_USAGE_ID,
  flowVersionId: ASTRAL_USAGE_ID,
  environment: "live",
});

describe("connection API body and path contracts", () => {
  it("parses exact bounded create, rename, configure, environment, and page inputs", () => {
    expect(parseCreateBody({ name: "API", kind: "bearer", publicConfig: {} })).toEqual({
      name: "API", kind: "bearer", publicConfig: {},
    });
    expect(parseRenameBody({ name: "Renamed", expectedLifecycleRevision: 3 })).toEqual({
      name: "Renamed", expectedLifecycleRevision: 3,
    });
    expect(parseConfigureSlotBody({
      expectedLifecycleRevision: 3,
      secret: { kind: "bearer", token: "private" },
    })).toEqual({ expectedLifecycleRevision: 3, secret: { kind: "bearer", token: "private" } });
    expect(parseConnectionEnvironmentPath("test")).toBe("test");
    expect(parseConnectionEnvironmentPath("live")).toBe("live");
    expect(parseConnectionListPage(new URLSearchParams(), "list")).toEqual({ limit: 50 });
    expect(parseConnectionListPage(new URLSearchParams(`limit=100&cursor=${LIST_CURSOR}`), "list")).toEqual({
      limit: 100, cursor: LIST_CURSOR,
    });
    expect(parseConnectionListPage(new URLSearchParams(`cursor=${USAGE_CURSOR}`), "usage")).toEqual({
      limit: 50, cursor: USAGE_CURSOR,
    });
    expect(parseConnectionListPage(new URLSearchParams(`cursor=${LEGACY_USAGE_CURSOR}`), "usage")).toEqual({
      limit: 50, cursor: LEGACY_USAGE_CURSOR,
    });
    expect(ASTRAL_USAGE_CURSOR.length).toBeLessThanOrEqual(4_096);
    expect(parseConnectionListPage(new URLSearchParams(`cursor=${ASTRAL_USAGE_CURSOR}`), "usage")).toEqual({
      limit: 50, cursor: ASTRAL_USAGE_CURSOR,
    });
  });

  it("rejects extra keys, invalid receipts, environments, cursors, and limits", () => {
    expect(parseCreateBody({ name: "API", kind: "bearer", publicConfig: {}, extra: true })).toBeNull();
    expect(parseRenameBody({ name: "x", expectedLifecycleRevision: 0 })).toBeNull();
    expect(parseRenameBody({ name: "x", expectedLifecycleRevision: 1, secret: "x" })).toBeNull();
    expect(parseConfigureSlotBody({ expectedLifecycleRevision: 1, secret: { kind: "bearer", token: "" } })).toBeNull();
    expect(parseConnectionEnvironmentPath("preview")).toBeNull();
    for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=50&limit=51", "cursor=not+base64", `cursor=${"a".repeat(4097)}`]) {
      expect(parseConnectionListPage(new URLSearchParams(query), "list")).toBeNull();
    }
    for (const candidate of [
      "a",
      cursor({ id: "conn_1", updatedAt: 2 }),
      cursor({ updatedAt: "2", id: "conn_1" }),
      cursor({ updatedAt: 2, id: "conn_1", extra: true }),
      cursor({ updatedAt: 2, id: "conn with space" }),
      Buffer.from('{"updatedAt":2, "id":"conn_1"}', "utf8").toString("base64url"),
    ]) expect(parseConnectionListPage(new URLSearchParams(`cursor=${candidate}`), "list")).toBeNull();
    for (const candidate of [
      LIST_CURSOR,
      cursor({ artifactKind: "draft", sortAt: 2, flowId: "flow_1", flowVersionId: null, environment: "live" }),
      cursor({ artifactKind: "active_deployment", sortAt: 2, flowId: "flow_1", flowVersionId: null, environment: "live" }),
      cursor({ artifactKind: "active_deployment", sortAt: 2, flowId: "flow_1", flowVersionId: "version_1", environment: "draft" }),
      cursor({ artifactKind: "active_deployment", sortAt: 2, flowId: "", flowVersionId: "version_1", environment: "live" }),
      cursor({ artifactKind: "active_deployment", sortAt: 2, flowId: "flow_1", flowVersionId: "v".repeat(257), environment: "live" }),
      cursor({ artifactKind: "active_deployment", sortAt: 2, flowId: "😀".repeat(257), flowVersionId: "version_1", environment: "live" }),
    ]) expect(parseConnectionListPage(new URLSearchParams(`cursor=${candidate}`), "usage")).toBeNull();
  });

  it("exports the exact success and fixed private error status map", () => {
    expect(CONNECTION_API_STATUS).toEqual({
      create: 201,
      firstSlotConfigure: 201,
      list: 200,
      get: 200,
      rename: 200,
      rotate: 200,
      reconfigure: 200,
      revoke: 200,
      usage: 200,
    });
    expect(PRIVATE_ERROR_STATUS).toEqual({
      "invalid request": 400,
      "authentication required": 401,
      "not found": 404,
      conflict: 409,
      "payload too large": 413,
      "unsupported media type": 415,
      "connection service unavailable": 503,
    });
  });
});

describe("connection mutation preflight ordering", () => {
  it("refuses media, encoding, Authorization, and browser-origin failures before identity", async () => {
    const invalidHeaders: Array<Record<string, string>> = [
      { ...mutationHeaders, "content-type": "text/plain" },
      { ...mutationHeaders, "content-encoding": "gzip" },
      { ...mutationHeaders, authorization: "Bearer forbidden" },
      { ...mutationHeaders, origin: "https://evil.test" },
      { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      { "content-type": "application/json", origin: "https://studio.test" },
      { ...mutationHeaders, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of invalidHeaders) {
      const resolveOwner = vi.fn(async () => "owner");
      const resolveProvider = vi.fn(async () => ({ repository: true }));
      const result = await preflightConnectionMutation({
        request: mutationRequest("{}", headers),
        resolveOwner,
        resolveProvider,
        parseBody: () => ({}),
      });
      expect(result.ok).toBe(false);
      expect(resolveOwner).not.toHaveBeenCalled();
      expect(resolveProvider).not.toHaveBeenCalled();
    }
  });

  it("orders valid headers, owner, provider, body read, and body parse", async () => {
    const order: string[] = [];
    const request = observedMutationRequest('{"name":"ok"}');
    const result = await preflightConnectionMutation({
      request,
      resolveOwner: async () => { order.push("owner"); return "owner_1"; },
      resolveProvider: async () => { order.push("provider"); return { repository: true }; },
      parseBody: (value) => { order.push("parse"); return value; },
    });
    expect(result).toMatchObject({ ok: true, ownerId: "owner_1", body: { name: "ok" } });
    expect(order).toEqual(["owner", "provider", "parse"]);
    expect(request.bodyReads).toBe(1);
  });

  it("maps authentication and provider failures before reading or parsing the body", async () => {
    const parseBody = vi.fn(() => ({ parsed: true }));
    const authRequest = observedMutationRequest("not-json");
    const auth = await preflightConnectionMutation({
      request: authRequest,
      resolveOwner: async () => null,
      resolveProvider: vi.fn(async () => ({ repository: true })),
      parseBody,
    });
    expect(auth).toEqual({ ok: false, status: 401, error: { error: "authentication required" } });
    expect(parseBody).not.toHaveBeenCalled();
    expect(authRequest.bodyReads).toBe(0);

    const unavailableRequest = observedMutationRequest("not-json");
    const unavailable = await preflightConnectionMutation({
      request: unavailableRequest,
      resolveOwner: async () => "owner_1",
      resolveProvider: async () => null,
      parseBody,
    });
    expect(unavailable).toEqual({ ok: false, status: 503, error: { error: "connection service unavailable" } });
    expect(parseBody).not.toHaveBeenCalled();
    expect(unavailableRequest.bodyReads).toBe(0);
  });

  it("enforces the 64 KiB encoded body limit before JSON parsing", async () => {
    const parseBody = vi.fn((value) => value);
    const oversized = JSON.stringify({ value: "x".repeat(CONNECTION_BODY_LIMIT_BYTES) });
    const result = await preflightConnectionMutation({
      request: mutationRequest(oversized),
      resolveOwner: async () => "owner_1",
      resolveProvider: async () => ({ repository: true }),
      parseBody,
    });
    expect(result).toEqual({ ok: false, status: 413, error: { error: "payload too large" } });
    expect(parseBody).not.toHaveBeenCalled();
  });

  it("maps locked or throwing request bodies to one fixed 400 after owner and provider preflight", async () => {
    const locked = mutationRequest("{}");
    const heldReader = locked.body!.getReader();
    const parseBody = vi.fn((value) => value);
    try {
      await expect(preflightConnectionMutation({
        request: locked,
        resolveOwner: async () => "owner_1",
        resolveProvider: async () => ({ repository: true }),
        parseBody,
      })).resolves.toEqual({ ok: false, status: 400, error: { error: "invalid request" } });
    } finally {
      heldReader.releaseLock();
    }
    expect(parseBody).not.toHaveBeenCalled();

    const throwing = new ThrowingBodyRequest("https://studio.test/api/v2/connections", {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    await expect(preflightConnectionMutation({
      request: throwing,
      resolveOwner: async () => "owner_1",
      resolveProvider: async () => ({ repository: true }),
      parseBody,
    })).resolves.toEqual({ ok: false, status: 400, error: { error: "invalid request" } });
  });

  it("accepts only the two exact JSON media types and absent/identity encoding", async () => {
    for (const contentType of ["application/json", "application/json; charset=utf-8"] as const) {
      for (const encoding of [undefined, "identity"] as const) {
        const headers: Record<string, string> = { ...mutationHeaders, "content-type": contentType };
        if (encoding) headers["content-encoding"] = encoding;
        const result = await preflightConnectionMutation({
          request: mutationRequest("{}", headers),
          resolveOwner: async () => "owner_1",
          resolveProvider: async () => ({ repository: true }),
          parseBody: (value) => value,
        });
        expect(result.ok).toBe(true);
      }
    }
  });
});

describe("connection read preflight", () => {
  it("allows absent Origin and Sec-Fetch-Site but validates either when present", async () => {
    const absent = await preflightConnectionRead({
      request: new Request("https://studio.test/api/v2/connections"),
      resolveOwner: async () => "owner_1",
      resolveProvider: async () => ({ repository: true }),
    });
    expect(absent.ok).toBe(true);

    const invalidHeaders: Array<Record<string, string>> = [
      { origin: "https://evil.test" },
      { "sec-fetch-site": "cross-site" },
      { authorization: "Bearer forbidden" },
    ];
    for (const headers of invalidHeaders) {
      const resolveOwner = vi.fn(async () => "owner_1");
      const result = await preflightConnectionRead({
        request: new Request("https://studio.test/api/v2/connections", { headers }),
        resolveOwner,
        resolveProvider: async () => ({ repository: true }),
      });
      expect(result.ok).toBe(false);
      expect(resolveOwner).not.toHaveBeenCalled();
    }
  });
});

describe("exact secret-free response parsers", () => {
  it("accepts only exact connection, list, usage, and private error envelopes", () => {
    expect(parseConnectionEnvelope({ connection })).toEqual({ connection });
    expect(parseConnectionListEnvelope({ connections: [connection], nextCursor: LIST_CURSOR })).toEqual({
      connections: [connection], nextCursor: LIST_CURSOR,
    });
    expect(parseUsageEnvelope({
      usage: [{
        artifactKind: "draft",
        flowId: "flow_1",
        flowName: "Draft",
        flowVersionId: null,
        environment: "draft",
        updatedAt: 2,
      }],
      nextCursor: USAGE_CURSOR,
      matchedLowerBound: 1,
      truncated: false,
      lifecycleRevision: 2,
    })).not.toBeNull();
    expect(parseUsageEnvelope({
      usage: [], nextCursor: LEGACY_USAGE_CURSOR, matchedLowerBound: 0, truncated: true, lifecycleRevision: 2,
    })).toEqual({
      usage: [], nextCursor: LEGACY_USAGE_CURSOR, matchedLowerBound: 0, truncated: true, lifecycleRevision: 2,
    });
    expect(parseUsageEnvelope({
      usage: [{
        artifactKind: "active_deployment",
        flowId: ASTRAL_USAGE_ID,
        flowName: "Astral",
        flowVersionId: ASTRAL_USAGE_ID,
        environment: "live",
        updatedAt: 2,
      }],
      nextCursor: ASTRAL_USAGE_CURSOR,
      matchedLowerBound: 1,
      truncated: true,
      lifecycleRevision: 2,
    })).toEqual({
      usage: [{
        artifactKind: "active_deployment",
        flowId: ASTRAL_USAGE_ID,
        flowName: "Astral",
        flowVersionId: ASTRAL_USAGE_ID,
        environment: "live",
        updatedAt: 2,
      }],
      nextCursor: ASTRAL_USAGE_CURSOR,
      matchedLowerBound: 1,
      truncated: true,
      lifecycleRevision: 2,
    });
    expect(parsePrivateErrorEnvelope({ error: "not found" })).toEqual({ error: "not found" });
  });

  it("accepts the full persisted 200-byte flow-name boundary in usage responses", () => {
    const envelope = (flowName: string) => ({
      usage: [{
        artifactKind: "draft",
        flowId: "flow_1",
        flowName,
        flowVersionId: null,
        environment: "draft",
        updatedAt: 2,
      }],
      nextCursor: null,
      matchedLowerBound: 1,
      truncated: false,
      lifecycleRevision: 2,
    });

    expect(parseUsageEnvelope(envelope("é".repeat(100)))).not.toBeNull();
    expect(parseUsageEnvelope(envelope(`${"é".repeat(100)}x`))).toBeNull();
  });

  it("rejects extra keys, malformed cursors, inconsistent usage, and recursive secret keys", () => {
    expect(parseConnectionEnvelope({ connection, extra: true })).toBeNull();
    expect(parseConnectionListEnvelope({ connections: [connection], nextCursor: "not+base64" })).toBeNull();
    expect(parseConnectionListEnvelope({ connections: [connection], nextCursor: USAGE_CURSOR })).toBeNull();
    expect(parseUsageEnvelope({
      usage: [{ artifactKind: "draft", flowId: "f", flowName: "F", flowVersionId: "v", environment: "live", updatedAt: 1 }],
      nextCursor: null, matchedLowerBound: 1, truncated: false, lifecycleRevision: 1,
    })).toBeNull();
    expect(parseUsageEnvelope({
      usage: [], nextCursor: LIST_CURSOR, matchedLowerBound: 0, truncated: true, lifecycleRevision: 1,
    })).toBeNull();
    expect(parsePrivateErrorEnvelope({ error: "internal details" })).toBeNull();
    expect(parseConnectionEnvelope({
      connection: { ...connection, publicConfig: { token: "do-not-echo" } },
    })).toBeNull();
    expect(parseConnectionEnvelope({
      connection: { ...connection, publicConfig: { Token: "do-not-echo" } },
    })).toBeNull();
    expect(parseUsageEnvelope({
      usage: [{ artifactKind: "draft", flowId: "f", flowName: "F", flowVersionId: null, environment: "draft", updatedAt: 1, nested: { password: "do-not-echo" } }],
      nextCursor: null, matchedLowerBound: 1, truncated: false, lifecycleRevision: 1,
    })).toBeNull();
    const sparse = [connection];
    sparse.length = 2;
    expect(parseConnectionListEnvelope({ connections: sparse, nextCursor: null })).toBeNull();
  });

  it("does not invoke hostile response accessors during recursive secret rejection", () => {
    const getter = vi.fn(() => "do-not-run");
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "connection", { enumerable: true, get: getter });
    expect(parseConnectionEnvelope(hostile)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});
