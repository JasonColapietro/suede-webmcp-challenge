import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  resolveReviewer: vi.fn(),
  checkRateLimit: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/moderation/reviewer", () => ({
  resolveModerationReviewer: (...args: unknown[]) => state.resolveReviewer(...args),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => state.checkRateLimit(...args),
}));

const REVIEWER = "reviewer@suedeai.ai";

function upstream(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetModules();
  state.resolveReviewer.mockReset();
  state.checkRateLimit.mockReset().mockReturnValue({ allowed: true, retryAfterSec: 0 });
  state.fetchMock.mockReset();
  vi.stubGlobal("fetch", state.fetchMock);
  process.env.PROMO_AGENT_KEY = "test-agent-key";
});

async function route() {
  return import("@/app/api/moderation/promo-claims/route");
}

describe("GET /api/moderation/promo-claims", () => {
  it("refuses a caller who is not an allowlisted reviewer", async () => {
    state.resolveReviewer.mockResolvedValue(null);
    const { GET } = await route();

    const res = await GET(new Request("https://agents.suedeai.ai/api/moderation/promo-claims"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "reviewer_only" });
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it("passes the upstream claim list through verbatim for a reviewer", async () => {
    state.resolveReviewer.mockResolvedValue(REVIEWER);
    const payload = { claims: [{ claim_id: "c-1", status: "inconclusive" }], total: 1 };
    state.fetchMock.mockResolvedValue(upstream(200, payload));
    const { GET } = await route();

    const res = await GET(new Request("https://agents.suedeai.ai/api/moderation/promo-claims"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    const [url, init] = state.fetchMock.mock.calls[0];
    expect(String(url)).toContain("status=inconclusive%2Cdisputed");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-agent-key",
    });
  });

  it("rejects an unknown status filter before calling Promo", async () => {
    state.resolveReviewer.mockResolvedValue(REVIEWER);
    const { GET } = await route();

    const res = await GET(
      new Request("https://agents.suedeai.ai/api/moderation/promo-claims?status=bogus"),
    );

    expect(res.status).toBe(400);
    expect(state.fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/moderation/promo-claims", () => {
  const claimId = "11111111-2222-3333-4444-555555555555";

  function post(body: unknown): Request {
    return new Request("https://agents.suedeai.ai/api/moderation/promo-claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("refuses a caller who is not an allowlisted reviewer", async () => {
    state.resolveReviewer.mockResolvedValue(null);
    const { POST } = await route();

    const res = await POST(post({ claimId, resolution: "approved" }));

    expect(res.status).toBe(403);
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid resolution before any upstream call", async () => {
    state.resolveReviewer.mockResolvedValue(REVIEWER);
    const { POST } = await route();

    const res = await POST(post({ claimId, resolution: "settled" }));

    expect(res.status).toBe(400);
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it("stamps the reviewer identity onto the upstream resolution", async () => {
    state.resolveReviewer.mockResolvedValue(REVIEWER);
    state.fetchMock.mockResolvedValue(upstream(200, { claimId, status: "approved" }));
    const { POST } = await route();

    const res = await POST(post({ claimId, resolution: "approved", note: "verified by hand" }));

    expect(res.status).toBe(200);
    const [, init] = state.fetchMock.mock.calls[0];
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toEqual({
      claimId,
      resolution: "approved",
      reviewer: REVIEWER,
      note: "verified by hand",
    });
  });

  it("passes a Promo conflict through unchanged so Promo's record wins", async () => {
    state.resolveReviewer.mockResolvedValue(REVIEWER);
    state.fetchMock.mockResolvedValue(upstream(409, { error: "claim_not_reviewable" }));
    const { POST } = await route();

    const res = await POST(post({ claimId, resolution: "rejected" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "claim_not_reviewable" });
  });
});
