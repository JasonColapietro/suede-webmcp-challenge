import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorReadinessClientError,
  createConnectorReadinessClient,
  parseClientConnectorReadinessEnvelope,
} from "@/lib/connectors/readiness-client";

const ID = "00000000-0000-4000-8000-000000000001";
const reference = {
  connectorDefinitionVersionId: ID,
  operationVersionId: "00000000-0000-4000-8000-000000000002",
  operationId: "listThings",
  connectorProjectionHash: "a".repeat(64),
  operationProjectionHash: "b".repeat(64),
  schemaHash: "c".repeat(64),
  readinessBinding: { kind: "connection" as const, connectionId: "connection-opaque", capability: "http.headers" as const },
};

const configured = {
  status: "configured" as const,
  message: "Test slot configured. Authentication unverified." as const,
  authentication: "unverified" as const,
  observedLifecycleRevision: 7,
  connection: {
    kind: "api_key" as const,
    publicHeaderNames: ["x-api-key"],
    testSlotStatus: "configured" as const,
    idSuffix: "a1b2c3d4",
  },
  egressCount: 0 as const,
  costUsdc: 0 as const,
};

const unavailable = {
  status: "unavailable" as const,
  message: "Test slot unavailable. Authentication unverified." as const,
  authentication: "unverified" as const,
  observedLifecycleRevision: null,
  connection: null,
  egressCount: 0 as const,
  costUsdc: 0 as const,
};

const notRequired = {
  status: "not_required" as const,
  message: "Authentication not required." as const,
  authentication: "not_required" as const,
  observedLifecycleRevision: null,
  connection: null,
  egressCount: 0 as const,
  costUsdc: 0 as const,
};

class StreamingOnlyResponse extends Response {
  override json(): Promise<unknown> { throw new Error("response.json forbidden"); }
  override text(): Promise<string> { throw new Error("response.text forbidden"); }
}

function json(value: unknown, status = 200): Response {
  return new StreamingOnlyResponse(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("strict browser connector readiness client", () => {
  it("parses configured, not-required, and specialized unavailable receipts exactly", async () => {
    expect(parseClientConnectorReadinessEnvelope({ readiness: configured }, 200)).toEqual({
      ok: true,
      readiness: configured,
    });
    expect(parseClientConnectorReadinessEnvelope({ error: "test readiness unavailable", readiness: unavailable }, 409))
      .toEqual({ ok: false, code: "TEST_CONNECTION_UNAVAILABLE", readiness: unavailable });
    expect(parseClientConnectorReadinessEnvelope({ readiness: notRequired }, 200))
      .toEqual({ ok: true, readiness: notRequired });
    expect(parseClientConnectorReadinessEnvelope({ readiness: { ...configured, authenticated: true } }, 200)).toBeNull();

    const fetcher = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ reference, expectedLifecycleRevision: 7 });
      return json({ readiness: configured });
    });
    await expect(createConnectorReadinessClient(fetcher).check({ reference, expectedLifecycleRevision: 7 }))
      .resolves.toEqual({ ok: true, readiness: configured });
    expect(fetcher).toHaveBeenCalledWith("/api/v2/connectors/readiness", expect.any(Object));

    const unavailableClient = createConnectorReadinessClient(async () =>
      json({ error: "test readiness unavailable", readiness: unavailable }, 409));
    await expect(unavailableClient.check({ reference })).resolves.toEqual({
      ok: false,
      code: "TEST_CONNECTION_UNAVAILABLE",
      readiness: unavailable,
    });
  });

  it("rejects hostile response fields, duplicate JSON keys, bad status pairing, and credential signatures", async () => {
    for (const response of [
      json({ readiness: { ...configured, secret: "canary" } }),
      json({ readiness: configured }, 409),
      json({ error: "test readiness unavailable", readiness: configured }, 409),
      json({ readiness: { ...configured, message: "Bearer secret-token-value" } }),
      new StreamingOnlyResponse('{"readiness":null,"readiness":null}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]) {
      const client = createConnectorReadinessClient(async () => response);
      await expect(client.check({ reference })).rejects.toMatchObject({ code: "READINESS_UNAVAILABLE" });
    }
  });

  it("keeps aborts distinguishable and prevents a stale late response from becoming success", async () => {
    const before = new AbortController();
    before.abort();
    const fetcher = vi.fn(async () => json({ readiness: configured }));
    await expect(createConnectorReadinessClient(fetcher).check({ reference }, before.signal))
      .rejects.toMatchObject({ code: "READINESS_CANCELLED" });
    expect(fetcher).not.toHaveBeenCalled();

    let release: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const during = new AbortController();
    const result = createConnectorReadinessClient(async () => pending).check({ reference }, during.signal);
    during.abort();
    release!(json({ readiness: configured }));
    await expect(result).rejects.toMatchObject({ code: "READINESS_CANCELLED" });

    const cancelled = createConnectorReadinessClient(async () => json({ error: "request cancelled" }, 409));
    await expect(cancelled.check({ reference })).rejects.toMatchObject({ status: 409, code: "READINESS_CANCELLED" });
  });

  it("rejects invalid request fields before fetch and keeps browser dependencies capability-minimized", async () => {
    const fetcher = vi.fn(async () => json({ readiness: configured }));
    const client = createConnectorReadinessClient(fetcher);
    await expect(client.check({ reference, fixture: "forbidden" } as never))
      .rejects.toEqual(expect.objectContaining<Partial<ConnectorReadinessClientError>>({
        status: 400,
        code: "READINESS_INVALID_REQUEST",
      }));
    expect(fetcher).not.toHaveBeenCalled();

    const source = readFileSync(new URL("../../src/lib/connectors/readiness-client.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/readiness-backend|repository|provider|sqlite|node:|resolveTest|decrypt|secret-normalization/u);
    expect(source).not.toMatch(/response\.(?:json|text)\s*\(/u);
  });
});
