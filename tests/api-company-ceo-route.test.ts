/**
 * Integration tests for the CEO chat endpoint
 * (src/app/api/companies/[id]/ceo/route.ts): full hire→confirm,
 * fire→confirm, and cancel round trips against a real
 * SqliteRepo(":memory:") company, exercising the deterministic fallback
 * brain (no ANTHROPIC_API_KEY set). Mirrors the harness in
 * tests/api-company-fire.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SupabaseRepo } from "@/lib/db/supabase-repo";
import { materializeCompanyDraft, templateToDraft } from "@/lib/company/founding";

const state = vi.hoisted(() => ({
  owner: "owner-ceo-route-test",
  getRepo: vi.fn(),
  resolveOwnerId: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/db/repo", () => ({
  getRepo: (...args: unknown[]) => state.getRepo(...args),
}));
vi.mock("@/lib/auth", () => ({
  resolveOwnerId: (...args: unknown[]) => state.resolveOwnerId(...args),
  UnauthenticatedOwnerError: class UnauthenticatedOwnerError extends Error {
    status = 401;
    constructor() {
      super("Authentication required");
      this.name = "UnauthenticatedOwnerError";
    }
  },
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: (...args: unknown[]) => state.checkRateLimit(...args),
}));

let repo: SqliteRepo;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  repo = new SqliteRepo(":memory:");
  state.getRepo.mockImplementation(async () => repo);
  state.resolveOwnerId.mockImplementation(async () => state.owner);
  state.checkRateLimit.mockReturnValue({ allowed: true, retryAfterSec: 0 });
});

async function ceoRoute() {
  return import("@/app/api/companies/[id]/ceo/route");
}

function ceoRequest(companyId: string, body: Record<string, unknown>): Request {
  return new Request(`https://agents.suedeai.ai/api/companies/${companyId}/ceo`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://agents.suedeai.ai",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

function ceoGetRequest(companyId: string): Request {
  return new Request(`https://agents.suedeai.ai/api/companies/${companyId}/ceo`);
}

function ceoContext(companyId: string) {
  return { params: Promise.resolve({ id: companyId }) };
}

function supabaseClient(value: unknown): SupabaseClient {
  return value as SupabaseClient;
}

async function foundContentStudio(): Promise<string> {
  const draft = templateToDraft("content-studio");
  if (!draft) throw new Error("content-studio template missing");
  const { companyId } = await materializeCompanyDraft(state.owner, draft, repo);
  return companyId;
}

describe("POST /api/companies/[id]/ceo — hire round trip", () => {
  it("proposes a hire, then executes it only on confirmation", async () => {
    const companyId = await foundContentStudio();
    const { POST } = await ceoRoute();
    const before = await repo.listEmployees(companyId);

    const propose = await POST(
      ceoRequest(companyId, { message: "hire another writer in Marketing" }),
      ceoContext(companyId),
    );
    const proposeBody = await propose.json();
    expect(propose.status).toBe(200);
    expect(proposeBody.proposal?.kind).toBe("hire");
    expect(proposeBody.executed).toBeNull();
    // Nothing executes until confirmed.
    expect((await repo.listEmployees(companyId)).length).toBe(before.length);

    const confirm = await POST(ceoRequest(companyId, { message: "yes" }), ceoContext(companyId));
    const confirmBody = await confirm.json();
    expect(confirm.status).toBe(200);
    expect(confirmBody.executed).toEqual({ kind: "hire" });

    const after = await repo.listEmployees(companyId);
    expect(after.length).toBe(before.length + 1);
  });
});

describe("POST /api/companies/[id]/ceo — fire round trip", () => {
  it("proposes removing an employee, then executes it on confirmation", async () => {
    const companyId = await foundContentStudio();
    const { POST } = await ceoRoute();
    const employees = await repo.listEmployees(companyId);
    const target = employees.find((e) => e.jobDescription.toLowerCase().includes("campaign"));
    expect(target).toBeTruthy();
    if (!target) return;

    const propose = await POST(
      ceoRequest(companyId, { message: `fire the ${target.jobDescription}` }),
      ceoContext(companyId),
    );
    const proposeBody = await propose.json();
    expect(proposeBody.proposal?.kind).toBe("fireEmployee");
    expect(proposeBody.proposal?.agentId).toBe(target.agentId);

    const confirm = await POST(ceoRequest(companyId, { message: "confirm" }), ceoContext(companyId));
    const confirmBody = await confirm.json();
    expect(confirmBody.executed).toEqual({ kind: "fireEmployee" });

    const remaining = await repo.getEmployeeByAgent(target.agentId);
    expect(remaining).toBeNull();
  });
});

describe("POST /api/companies/[id]/ceo — budget round trip", () => {
  it("proposes a department budget change, then executes it on confirmation", async () => {
    const companyId = await foundContentStudio();
    const { POST } = await ceoRoute();

    const propose = await POST(
      ceoRequest(companyId, { message: "bump Marketing's budget to $200" }),
      ceoContext(companyId),
    );
    const proposeBody = await propose.json();
    expect(proposeBody.proposal?.kind).toBe("budget");

    const confirm = await POST(ceoRequest(companyId, { message: "yes" }), ceoContext(companyId));
    const confirmBody = await confirm.json();
    expect(confirmBody.executed).toEqual({ kind: "budget" });

    const departments = await repo.listDepartments(companyId);
    const marketing = departments.find((d) => d.name === "Marketing");
    expect(marketing?.monthlyBudgetUsdc).toBe(200);
  });
});

describe("POST /api/companies/[id]/ceo — createDepartment round trip", () => {
  it("proposes a new department, then creates it only on confirmation", async () => {
    const companyId = await foundContentStudio();
    const { POST } = await ceoRoute();

    const propose = await POST(
      ceoRequest(companyId, { message: "add a Licensing department with a $75 budget" }),
      ceoContext(companyId),
    );
    const proposeBody = await propose.json();
    expect(proposeBody.proposal?.kind).toBe("createDepartment");
    expect(proposeBody.executed).toBeNull();
    // Nothing created before confirmation.
    expect((await repo.listDepartments(companyId)).some((d) => d.name === "Licensing")).toBe(false);

    const confirm = await POST(ceoRequest(companyId, { message: "yes" }), ceoContext(companyId));
    const confirmBody = await confirm.json();
    expect(confirmBody.executed).toEqual({ kind: "createDepartment" });

    const licensing = (await repo.listDepartments(companyId)).find((d) => d.name === "Licensing");
    expect(licensing).toBeDefined();
    expect(licensing?.monthlyBudgetUsdc).toBe(75);
  });

  it("declines to execute when the department was created via the form in the meantime", async () => {
    const companyId = await foundContentStudio();
    const { POST } = await ceoRoute();

    const propose = await POST(
      ceoRequest(companyId, { message: "create a Licensing department" }),
      ceoContext(companyId),
    );
    expect((await propose.json()).proposal?.kind).toBe("createDepartment");

    // Founder races the chat by using the form first.
    await repo.createDepartment({ companyId, name: "Licensing", monthlyBudgetUsdc: null });

    const confirm = await POST(ceoRequest(companyId, { message: "yes" }), ceoContext(companyId));
    const confirmBody = await confirm.json();
    expect(confirmBody.executed).toBeNull();
    expect(confirmBody.reply).toMatch(/already exists/i);
    expect((await repo.listDepartments(companyId)).filter((d) => d.name === "Licensing")).toHaveLength(1);
  });
});

describe("POST /api/companies/[id]/ceo — cancel", () => {
  it("drops a pending proposal without executing when the founder declines", async () => {
    const companyId = await foundContentStudio();
    const { POST } = await ceoRoute();
    const before = await repo.listEmployees(companyId);

    await POST(ceoRequest(companyId, { message: "hire another writer in Marketing" }), ceoContext(companyId));
    const cancel = await POST(ceoRequest(companyId, { message: "no" }), ceoContext(companyId));
    const cancelBody = await cancel.json();
    expect(cancelBody.executed).toBeNull();
    expect(cancelBody.proposal).toBeNull();

    const after = await repo.listEmployees(companyId);
    expect(after.length).toBe(before.length);
  });
});

describe("GET /api/companies/[id]/ceo", () => {
  it("returns persisted turns in order", async () => {
    const companyId = await foundContentStudio();
    const { POST, GET } = await ceoRoute();
    await POST(ceoRequest(companyId, { message: "hire another writer in Marketing" }), ceoContext(companyId));

    const res = await GET(ceoGetRequest(companyId), ceoContext(companyId));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.messages.length).toBe(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");
  });

  it("404s for a company the caller doesn't own", async () => {
    const companyId = await foundContentStudio();
    const { GET } = await ceoRoute();
    state.resolveOwnerId.mockImplementation(async () => "someone-else");

    const res = await GET(ceoGetRequest(companyId), ceoContext(companyId));
    expect(res.status).toBe(404);
  });
});

describe("CEO persistence failures", () => {
  it("returns 500 when the production repository cannot persist the user turn", async () => {
    const companyId = await foundContentStudio();
    const company = await repo.getCompany(companyId);
    if (!company) throw new Error("test company missing");
    const departments = await repo.listDepartments(companyId);
    const employees = await repo.listEmployees(companyId);
    const insert = vi.fn(async () => ({
      data: null,
      error: { code: "42501", message: "CEO history write denied" },
    }));
    const productionRepo = new SupabaseRepo(supabaseClient({
      from: vi.fn(() => ({ insert })),
    }));
    vi.spyOn(productionRepo, "getCompany").mockResolvedValue(company);
    vi.spyOn(productionRepo, "listDepartments").mockResolvedValue(departments);
    vi.spyOn(productionRepo, "listEmployees").mockResolvedValue(employees);
    vi.spyOn(productionRepo, "listCeoMessages").mockResolvedValue([]);
    state.getRepo.mockResolvedValue(productionRepo);
    const { POST } = await ceoRoute();

    const response = await POST(
      ceoRequest(companyId, { message: "hire another writer in Marketing" }),
      ceoContext(companyId),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal error" });
    expect(insert).toHaveBeenCalledOnce();
  });

  it("returns 500 when the production repository cannot reload persisted history", async () => {
    const companyId = await foundContentStudio();
    const company = await repo.getCompany(companyId);
    if (!company) throw new Error("test company missing");
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "limit"] as const) {
      query[method] = vi.fn(() => query);
    }
    query.then = (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve({
      data: null,
      error: { code: "42501", message: "CEO history read denied" },
    }).then(resolve, reject);
    const productionRepo = new SupabaseRepo(supabaseClient({
      from: vi.fn(() => query),
    }));
    vi.spyOn(productionRepo, "getCompany").mockResolvedValue(company);
    state.getRepo.mockResolvedValue(productionRepo);
    const { GET } = await ceoRoute();

    const response = await GET(ceoGetRequest(companyId), ceoContext(companyId));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal server error" });
  });
});
