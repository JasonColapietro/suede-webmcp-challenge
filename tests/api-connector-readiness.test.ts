import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorReadinessBackend } from "@/lib/connectors/readiness-backend";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const reference = {
  connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000001",
  operationVersionId: "00000000-0000-4000-8000-000000000002",
  operationId: "createThing",
  connectorProjectionHash: HASH_A,
  operationProjectionHash: HASH_B,
  schemaHash: HASH_C,
  readinessBinding: { kind: "connection" as const, connectionId: "connection-a", capability: "http.headers" as const },
};

const control = vi.hoisted(() => ({
  enabled: true,
  ownerId: "owner-a" as string | null,
  order: [] as string[],
  backend: null as ConnectorReadinessBackend | null,
}));

vi.mock("@/lib/connectors/flags", () => ({
  get CONNECTOR_LAB_ENABLED() { return control.enabled; },
}));
vi.mock("@/lib/auth", () => ({
  resolveReadOnlyOwnerId: async () => { control.order.push("owner"); return control.ownerId; },
}));
vi.mock("@/lib/connectors/readiness-backend", () => ({
  getConnectorReadinessBackend: async () => {
    control.order.push("backend");
    if (!control.backend) throw new Error("backend-canary");
    return control.backend;
  },
}));

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  origin: "https://studio.test",
  "sec-fetch-site": "same-origin",
};

class BodyObservedRequest extends Request {
  bodyReads = 0;
  override get body(): Request["body"] { this.bodyReads += 1; return super.body; }
}

class AbortOnBodyRequest extends BodyObservedRequest {
  readonly #controller: AbortController;
  constructor(url: string, init: RequestInit, controller: AbortController) {
    super(url, init);
    this.#controller = controller;
  }
  override get body(): Request["body"] {
    this.#controller.abort();
    return super.body;
  }
}

function request(body: unknown, signal?: AbortSignal): BodyObservedRequest {
  return new BodyObservedRequest("https://studio.test/api/v2/connectors/readiness", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
    signal,
  });
}

function backend(result: ReturnType<ConnectorReadinessBackend["check"]>): ConnectorReadinessBackend {
  return {
    check: vi.fn(() => { control.order.push("check"); return result; }),
    close: vi.fn(() => { control.order.push("close"); }),
  };
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
  control.backend = backend({
    ok: true,
    receipt: {
      status: "configured",
      message: "Test slot configured. Authentication unverified.",
      authentication: "unverified",
      observedLifecycleRevision: 7,
      connection: { kind: "api_key", publicHeaderNames: ["x-api-key"], testSlotStatus: "configured", idSuffix: "a1b2c3d4" },
      egressCount: 0,
      costUsdc: 0,
    },
  });
});

describe("private connector readiness route", () => {
  it("exports a dynamic Node POST route", async () => {
    const route = await import("@/app/api/v2/connectors/readiness/route");
    expect(route).toMatchObject({ runtime: "nodejs", dynamic: "force-dynamic" });
    expect(route.POST).toBeTypeOf("function");
  });

  it("returns flag-off before auth, body access, or storage", async () => {
    const route = await import("@/app/api/v2/connectors/readiness/route");
    control.enabled = false;
    const incoming = request({ reference });
    await expectPrivate(await route.POST(incoming), 404, { error: "not found" });
    expect(incoming.bodyReads).toBe(0);
    expect(control.order).toEqual([]);
  });

  it("enforces browser shape and owner before storage or body reads", async () => {
    const route = await import("@/app/api/v2/connectors/readiness/route");
    const crossOrigin = request({ reference });
    crossOrigin.headers.set("origin", "https://evil.test");
    await expectPrivate(await route.POST(crossOrigin), 400, { error: "invalid request" });
    expect(crossOrigin.bodyReads).toBe(0);
    expect(control.order).toEqual([]);

    control.ownerId = null;
    const unauthenticated = request({ reference });
    await expectPrivate(await route.POST(unauthenticated), 401, { error: "authentication required" });
    expect(unauthenticated.bodyReads).toBe(0);
    expect(control.order).toEqual(["owner"]);
  });

  it("opens the backend after owner, parses one bounded exact body, and closes on every exit", async () => {
    const route = await import("@/app/api/v2/connectors/readiness/route");
    const incoming = request({ reference, expectedLifecycleRevision: 7 });
    await expectPrivate(await route.POST(incoming), 200, {
      readiness: {
        status: "configured",
        message: "Test slot configured. Authentication unverified.",
        authentication: "unverified",
        observedLifecycleRevision: 7,
        connection: { kind: "api_key", publicHeaderNames: ["x-api-key"], testSlotStatus: "configured", idSuffix: "a1b2c3d4" },
        egressCount: 0,
        costUsdc: 0,
      },
    });
    expect(incoming.bodyReads).toBe(1);
    expect(control.order).toEqual(["owner", "backend", "check", "close"]);
    expect(control.backend?.check).toHaveBeenCalledWith("owner-a", {
      reference,
      expectedLifecycleRevision: 7,
    }, incoming.signal);
  });

  it("maps every private connection failure to one bounded response", async () => {
    const route = await import("@/app/api/v2/connectors/readiness/route");
    control.backend = backend({
      ok: false,
      code: "TEST_CONNECTION_UNAVAILABLE",
      receipt: {
        status: "unavailable",
        message: "Test slot unavailable. Authentication unverified.",
        authentication: "unverified",
        observedLifecycleRevision: null,
        connection: null,
        egressCount: 0,
        costUsdc: 0,
      },
    });
    await expectPrivate(await route.POST(request({ reference })), 409, {
      error: "test readiness unavailable",
      readiness: {
        status: "unavailable",
        message: "Test slot unavailable. Authentication unverified.",
        authentication: "unverified",
        observedLifecycleRevision: null,
        connection: null,
        egressCount: 0,
        costUsdc: 0,
      },
    });
    expect(control.order).toEqual(["owner", "backend", "check", "close"]);
  });

  it("rejects fixture, environment, caller correlation, and oversized bodies before checking readiness", async () => {
    const route = await import("@/app/api/v2/connectors/readiness/route");
    for (const body of [
      { reference, fixture: { token: "fixture-canary" } },
      { reference, environment: "live" },
      { reference, correlationId: "caller" },
    ]) {
      control.order.length = 0;
      await expectPrivate(await route.POST(request(body)), 400, { error: "invalid request" });
      expect(control.order).toEqual(["owner", "backend", "close"]);
    }

    control.order.length = 0;
    const oversized = new BodyObservedRequest("https://studio.test/api/v2/connectors/readiness", {
      method: "POST",
      headers: { ...HEADERS, "content-length": String(64 * 1024 + 1) },
      body: "{}",
    });
    await expectPrivate(await route.POST(oversized), 413, { error: "payload too large" });
    expect(oversized.bodyReads).toBe(0);
    expect(control.order).toEqual(["owner", "backend", "close"]);
  });

  it("returns fixed cancellation and unavailable-backend results without leaking errors", async () => {
    const route = await import("@/app/api/v2/connectors/readiness/route");
    const controller = new AbortController();
    controller.abort();
    const preCancelled = request({ reference }, controller.signal);
    await expectPrivate(await route.POST(preCancelled), 409, { error: "request cancelled" });
    expect(preCancelled.bodyReads).toBe(0);
    expect(control.order).toEqual([]);

    control.order.length = 0;
    const midController = new AbortController();
    const midPreflight = new AbortOnBodyRequest("https://studio.test/api/v2/connectors/readiness", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ reference }),
      signal: midController.signal,
    }, midController);
    await expectPrivate(await route.POST(midPreflight), 409, { error: "request cancelled" });
    expect(midPreflight.bodyReads).toBe(1);
    expect(control.order).toEqual(["owner", "backend", "close"]);
    expect(control.backend?.check).not.toHaveBeenCalled();

    control.order.length = 0;
    control.backend = backend({ ok: false, code: "READINESS_CANCELLED" });
    await expectPrivate(await route.POST(request({ reference })), 409, { error: "request cancelled" });
    expect(control.order).toEqual(["owner", "backend", "check", "close"]);

    control.order.length = 0;
    control.backend = null;
    await expectPrivate(await route.POST(request({ reference })), 503, { error: "connector service unavailable" });
    expect(control.order).toEqual(["owner", "backend"]);
  });
});
