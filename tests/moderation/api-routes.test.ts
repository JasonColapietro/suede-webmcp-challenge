import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import type { FlowGraph } from "@/lib/flow/types";

const state = vi.hoisted(() => {
  class UnauthenticatedOwnerError extends Error {
    status = 401;
  }
  return {
    checkBotId: vi.fn(),
    checkRateLimit: vi.fn(),
    getRepo: vi.fn(),
    resolveOwnerId: vi.fn(),
    resolveReviewer: vi.fn(),
    UnauthenticatedOwnerError,
  };
});

vi.mock("botid/server", () => ({
  checkBotId: (...args: unknown[]) => state.checkBotId(...args),
}));
vi.mock("@/lib/auth", () => ({
  resolveOwnerId: (...args: unknown[]) => state.resolveOwnerId(...args),
  UnauthenticatedOwnerError: state.UnauthenticatedOwnerError,
}));
vi.mock("@/lib/db/repo", () => ({
  getRepo: (...args: unknown[]) => state.getRepo(...args),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => state.checkRateLimit(...args),
}));
vi.mock("@/lib/moderation/reviewer", () => ({
  resolveModerationReviewer: (...args: unknown[]) => state.resolveReviewer(...args),
}));

const graph: FlowGraph = {
  id: "graph-1",
  name: "Moderated flow",
  nodes: [{ id: "input", type: "input", params: {}, position: { x: 0, y: 0 } }],
  edges: [],
};

let repo: SqliteRepo;
let flowId: string;
let runId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  repo = new SqliteRepo(":memory:");
  const flow = await repo.saveFlow({ ownerId: "owner-1", name: "Moderated flow", graph });
  const run = await repo.createRun({ flowId: flow.id, trigger: "manual" });
  flowId = flow.id;
  runId = run.id;
  state.checkBotId.mockResolvedValue({ isBot: false });
  state.checkRateLimit.mockReturnValue({ allowed: true, retryAfterSec: 0 });
  state.getRepo.mockResolvedValue(repo);
  state.resolveOwnerId.mockResolvedValue("owner-1");
  state.resolveReviewer.mockResolvedValue("reviewer@example.com");
});

function request(
  path: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
): Request {
  return new Request(`https://agents.suedeai.ai${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: "https://agents.suedeai.ai",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

async function collectionRoute() {
  return import("@/app/api/moderation/reports/route");
}

async function itemRoute() {
  return import("@/app/api/moderation/reports/[id]/route");
}

describe("moderation report API", () => {
  it("rejects cross-origin submissions before BotID, auth, or storage", async () => {
    const { POST } = await collectionRoute();
    const req = request("/api/moderation/reports", "POST", {
      subjectType: "run_output",
      flowId,
      runId,
      reason: "other_unsafe_content",
    });
    req.headers.set("origin", "https://evil.example");

    const response = await POST(req);

    expect(response.status).toBe(403);
    expect(state.checkBotId).not.toHaveBeenCalled();
    expect(state.resolveOwnerId).not.toHaveBeenCalled();
    expect(state.getRepo).not.toHaveBeenCalled();
  });

  it("blocks detected automation before auth or storage", async () => {
    state.checkBotId.mockResolvedValueOnce({ isBot: true });
    const { POST } = await collectionRoute();

    const response = await POST(request("/api/moderation/reports", "POST", {
      subjectType: "run_output",
      flowId,
      runId,
      reason: "other_unsafe_content",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "automated_request_blocked" });
    expect(state.resolveOwnerId).not.toHaveBeenCalled();
    expect(state.getRepo).not.toHaveBeenCalled();
  });

  it("creates an identifier-only report and rejects copied output or free text", async () => {
    const { POST } = await collectionRoute();
    const unsafe = await POST(request("/api/moderation/reports", "POST", {
      subjectType: "run_output",
      flowId,
      runId,
      reason: "other_unsafe_content",
      output: "copied generated output",
    }));
    expect(unsafe.status).toBe(400);

    const freeText = await POST(request("/api/moderation/reports", "POST", {
      subjectType: "run_output",
      flowId,
      runId,
      reason: "other_unsafe_content",
      details: "copied private context",
    }));
    expect(freeText.status).toBe(400);

    const response = await POST(request("/api/moderation/reports", "POST", {
      subjectType: "run_output",
      flowId,
      runId,
      nodeId: "input",
      reason: "other_unsafe_content",
    }));
    expect(response.status).toBe(201);
    const queue = await repo.listModerationReports({ limit: 10 });
    expect(queue).toHaveLength(1);
    expect(queue[0]).not.toHaveProperty("output");
    expect(queue[0]).not.toHaveProperty("details");
  });

  it("returns Retry-After when the owner report budget is exhausted", async () => {
    state.checkRateLimit.mockReturnValueOnce({ allowed: false, retryAfterSec: 17 });
    const { POST } = await collectionRoute();

    const response = await POST(request("/api/moderation/reports", "POST", {
      subjectType: "run_output",
      flowId,
      runId,
      reason: "other_unsafe_content",
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(state.getRepo).not.toHaveBeenCalled();
  });

  it("keeps queue reads private to an allowlisted reviewer", async () => {
    state.resolveReviewer.mockResolvedValueOnce(null);
    const { GET } = await collectionRoute();

    const denied = await GET(new Request("https://agents.suedeai.ai/api/moderation/reports"));
    expect(denied.status).toBe(403);
    expect(state.getRepo).not.toHaveBeenCalled();

    await repo.createModerationReport({
      reporterOwnerId: "owner-1",
      subjectOwnerId: "owner-1",
      subjectType: "run_output",
      flowId,
      runId,
      reason: "other_unsafe_content",
    });
    const allowed = await GET(new Request(
      "https://agents.suedeai.ai/api/moderation/reports?status=open&limit=10",
    ));
    expect(allowed.status).toBe(200);
    const body = await allowed.json() as { reports: unknown[] };
    expect(body.reports).toHaveLength(1);
  });

  it("same-origin reviewer updates preserve audit identity and reject foreign origins", async () => {
    const report = await repo.createModerationReport({
      reporterOwnerId: "owner-1",
      subjectOwnerId: "owner-1",
      subjectType: "run_output",
      flowId,
      runId,
      reason: "other_unsafe_content",
    });
    const { PATCH } = await itemRoute();
    const foreign = request(`/api/moderation/reports/${report.id}`, "PATCH", {
      status: "resolved",
    });
    foreign.headers.set("origin", "https://evil.example");
    const denied = await PATCH(foreign, { params: Promise.resolve({ id: report.id }) });
    expect(denied.status).toBe(403);
    expect(state.resolveReviewer).not.toHaveBeenCalled();

    const allowed = await PATCH(request(`/api/moderation/reports/${report.id}`, "PATCH", {
      status: "resolved",
      reviewerNotes: "Reviewed against authoritative records.",
    }), { params: Promise.resolve({ id: report.id }) });
    expect(allowed.status).toBe(200);
    const updated = await allowed.json() as { report: { status: string; reviewedBy: string } };
    expect(updated.report).toMatchObject({
      status: "resolved",
      reviewedBy: "reviewer@example.com",
    });
  });
});
