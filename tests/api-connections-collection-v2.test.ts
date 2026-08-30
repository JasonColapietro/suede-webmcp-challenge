import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidConnectionPageError,
  type CloseableConnectionRepository,
} from "@/lib/connections/repository";
import type { ConnectionView } from "@/lib/connections/types";

const control = vi.hoisted(() => ({
  ownerId: "owner-a" as string | null,
  providerAvailable: true,
  adoptionFailure: false,
  order: [] as string[],
  repository: null as CloseableConnectionRepository | null,
}));

vi.mock("@/lib/auth", () => ({
  resolveReadOnlyOwnerId: async () => {
    control.order.push("owner");
    return control.ownerId;
  },
  adoptAnonymousWorkspaceForVerifiedOwner: async () => {
    control.order.push("adopt");
    if (control.adoptionFailure) throw new Error("adoption-canary");
  },
}));

vi.mock("@/lib/connections/provider", () => ({
  getConnectionRepository: async () => {
    control.order.push("provider");
    if (!control.providerAvailable || !control.repository) throw new Error("provider-canary");
    return control.repository;
  },
}));

const MUTATION_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  origin: "https://studio.test",
  "sec-fetch-site": "same-origin",
};

const LIST_CURSOR = Buffer.from(JSON.stringify({
  updatedAt: 100,
  id: "conn_1",
}), "utf8").toString("base64url");

function view(overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: "conn_1",
    name: "Production API",
    kind: "bearer",
    publicConfig: {},
    lifecycleRevision: 1,
    slots: {
      test: { environment: "test", status: "missing", secretVersion: 0, updatedAt: null, revokedAt: null },
      live: { environment: "live", status: "missing", secretVersion: 0, updatedAt: null, revokedAt: null },
    },
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function repository(overrides: Partial<CloseableConnectionRepository> = {}): CloseableConnectionRepository {
  return {
    create: vi.fn(async () => view()),
    list: vi.fn(async () => ({ items: [view()], nextCursor: null })),
    get: vi.fn(async () => view()),
    rename: vi.fn(async () => ({ status: "updated", connection: view({ name: "Renamed", lifecycleRevision: 2 }) })),
    configureSlot: vi.fn(),
    revokeSlot: vi.fn(),
    resolveHeaders: vi.fn(),
    usage: vi.fn(),
    close: vi.fn(() => { control.order.push("close"); }),
    dispose: vi.fn(),
    ...overrides,
  } as CloseableConnectionRepository;
}

class BodyObservedRequest extends Request {
  bodyReads = 0;

  override get body(): Request["body"] {
    this.bodyReads += 1;
    return super.body;
  }
}

function mutationRequest(path: string, method: "POST" | "PATCH", body: string, headers: HeadersInit = MUTATION_HEADERS) {
  return new BodyObservedRequest(`https://studio.test${path}`, { method, body, headers });
}

function params(connectionId: unknown) {
  return { params: Promise.resolve({ connectionId }) } as unknown as {
    params: Promise<{ connectionId: string }>;
  };
}

async function expectPrivateJson(response: Response, status: number, body: Readonly<object>): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(await response.text()).toBe(JSON.stringify(body));
}

async function collectionRoute() {
  try { return await import("@/app/api/v2/connections/route"); } catch { return null; }
}

async function itemRoute() {
  try { return await import("@/app/api/v2/connections/[connectionId]/route"); } catch { return null; }
}

beforeEach(() => {
  vi.clearAllMocks();
  control.ownerId = "owner-a";
  control.providerAvailable = true;
  control.adoptionFailure = false;
  control.order.length = 0;
  control.repository = repository();
});

describe("v2 connection collection and item routes", () => {
  it("exports dynamic Node route handlers", async () => {
    const collection = await collectionRoute();
    const item = await itemRoute();
    expect(collection).not.toBeNull();
    expect(item).not.toBeNull();
    expect(collection).toMatchObject({ runtime: "nodejs", dynamic: "force-dynamic" });
    expect(item).toMatchObject({ runtime: "nodejs", dynamic: "force-dynamic" });
    expect(collection?.GET).toBeTypeOf("function");
    expect(collection?.POST).toBeTypeOf("function");
    expect(item?.GET).toBeTypeOf("function");
    expect(item?.PATCH).toBeTypeOf("function");
  });

  it("lists only the authenticated owner's requested page and always closes the repository", async () => {
    const route = await collectionRoute();
    expect(route).not.toBeNull();
    if (!route || !control.repository) return;
    vi.mocked(control.repository.list).mockImplementation(async (ownerId, page) => {
      control.order.push("list");
      expect(ownerId).toBe("owner-a");
      expect(page).toEqual({ limit: 2 });
      return { items: [view()], nextCursor: LIST_CURSOR };
    });

    const response = await route.GET(new Request("https://studio.test/api/v2/connections?limit=2"));

    await expectPrivateJson(response, 200, {
      connections: [view()],
      nextCursor: LIST_CURSOR,
    });
    expect(control.order).toEqual(["owner", "provider", "adopt", "list", "close"]);
  });

  it("maps only the repository invalid-page signal to 400", async () => {
    const route = await collectionRoute();
    expect(route).not.toBeNull();
    if (!route || !control.repository) return;
    const list = vi.mocked(control.repository.list);
    list.mockImplementationOnce(async () => {
      control.order.push("list");
      throw new InvalidConnectionPageError();
    });

    await expectPrivateJson(
      await route.GET(new Request(`https://studio.test/api/v2/connections?cursor=${LIST_CURSOR}`)),
      400,
      { error: "invalid request" },
    );
    expect(control.order).toEqual(["owner", "provider", "adopt", "list", "close"]);

    control.order.length = 0;
    list.mockImplementationOnce(async () => {
      control.order.push("list");
      throw new TypeError("Invalid connection page");
    });
    await expectPrivateJson(
      await route.GET(new Request(`https://studio.test/api/v2/connections?cursor=${LIST_CURSOR}`)),
      503,
      { error: "connection service unavailable" },
    );
    expect(control.order).toEqual(["owner", "provider", "adopt", "list", "close"]);
  });

  it("adopts only after provider preflight, before listing, and fails closed when adoption fails", async () => {
    const route = await collectionRoute();
    expect(route).not.toBeNull();
    if (!route || !control.repository) return;
    const list = vi.mocked(control.repository.list);

    control.adoptionFailure = true;
    const response = await route.GET(new Request("https://studio.test/api/v2/connections"));

    await expectPrivateJson(response, 503, { error: "connection service unavailable" });
    expect(control.order).toEqual(["owner", "provider", "adopt", "close"]);
    expect(list).not.toHaveBeenCalled();
    expect(control.repository.close).toHaveBeenCalledOnce();
  });

  it("creates metadata only with both slots missing and returns 201", async () => {
    const route = await collectionRoute();
    expect(route).not.toBeNull();
    if (!route || !control.repository) return;
    vi.mocked(control.repository.create).mockImplementation(async (ownerId, input, now) => {
      control.order.push("create");
      expect(ownerId).toBe("owner-a");
      expect(input).toEqual({ name: "Production API", kind: "bearer", publicConfig: {} });
      expect(JSON.stringify(input)).not.toMatch(/secret|token|password|apiKey|values/u);
      expect(Number.isSafeInteger(now)).toBe(true);
      return view({ createdAt: now, updatedAt: now });
    });
    const request = mutationRequest(
      "/api/v2/connections",
      "POST",
      JSON.stringify({ name: "Production API", kind: "bearer", publicConfig: {} }),
    );

    const response = await route.POST(request);
    const expected = view({ createdAt: expect.any(Number) as number, updatedAt: expect.any(Number) as number });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = await response.json() as { connection: ConnectionView };
    expect(payload.connection).toMatchObject(expected);
    expect(payload.connection.slots.test.status).toBe("missing");
    expect(payload.connection.slots.live.status).toBe("missing");
    expect(request.bodyReads).toBe(1);
    expect(control.order).toEqual(["owner", "provider", "adopt", "create", "close"]);
  });

  it("rejects invalid mutation headers before identity, provider, body, or repository", async () => {
    const route = await collectionRoute();
    expect(route).not.toBeNull();
    if (!route || !control.repository) return;
    const request = mutationRequest("/api/v2/connections", "POST", "{}", {
      ...MUTATION_HEADERS,
      origin: "https://evil.test",
    });

    await expectPrivateJson(await route.POST(request), 400, { error: "invalid request" });
    expect(request.bodyReads).toBe(0);
    expect(control.order).toEqual([]);
    expect(control.repository.create).not.toHaveBeenCalled();
    expect(control.repository.close).not.toHaveBeenCalled();
  });

  it("rejects authentication and provider failures before body reads or repository calls", async () => {
    const route = await collectionRoute();
    expect(route).not.toBeNull();
    if (!route || !control.repository) return;
    const authRequest = mutationRequest("/api/v2/connections", "POST", "not-json");
    control.ownerId = null;
    await expectPrivateJson(await route.POST(authRequest), 401, { error: "authentication required" });
    expect(authRequest.bodyReads).toBe(0);
    expect(control.order).toEqual(["owner"]);
    expect(control.repository.create).not.toHaveBeenCalled();

    control.ownerId = "owner-a";
    control.providerAvailable = false;
    control.order.length = 0;
    const unavailableRequest = mutationRequest("/api/v2/connections", "POST", "not-json");
    await expectPrivateJson(await route.POST(unavailableRequest), 503, { error: "connection service unavailable" });
    expect(unavailableRequest.bodyReads).toBe(0);
    expect(control.order).toEqual(["owner", "provider"]);
    expect(control.repository.create).not.toHaveBeenCalled();
    expect(control.repository.close).not.toHaveBeenCalled();
  });

  it("closes a successfully opened provider when body validation later fails", async () => {
    const route = await collectionRoute();
    expect(route).not.toBeNull();
    if (!route || !control.repository) return;
    const request = mutationRequest("/api/v2/connections", "POST", "not-json");

    await expectPrivateJson(await route.POST(request), 400, { error: "invalid request" });
    expect(request.bodyReads).toBe(1);
    expect(control.repository.create).not.toHaveBeenCalled();
    expect(control.order).toEqual(["owner", "provider", "close"]);
  });

  it("gets metadata and makes missing and foreign IDs byte-identical", async () => {
    const route = await itemRoute();
    expect(route).not.toBeNull();
    if (!route || !control.repository) return;
    vi.mocked(control.repository.get).mockImplementation(async (ownerId, connectionId) => {
      control.order.push("get");
      return ownerId === "owner-a" && connectionId === "conn_1" ? view() : null;
    });
    const request = new Request("https://studio.test/api/v2/connections/conn_1");
    await expectPrivateJson(await route.GET(request, params("conn_1")), 200, { connection: view() });

    control.order.length = 0;
    const missing = await route.GET(request, params("missing"));
    control.ownerId = "owner-b";
    const foreign = await route.GET(request, params("conn_1"));
    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await missing.text()).toBe(JSON.stringify({ error: "not found" }));
    expect(await foreign.text()).toBe(JSON.stringify({ error: "not found" }));
    expect(control.repository.close).toHaveBeenCalledTimes(3);
  });

  it("renames once and returns conflict for a stale same-time receipt", async () => {
    const route = await itemRoute();
    expect(route).not.toBeNull();
    if (!route || !control.repository) return;
    let revision = 1;
    vi.spyOn(Date, "now").mockReturnValue(500);
    vi.mocked(control.repository.rename).mockImplementation(async (_owner, _id, expected, name, now) => {
      control.order.push("rename");
      if (expected !== revision) return { status: "conflict" };
      revision += 1;
      return { status: "updated", connection: view({ name, lifecycleRevision: revision, updatedAt: now }) };
    });
    const request = () => mutationRequest(
      "/api/v2/connections/conn_1",
      "PATCH",
      JSON.stringify({ name: "Renamed", expectedLifecycleRevision: 1 }),
    );

    await expectPrivateJson(await route.PATCH(request(), params("conn_1")), 200, {
      connection: view({ name: "Renamed", lifecycleRevision: 2, updatedAt: 500 }),
    });
    await expectPrivateJson(await route.PATCH(request(), params("conn_1")), 409, { error: "conflict" });
    expect(control.repository.close).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("maps rename not-found and repository failures to fixed private errors and still closes", async () => {
    const route = await itemRoute();
    expect(route).not.toBeNull();
    if (!route || !control.repository) return;
    vi.mocked(control.repository.rename).mockResolvedValueOnce({ status: "not-found" });
    const notFoundRequest = mutationRequest(
      "/api/v2/connections/missing",
      "PATCH",
      JSON.stringify({ name: "Renamed", expectedLifecycleRevision: 1 }),
    );
    await expectPrivateJson(await route.PATCH(notFoundRequest, params("missing")), 404, { error: "not found" });

    vi.mocked(control.repository.get).mockRejectedValueOnce(new Error("repository-secret-canary"));
    const failed = await route.GET(
      new Request("https://studio.test/api/v2/connections/conn_1"),
      params("conn_1"),
    );
    await expectPrivateJson(failed, 503, { error: "connection service unavailable" });
    expect(control.repository.close).toHaveBeenCalledTimes(2);
  });
});
