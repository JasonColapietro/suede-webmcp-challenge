import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  enabled: true,
  ownerId: "owner-a" as string | null,
  order: [] as string[],
  refusalCodes: [] as string[],
  connectorGate: null as Promise<{ close(): void }> | null,
  result: {
    ok: true as const,
    receipt: { schemaVersion: 1, message: "Simulated locally. No request sent.", egressCount: 0, costUsdc: 0 },
  } as unknown,
  refusal: { ok: false as const, code: "SIMULATION_INVALID_REQUEST" as const, correlationId: "correlation-a" } as unknown,
}));

vi.mock("@/lib/connectors/flags", () => ({ get CONNECTOR_LAB_ENABLED() { return control.enabled; } }));
vi.mock("@/lib/auth", () => ({
  UnauthenticatedOwnerError: class extends Error {},
  resolveReadOnlyOwnerId: async () => { control.order.push("owner"); return control.ownerId; },
}));
vi.mock("@/lib/db/repo", () => ({ getRepo: async () => { control.order.push("flow-repo"); return {}; } }));
vi.mock("@/lib/projects/provider", () => ({
  ProjectStoreUnavailableError: class extends Error {},
  getProjectRepo: async () => { control.order.push("project-repo"); return {}; },
}));
vi.mock("@/lib/connectors/provider", () => ({
  getConnectorRepository: async () => {
    control.order.push("connector-repo");
    if (control.connectorGate) return control.connectorGate;
    return { close: () => control.order.push("close") };
  },
}));
vi.mock("@/lib/connectors/simulation-service", () => ({
  ApiOperationSimulationService: class {
    simulate = async () => { control.order.push("simulate"); return control.result; };
    recordRefusal = (_input: unknown, code: string) => {
      control.order.push("refuse");
      control.refusalCodes.push(code);
      return { ...(control.refusal as object), code };
    };
  },
}));

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  origin: "https://studio.test",
  "sec-fetch-site": "same-origin",
};
const body = { nodeId: "api", scope: "node", environmentId: "environment-test", pinnedInputs: {} };

class BodyObservedRequest extends Request {
  bodyReads = 0;
  override get body(): Request["body"] { this.bodyReads += 1; return super.body; }
}

function request(raw = JSON.stringify(body), headers: Record<string, string> = HEADERS): BodyObservedRequest {
  return new BodyObservedRequest("https://studio.test/api/v2/flows/flow-a/test/api-operation", {
    method: "POST", headers, body: raw,
  });
}

async function expectPrivate(response: Response, status: number, value: object): Promise<void> {
  expect({ status: response.status, text: await response.text() }).toEqual({ status, text: JSON.stringify(value) });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

beforeEach(() => {
  vi.clearAllMocks();
  control.enabled = true;
  control.ownerId = "owner-a";
  control.order.length = 0;
  control.refusalCodes.length = 0;
  control.connectorGate = null;
  control.result = { ok: true, receipt: { schemaVersion: 1, message: "Simulated locally. No request sent.", egressCount: 0, costUsdc: 0 } };
  control.refusal = { ok: false, code: "SIMULATION_INVALID_REQUEST", correlationId: "correlation-a" };
});

describe("private api.operation simulation route", () => {
  it("is flag-first before headers, auth, body, or storage", async () => {
    const route = await import("@/app/api/v2/flows/[flowId]/test/api-operation/route");
    control.enabled = false;
    const incoming = request();
    await expectPrivate(await route.POST(incoming, { params: Promise.resolve({ flowId: "flow-a" }) }), 404, { error: "not found" });
    expect(incoming.bodyReads).toBe(0);
    expect(control.order).toEqual([]);
  });

  it("enforces same-origin JSON with no request Authorization before auth or storage", async () => {
    const route = await import("@/app/api/v2/flows/[flowId]/test/api-operation/route");
    const crossOrigin = request(JSON.stringify(body), { ...HEADERS, origin: "https://evil.test" });
    await expectPrivate(await route.POST(crossOrigin, { params: Promise.resolve({ flowId: "flow-a" }) }), 403, { error: "forbidden" });
    expect(crossOrigin.bodyReads).toBe(0);
    expect(control.order).toEqual([]);

    const authorized = request(JSON.stringify(body), { ...HEADERS, authorization: "Bearer client-value" });
    await expectPrivate(await route.POST(authorized, { params: Promise.resolve({ flowId: "flow-a" }) }), 403, { error: "forbidden" });
    expect(control.order).toEqual([]);
  });

  it("rejects malformed or oversized declared bodies before auth, admission, or body reads", async () => {
    const route = await import("@/app/api/v2/flows/[flowId]/test/api-operation/route");
    for (const contentLength of [String(2 * 1024 * 1024 + 1), "12x"]) {
      const incoming = request(JSON.stringify(body), { ...HEADERS, "content-length": contentLength });
      await expectPrivate(await route.POST(incoming, { params: Promise.resolve({ flowId: "flow-a" }) }), 400, {
        error: "SIMULATION_INVALID_REQUEST",
      });
      expect(incoming.bodyReads).toBe(0);
      expect(control.order).toEqual([]);
    }
  });

  it("rejects duplicate JSON keys through an audited fixed parse refusal", async () => {
    const route = await import("@/app/api/v2/flows/[flowId]/test/api-operation/route");
    const raw = '{"nodeId":"api","nodeId":"other","scope":"node","environmentId":"environment-test","pinnedInputs":{}}';
    await expectPrivate(await route.POST(request(raw), { params: Promise.resolve({ flowId: "flow-a" }) }), 400, {
      error: "SIMULATION_INVALID_REQUEST", correlationId: "correlation-a",
    });
    expect(control.order).toEqual(["owner", "connector-repo", "refuse", "close"]);
  });

  it("returns the closed no-store success envelope and closes storage", async () => {
    const route = await import("@/app/api/v2/flows/[flowId]/test/api-operation/route");
    const response = await route.POST(request(), { params: Promise.resolve({ flowId: "flow-a" }) });
    await expectPrivate(response, 200, { simulation: (control.result as { receipt: object }).receipt });
    expect(control.order).toEqual(["owner", "connector-repo", "flow-repo", "project-repo", "simulate", "close"]);
  });

  it("audits a stalled body as a timeout and releases admission", async () => {
    vi.useFakeTimers();
    try {
      const route = await import("@/app/api/v2/flows/[flowId]/test/api-operation/route");
      const stream = new ReadableStream<Uint8Array>({ start: () => undefined });
      const incoming = new Request("https://studio.test/api/v2/flows/flow-a/test/api-operation", {
        method: "POST", headers: HEADERS, body: stream, duplex: "half",
      } as RequestInit & { duplex: "half" });
      const pending = route.POST(incoming, { params: Promise.resolve({ flowId: "flow-a" }) });
      await vi.advanceTimersByTimeAsync(10_000);
      await expectPrivate(await pending, 504, { error: "SIMULATION_TIMEOUT", correlationId: "correlation-a" });
      expect(control.refusalCodes).toEqual(["SIMULATION_TIMEOUT"]);
      expect(control.order).toEqual(["owner", "connector-repo", "refuse", "close"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a connector repository that resolves after the deadline race", async () => {
    vi.useFakeTimers();
    try {
      let resolveRepository!: (value: { close(): void }) => void;
      control.connectorGate = new Promise((resolve) => { resolveRepository = resolve; });
      const route = await import("@/app/api/v2/flows/[flowId]/test/api-operation/route");
      const pending = route.POST(request(), { params: Promise.resolve({ flowId: "flow-a" }) });
      await vi.advanceTimersByTimeAsync(10_000);
      await expectPrivate(await pending, 503, { error: "AUDIT_UNAVAILABLE" });
      resolveRepository({ close: () => control.order.push("late-close") });
      await Promise.resolve();
      await Promise.resolve();
      expect(control.order).toEqual(["owner", "connector-repo", "late-close"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
