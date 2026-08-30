import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ApiOperationSimulationClientError,
  createApiOperationSimulationClient,
  parseClientApiOperationSimulationEnvelope,
} from "@/lib/connectors/simulation-client";

const ID = "00000000-0000-4000-8000-000000000001";
const request = {
  environmentId: "environment-a",
  nodeId: "node-a",
  pinnedInputs: {},
  scope: "node" as const,
};
const receipt = {
  schemaVersion: 1 as const,
  correlationId: ID,
  simulationId: "00000000-0000-4000-8000-000000000002",
  message: "Simulated locally. No request sent." as const,
  operation: {
    operationVersionId: "00000000-0000-4000-8000-000000000003",
    operationId: "listThings",
    connectorProjectionHash: "a".repeat(64),
    operationProjectionHash: "b".repeat(64),
    schemaHash: "c".repeat(64),
    method: "GET",
    origin: "https://api.vendor.test",
    pathTemplate: "/things/{id}",
    pathParameterNames: ["id"],
    queryParameterNames: ["page"],
    requestHeaderNames: ["x-request-id"],
    hasBody: false,
    selectedStatus: 200,
    credentialPlaceholder: null,
  },
  systemPolicy: { effects: ["write"] as ["write"], retry: "unsafe" as const, cost: "unknown" as const, idempotency: "none" as const },
  authorAnnotation: null,
  execution: { plannedNodeCount: 1, completedNodeCount: 1 },
  egressCount: 0 as const,
  costUsdc: 0 as const,
  durationMs: 7,
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

function dependencyGraph(entries: readonly string[]): ReadonlyMap<string, string> {
  const root = resolve(new URL("../..", import.meta.url).pathname);
  const pending = entries.map((entry) => join(root, entry));
  const visited = new Map<string, string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    const source = readFileSync(file, "utf8");
    visited.set(file, source);
    const imports = source.matchAll(/(?:import|export)\s+(type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|(?:import|require)\(\s*["']([^"']+)["']\s*\)/gu);
    for (const match of imports) {
      if (match[1]) continue;
      const specifier = match[2] ?? match[3];
      if (!specifier || (!specifier.startsWith("@/") && !specifier.startsWith("."))) continue;
      const base = specifier.startsWith("@/") ? join(root, "src", specifier.slice(2)) : resolve(dirname(file), specifier);
      const candidate = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]
        .find((path) => existsSync(path) && statSync(path).isFile());
      if (candidate) pending.push(candidate);
    }
  }
  return visited;
}

describe("strict browser API operation simulation client", () => {
  it("posts only the final Task 9 request and parses the redacted receipt exactly", async () => {
    expect(parseClientApiOperationSimulationEnvelope({ simulation: receipt }, 200))
      .toEqual({ simulation: receipt });
    const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      expect(String(path)).toBe("/api/v2/flows/flow-a/test/api-operation");
      expect(init).toMatchObject({
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
      expect(JSON.parse(String(init?.body))).toEqual(request);
      return json({ simulation: receipt });
    });
    await expect(createApiOperationSimulationClient(fetcher).simulate("flow-a", request))
      .resolves.toEqual(receipt);

    const credential = {
      ...receipt,
      operation: {
        ...receipt.operation,
        credentialPlaceholder: {
          kind: "api_key_header",
          headerName: "x-api-key",
          value: "[redacted]",
        },
      },
    };
    expect(parseClientApiOperationSimulationEnvelope({ simulation: credential }, 200))
      .toEqual({ simulation: credential });
    for (const placeholder of [
      { kind: "api_key_header", headerName: "x-api-key", value: "actual-secret" },
      { kind: "http_bearer", headerName: "x-other", value: "[redacted]" },
      { kind: "http_basic", headerName: "authorization", value: "[redacted]", token: "extra" },
    ]) {
      expect(parseClientApiOperationSimulationEnvelope({
        simulation: { ...receipt, operation: { ...receipt.operation, credentialPlaceholder: placeholder } },
      }, 200)).toBeNull();
    }
  });

  it("rejects outputs, inputs, sentinels, source, credential material, unknown keys, and duplicate JSON keys", async () => {
    const hostile = [
      { simulation: { ...receipt, outputs: { result: "sentinel-canary" } } },
      { simulation: { ...receipt, input: "input-canary" } },
      { simulation: { ...receipt, source: "source-canary" } },
      { simulation: { ...receipt, credentialValue: "secret-canary" } },
      { simulation: { ...receipt, operation: { ...receipt.operation, sentinel: "canary" } } },
      { simulation: { ...receipt, message: "Bearer secret-token-value" } },
    ];
    for (const value of hostile) {
      await expect(createApiOperationSimulationClient(async () => json(value)).simulate("flow-a", request))
        .rejects.toMatchObject({ code: "SIMULATION_UNAVAILABLE" });
    }
    const duplicate = new StreamingOnlyResponse(
      `{"simulation":${JSON.stringify(receipt)},"simulation":${JSON.stringify(receipt)}}`,
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await expect(createApiOperationSimulationClient(async () => duplicate).simulate("flow-a", request))
      .rejects.toMatchObject({ code: "SIMULATION_UNAVAILABLE" });
  });

  it("preserves fixed server refusal codes and correlations without echoing rejected values", async () => {
    const client = createApiOperationSimulationClient(async () =>
      json({ error: "SIMULATION_INPUT_REFUSED", correlationId: ID }, 422));
    await expect(client.simulate("flow-a", request)).rejects.toEqual(
      expect.objectContaining<Partial<ApiOperationSimulationClientError>>({
        status: 422,
        code: "SIMULATION_INPUT_REFUSED",
        correlationId: ID,
      }),
    );
    await expect(createApiOperationSimulationClient(async () =>
      json({ error: "SIMULATION_INPUT_REFUSED", rejectedValue: "must-not-echo" }, 422)).simulate("flow-a", request))
      .rejects.toMatchObject({ code: "SIMULATION_UNAVAILABLE" });
  });

  it("keeps aborts distinguishable and prevents late stale success", async () => {
    const before = new AbortController();
    before.abort();
    const fetcher = vi.fn(async () => json({ simulation: receipt }));
    await expect(createApiOperationSimulationClient(fetcher).simulate("flow-a", request, before.signal))
      .rejects.toMatchObject({ code: "SIMULATION_CANCELLED" });
    expect(fetcher).not.toHaveBeenCalled();

    let release: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const during = new AbortController();
    const result = createApiOperationSimulationClient(async () => pending).simulate("flow-a", request, during.signal);
    during.abort();
    release!(json({ simulation: receipt }));
    await expect(result).rejects.toMatchObject({ code: "SIMULATION_CANCELLED" });
  });

  it("rejects unknown request fields and unsafe flow IDs before fetch with browser-only dependencies", async () => {
    const fetcher = vi.fn(async () => json({ simulation: receipt }));
    const client = createApiOperationSimulationClient(fetcher);
    await expect(client.simulate("flow-a", { ...request, fixture: "forbidden" } as never))
      .rejects.toMatchObject({ status: 422, code: "UNSUPPORTED_FIXTURE_INPUT" });
    await expect(client.simulate(" https://evil.test ", request))
      .rejects.toMatchObject({ status: 400, code: "SIMULATION_INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();

    const source = readFileSync(new URL("../../src/lib/connectors/simulation-client.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/simulation-service|simulation-runtime|repository|provider|sqlite|node:|decrypt|fetch\(\s*["']https?:/u);
    expect(source).not.toMatch(/response\.(?:json|text)\s*\(/u);

    const graph = dependencyGraph([
      "src/lib/connectors/client.ts",
      "src/lib/connectors/readiness-client.ts",
      "src/lib/connectors/simulation-client.ts",
    ]);
    expect([...graph.keys()].join("\n")).not.toMatch(/simulation-(?:contract|service|runtime)|readiness-backend|sqlite-repository|provider|schema\.ts/u);
    expect([...graph.values()].join("\n")).not.toMatch(/from\s+["']node:|\bBuffer\b/u);
  });
});
