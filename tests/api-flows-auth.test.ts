/**
 * Regression: resolveOwnerId() throws UnauthenticatedOwnerError (401) in
 * production when neither the x-owner-id header nor the agx_owner cookie is
 * present (see src/lib/auth.ts and tests/lib/auth.test.ts). The routes under
 * src/app/api/me, /guided, and /portfolio already map that to a 401
 * response. The routes under src/app/api/flows/** were added on a parallel
 * branch and didn't get that mapping, so an unauthenticated request fell
 * through their generic catch block and came back as a 500 instead of a
 * 401. This tests that every flows route now maps it correctly, following
 * the pattern already used in src/app/api/me/route.ts and
 * src/app/api/guided/route.ts.
 *
 * Follows tests/lib/auth.test.ts and tests/api-flows-cycle.test.ts's
 * convention of mocking next/headers and importing the route handlers
 * directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ get: () => undefined }),
}));

const { GET: flowsGet, POST: flowsPost } = await import("@/app/api/flows/route");
const { GET: flowGet, PUT: flowPut, DELETE: flowDelete } = await import("@/app/api/flows/[id]/route");
const { GET: flowBackupGet, POST: flowBackupPost } = await import("@/app/api/flows/backup/route");
const { POST: flowLaunch } = await import("@/app/api/flows/[id]/launch/route");
const { POST: flowRun } = await import("@/app/api/flows/[id]/run/route");

const params = { params: Promise.resolve({ id: "does-not-matter" }) };

function jsonRequest(url: string, body: unknown = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("flows routes — unauthenticated requests map to 401, not 500", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("GET /api/flows", async () => {
    const res = await flowsGet();
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Authentication required");
  });

  it("POST /api/flows", async () => {
    const res = await flowsPost(jsonRequest("https://agents.suedeai.ai/api/flows", { name: "x" }));
    expect(res.status).toBe(401);
  });

  it("GET /api/flows/backup", async () => {
    const res = await flowBackupGet();
    expect(res.status).toBe(401);
  });

  it("POST /api/flows/backup", async () => {
    const res = await flowBackupPost(
      jsonRequest("https://agents.suedeai.ai/api/flows/backup"),
    );
    expect(res.status).toBe(401);
  });

  it("GET /api/flows/[id]", async () => {
    const res = await flowGet(new Request("https://agents.suedeai.ai/api/flows/x"), params);
    expect(res.status).toBe(401);
  });

  it("PUT /api/flows/[id]", async () => {
    const res = await flowPut(
      jsonRequest("https://agents.suedeai.ai/api/flows/x", { name: "x", graph: {} }),
      params,
    );
    expect(res.status).toBe(401);
  });

  it("DELETE /api/flows/[id]", async () => {
    const res = await flowDelete(new Request("https://agents.suedeai.ai/api/flows/x"), params);
    expect(res.status).toBe(401);
  });

  it("POST /api/flows/[id]/launch", async () => {
    const res = await flowLaunch(
      jsonRequest("https://agents.suedeai.ai/api/flows/x/launch"),
      params,
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/flows/[id]/run", async () => {
    const res = await flowRun(jsonRequest("https://agents.suedeai.ai/api/flows/x/run"), params);
    expect(res.status).toBe(401);
  });
});
