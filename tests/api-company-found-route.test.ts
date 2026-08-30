/**
 * Tests for POST /api/companies/found — the description-first founding
 * route. checkBotId, resolveOwnerId, checkRateLimit, and the guided brain
 * (runCompanyGuidedTurn) are mocked at the module boundary; getRepo is
 * backed by a real SqliteRepo(":memory:") so materialize=true exercises the
 * real founding service end to end (same module-mock pattern as
 * tests/api-company-fire.test.ts). See
 * docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md, Task 15.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import type { AgentManifest } from "@/lib/manifest/schema";

const state = vi.hoisted(() => {
  class UnauthenticatedOwnerError extends Error {
    status = 401;
    constructor() {
      super("Authentication required");
      this.name = "UnauthenticatedOwnerError";
    }
  }
  return {
    owner: "sb:owner-found-test",
    getRepo: vi.fn(),
    resolveOwnerId: vi.fn(),
    checkRateLimit: vi.fn(),
    checkBotId: vi.fn(),
    runCompanyGuidedTurn: vi.fn(),
    UnauthenticatedOwnerError,
  };
});

vi.mock("botid/server", () => ({
  checkBotId: (...args: unknown[]) => state.checkBotId(...args),
}));
vi.mock("@/lib/db/repo", () => ({
  getRepo: (...args: unknown[]) => state.getRepo(...args),
}));
vi.mock("@/lib/auth", () => ({
  resolveOwnerId: (...args: unknown[]) => state.resolveOwnerId(...args),
  SUEDE_OWNER_PREFIX: "sb:",
  UnauthenticatedOwnerError: state.UnauthenticatedOwnerError,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: (...args: unknown[]) => state.checkRateLimit(...args),
}));
vi.mock("@/lib/company/guided", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/company/guided")>();
  return {
    ...actual,
    runCompanyGuidedTurn: (...args: unknown[]) => state.runCompanyGuidedTurn(...args),
  };
});

let repo: SqliteRepo;

beforeEach(() => {
  vi.clearAllMocks();
  repo = new SqliteRepo(":memory:");
  state.getRepo.mockImplementation(async () => repo);
  state.resolveOwnerId.mockImplementation(async () => state.owner);
  state.checkRateLimit.mockReturnValue({ allowed: true, retryAfterSec: 0 });
  state.checkBotId.mockResolvedValue({ isBot: false });
});

async function foundRoute() {
  return import("@/app/api/companies/found/route");
}

function foundRequest(body: Record<string, unknown>): Request {
  return new Request("https://agents.suedeai.ai/api/companies/found", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://agents.suedeai.ai",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

/** Minimal manifest valid against AgentManifestSchema: llm -> output, paidCall trigger. */
const MINIMAL_MANIFEST: AgentManifest = {
  manifestVersion: 1,
  name: "Test Employee",
  description: "",
  triggers: [{ kind: "paidCall", priceUsdc: 0.1 }],
  steps: [
    { id: "n1", type: "llm", config: { prompt: "hi {{in}}" }, after: [] },
    { id: "n2", type: "output", config: {}, after: ["n1"] },
  ],
  meta: { createdBy: "guided" },
};

describe("POST /api/companies/found", () => {
  it("returns 401 when unauthenticated", async () => {
    state.resolveOwnerId.mockRejectedValueOnce(new state.UnauthenticatedOwnerError());
    const { POST } = await foundRoute();

    const res = await POST(foundRequest({ message: "found a research company", history: [] }));

    expect(res.status).toBe(401);
    expect(state.runCompanyGuidedTurn).not.toHaveBeenCalled();
  });

  it("rejects anonymous workspace owners even when owner resolution succeeds", async () => {
    state.resolveOwnerId.mockResolvedValueOnce("anonymous-workspace");
    const { POST } = await foundRoute();

    const res = await POST(foundRequest({ message: "found a research company", history: [] }));

    expect(res.status).toBe(401);
    expect(state.runCompanyGuidedTurn).not.toHaveBeenCalled();
  });

  it("rejects cross-origin mutations before BotID or auth", async () => {
    const { POST } = await foundRoute();
    const request = foundRequest({ message: "found a research company", history: [] });
    request.headers.set("origin", "https://evil.example");

    const res = await POST(request);

    expect(res.status).toBe(403);
    expect(state.checkBotId).not.toHaveBeenCalled();
    expect(state.resolveOwnerId).not.toHaveBeenCalled();
  });

  it("returns 403 when BotID detects automation, before touching auth", async () => {
    state.checkBotId.mockResolvedValueOnce({ isBot: true });
    const { POST } = await foundRoute();

    const res = await POST(foundRequest({ message: "found a research company", history: [] }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "automated_request_blocked" });
    expect(state.resolveOwnerId).not.toHaveBeenCalled();
  });

  it("passes a clarifying-question turn through with notIncluded", async () => {
    state.runCompanyGuidedTurn.mockResolvedValueOnce({
      clarifyingQuestion: "What should the company be called?",
      company: null,
      notIncluded: ["custom domain purchase"],
    });
    const { POST } = await foundRoute();

    const res = await POST(foundRequest({ message: "found a research company", history: [] }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      clarifyingQuestion: "What should the company be called?",
      notIncluded: ["custom domain purchase"],
    });
  });

  it("materialize=false returns the draft for review without creating a company", async () => {
    const draft = {
      name: "Acme Research",
      mission: "Ship a weekly market brief.",
      departments: [
        {
          name: "Research",
          monthlyBudgetUsdc: null,
          employees: [
            {
              slug: "brief-writer",
              jobDescription: "Drafts the weekly brief.",
              monthlyBudgetUsdc: null,
              publishGated: false,
              manifest: MINIMAL_MANIFEST,
            },
          ],
        },
      ],
    };
    state.runCompanyGuidedTurn.mockResolvedValueOnce({
      clarifyingQuestion: null,
      company: draft,
      notIncluded: [],
    });
    const { POST } = await foundRoute();

    const res = await POST(foundRequest({ message: "found a research company", history: [] }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ company: draft, notIncluded: [] });
    // A review turn must WRITE nothing. `getRepo` is no longer proof of that
    // — the route now resolves a repo to build the model-spend billing
    // context (gateway/model-spend.ts) — so assert the thing that actually
    // matters: no company exists afterwards.
    expect(await repo.listCompaniesByOwner(state.owner)).toHaveLength(0);
  });

  it("materialize=true founds the exact reviewed company without re-running the guided brain", async () => {
    const draft = {
      name: "Acme Research",
      mission: "Ship a weekly market brief.",
      departments: [
        {
          name: "Research",
          monthlyBudgetUsdc: null,
          employees: [
            {
              slug: "brief-writer",
              jobDescription: "Drafts the weekly brief.",
              monthlyBudgetUsdc: 12.5,
              publishGated: false,
              manifest: MINIMAL_MANIFEST,
            },
          ],
        },
      ],
    };
    const { POST } = await foundRoute();

    const res = await POST(
      foundRequest({ materialize: true, company: draft, notIncluded: ["automatic publishing"] }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { companyId?: string; notIncluded?: string[] };
    expect(typeof body.companyId).toBe("string");
    expect(body.notIncluded).toEqual(["automatic publishing"]);
    expect(state.runCompanyGuidedTurn).not.toHaveBeenCalled();

    const companies = await repo.listCompaniesByOwner(state.owner);
    expect(companies).toHaveLength(1);
    expect(companies[0]?.id).toBe(body.companyId);
    expect(companies[0]?.name).toBe("Acme Research");

    const employees = await repo.listEmployees(body.companyId as string);
    expect(employees).toHaveLength(1);
    expect(employees[0]?.jobDescription).toBe("Drafts the weekly brief.");
    expect(employees[0]?.monthlyBudgetUsdc).toBe(12.5);
    expect(employees[0]?.publishGated).toBe(false);
  });

  it("rejects materialize=true without a validated reviewed draft instead of regenerating it", async () => {
    const { POST } = await foundRoute();

    const res = await POST(
      foundRequest({
        message: "found a research company",
        history: [],
        materialize: true,
      }),
    );

    expect(res.status).toBe(400);
    expect(state.runCompanyGuidedTurn).not.toHaveBeenCalled();
    expect(state.getRepo).not.toHaveBeenCalled();
  });

  it("rejects an invalid reviewed manifest at the server boundary", async () => {
    const { POST } = await foundRoute();

    const res = await POST(
      foundRequest({
        materialize: true,
        company: {
          name: "Acme Research",
          mission: "Ship a weekly market brief.",
          departments: [
            {
              name: "Research",
              monthlyBudgetUsdc: null,
              employees: [
                {
                  slug: "brief-writer",
                  jobDescription: "Drafts the weekly brief.",
                  monthlyBudgetUsdc: null,
                  publishGated: false,
                  manifest: { ...MINIMAL_MANIFEST, triggers: [] },
                },
              ],
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(400);
    expect(state.runCompanyGuidedTurn).not.toHaveBeenCalled();
    expect(state.getRepo).not.toHaveBeenCalled();
  });

  it("rejects empty departments and negative department budgets", async () => {
    const { POST } = await foundRoute();

    const empty = await POST(foundRequest({
      materialize: true,
      company: { name: "Acme", mission: "Research.", departments: [] },
    }));
    expect(empty.status).toBe(400);

    const negative = await POST(foundRequest({
      materialize: true,
      company: {
        name: "Acme",
        mission: "Research.",
        departments: [{
          name: "Research",
          monthlyBudgetUsdc: -1,
          employees: [{
            slug: "brief-writer",
            jobDescription: "Writes briefs.",
            monthlyBudgetUsdc: null,
            publishGated: false,
            manifest: MINIMAL_MANIFEST,
          }],
        }],
      },
    }));
    expect(negative.status).toBe(400);
    expect(state.getRepo).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when the rate limit is exceeded", async () => {
    state.checkRateLimit.mockReturnValueOnce({ allowed: false, retryAfterSec: 42 });
    const { POST } = await foundRoute();

    const res = await POST(foundRequest({ message: "found a research company", history: [] }));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    const body = (await res.json()) as { retryAfterSec?: number };
    expect(body.retryAfterSec).toBe(42);
    expect(state.runCompanyGuidedTurn).not.toHaveBeenCalled();
  });
});
