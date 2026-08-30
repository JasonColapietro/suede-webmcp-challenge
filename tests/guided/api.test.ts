import { beforeEach, describe, it, expect, vi } from "vitest";

const { checkBotIdMock } = vi.hoisted(() => ({
  checkBotIdMock: vi.fn(),
}));

vi.mock("botid/server", () => ({
  checkBotId: checkBotIdMock,
}));

// Stub next/headers before importing the route.
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k === "x-owner-id" ? "test-owner-guided-api" : null),
  }),
  cookies: async () => ({ get: () => undefined }),
}));

// Import the POST handler after mocks are in place.
const { POST } = await import("@/app/api/guided/route");

async function callGuided(
  body: Record<string, unknown>,
  ownerHeader = "test-owner-guided-default",
): Promise<Response> {
  return POST(
    new Request("https://agents.suedeai.ai/api/guided", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://agents.suedeai.ai",
        "sec-fetch-site": "same-origin",
        "x-owner-id": ownerHeader,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/guided", () => {
  beforeEach(() => {
    checkBotIdMock.mockReset();
    checkBotIdMock.mockResolvedValue({ isBot: false });
  });

  it.each([
    [{ "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, 403],
    [{ "content-type": "text/plain", origin: "https://agents.suedeai.ai", "sec-fetch-site": "same-origin" }, 415],
    [{ "content-type": "application/json", origin: "https://agents.suedeai.ai" }, 403],
  ] as const)("rejects invalid Guided session mutation headers before BotID", async (headers, status) => {
    const request = new Request("https://agents.suedeai.ai/api/guided", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "save", flowId: "flow", manifest: {} }),
    });

    const response = await POST(request);

    expect(response.status).toBe(status);
    expect(checkBotIdMock).not.toHaveBeenCalled();
  });

  it("returns 403 before running the guided flow when BotID detects automation", async () => {
    checkBotIdMock.mockResolvedValueOnce({ isBot: true });

    const res = await callGuided(
      { message: "watch a product page for price drops", history: [] },
      "owner-api-bot",
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "automated_request_blocked" });
  });

  it("returns 200 with a clarifyingQuestion on the first turn", async () => {
    const res = await callGuided(
      { message: "watch a product page for price drops", history: [] },
      "owner-api-t1",
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const hasQuestion = typeof json.clarifyingQuestion === "string";
    const hasManifest = json.manifest !== null && json.manifest !== undefined;
    // XOR: exactly one non-null
    expect(hasQuestion !== hasManifest).toBe(true);
  });

  it("returns 400 when message is missing", async () => {
    const res = await callGuided({ history: [] }, "owner-api-t2");
    expect(res.status).toBe(400);
  });

  it("returns 400 when history is not an array", async () => {
    const res = await callGuided({ message: "hello", history: "bad" }, "owner-api-t3");
    expect(res.status).toBe(400);
  });

  it("returns a manifest (not a question) when history has 3 prior exchanges", async () => {
    const history = [
      { role: "user", content: "watch a product page" },
      { role: "assistant", content: "What would you like to name this agent?" },
      { role: "user", content: "Price Drop Alerter" },
      { role: "assistant", content: "How often should it run?" },
      { role: "user", content: "daily at 9am" },
      { role: "assistant", content: "Last question. What price per call?" },
    ];
    // 4th user message — must trigger a draft.
    const res = await callGuided({ message: "0.05", history }, "owner-api-t4");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.manifest).not.toBeNull();
    expect(json.clarifyingQuestion).toBeNull();
  });

  it("returns 429 with retryAfterSec when rate limit is exceeded", async () => {
    const ownerKey = "owner-api-ratelimit-unique";
    let lastRes!: Response;
    // capacity=6, so 7 calls should trigger a 429
    for (let i = 0; i < 7; i++) {
      lastRes = await callGuided({ message: "test", history: [] }, ownerKey);
    }
    expect(lastRes.status).toBe(429);
    const json = (await lastRes.json()) as Record<string, unknown>;
    expect(typeof json.retryAfterSec).toBe("number");
    expect((json.retryAfterSec as number)).toBeGreaterThan(0);
  });
});
