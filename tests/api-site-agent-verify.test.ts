import { beforeEach, describe, expect, it, vi } from "vitest";
import { siteVerificationToken } from "@/lib/site/verification";

const { checkBotIdMock, checkRateLimitMock, checkFileMock } = vi.hoisted(() => ({
  checkBotIdMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  checkFileMock: vi.fn(),
}));

vi.mock("botid/server", () => ({ checkBotId: checkBotIdMock }));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (key: string) => (key === "x-owner-id" ? "test-owner-site-verify" : null),
  }),
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: checkRateLimitMock,
}));

// The real file check makes an outbound request; the route contract under
// test is auth -> validation -> check -> persistence, so the check is pinned.
vi.mock("@/lib/site/verification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/site/verification")>()),
  checkSiteVerificationFile: checkFileMock,
}));

const { GET, POST } = await import("@/app/api/site-agent/verify/route");

const OWNER = "cafe0000-1111-2222-3333-444455556666";

const SESSION_HEADERS = {
  "content-type": "application/json",
  origin: "https://agents.suedeai.ai",
  "sec-fetch-site": "same-origin",
} as const;

function get(host: string, bearer = OWNER): Promise<Response> {
  return GET(
    new Request(`https://agents.suedeai.ai/api/site-agent/verify?host=${encodeURIComponent(host)}`, {
      headers: { authorization: `Bearer ${bearer}` },
    }),
  );
}

function post(
  body: unknown,
  headers: Record<string, string> = { ...SESSION_HEADERS, authorization: `Bearer ${OWNER}` },
): Promise<Response> {
  return POST(
    new Request("https://agents.suedeai.ai/api/site-agent/verify", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe("/api/site-agent/verify", () => {
  beforeEach(() => {
    checkBotIdMock.mockReset().mockResolvedValue({ isBot: false });
    checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, retryAfterSec: 0 });
    checkFileMock.mockReset().mockResolvedValue({ ok: true });
  });

  it("GET returns the token, the well-known location, and unverified status", async () => {
    const response = await get("Acme.Example");

    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.host).toBe("acme.example");
    expect(json.token).toBe(siteVerificationToken(OWNER, "acme.example"));
    expect(json.url).toBe("https://acme.example/.well-known/suede-agent.txt");
    expect(json.verified).toBe(false);
  });

  it("GET rejects a missing or bogus host", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("localhost")).status).toBe(400);
  });

  it("POST rejects invalid session mutation headers before BotID", async () => {
    const response = await post(
      { host: "acme.example" },
      { "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    );

    expect(response.status).toBe(403);
    expect(checkBotIdMock).not.toHaveBeenCalled();
  });

  it("POST blocks automated callers before any outbound fetch", async () => {
    checkBotIdMock.mockResolvedValueOnce({ isBot: true });

    const response = await post({ host: "acme.example" });

    expect(response.status).toBe(403);
    expect(checkFileMock).not.toHaveBeenCalled();
  });

  it("POST verifies, persists, and GET then reports verified", async () => {
    const response = await post({ host: "acme.example" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ verified: true, host: "acme.example" });
    expect(checkFileMock).toHaveBeenCalledWith(
      "acme.example",
      siteVerificationToken(OWNER, "acme.example"),
    );

    const status = await get("acme.example");
    const json = (await status.json()) as Record<string, unknown>;
    expect(json.verified).toBe(true);
  });

  it("POST reports a failed check as 409 with the reason, and persists nothing", async () => {
    checkFileMock.mockResolvedValueOnce({ ok: false, reason: "file missing" });

    const response = await post({ host: "unverified.example" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ verified: false, reason: "file missing" });

    const status = await get("unverified.example");
    expect(((await status.json()) as Record<string, unknown>).verified).toBe(false);
  });

  it("POST scopes proof to the workspace that earned it", async () => {
    await post({ host: "scoped.example" });

    const other = await get("scoped.example", "another-owner-key");
    expect(((await other.json()) as Record<string, unknown>).verified).toBe(false);
  });

  it("POST returns 429 with a retry hint when over budget", async () => {
    checkRateLimitMock.mockReturnValueOnce({ allowed: false, retryAfterSec: 30 });

    const response = await post({ host: "acme.example" });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(checkFileMock).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ host: "" }], [{ host: "acme.example", extra: 1 }]])(
    "POST returns 400 for %j",
    async (body) => {
      expect((await post(body)).status).toBe(400);
    },
  );
});
