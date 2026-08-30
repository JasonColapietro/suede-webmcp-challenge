/**
 * POST /api/me/claim is the workspace-takeover path: the pasted key IS the
 * bearer secret. It must be rate limited per IP so a leaked-key spraying
 * attempt (or a client retry storm) cannot run unbounded.
 */
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/me/claim/route";

const KEY = "7f3c2a10-1111-4222-8333-944455566677";

function claim(ip: string, token: string = KEY): Promise<Response> {
  return POST(
    new Request("http://localhost:3210/api/me/claim", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify({ token }),
    }),
  ) as unknown as Promise<Response>;
}

// Buckets are process-global and per key, so every test uses its own IP
// instead of resetting shared state.
describe("claim rate limit", () => {
  it("sets the owner cookie on a valid key", async () => {
    const res = await claim("203.0.113.10");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("agx_owner=");
  });

  it.each([
    KEY.toUpperCase(),
    "7f3c2a10-1111-1222-8333-944455566677",
    `${KEY} `,
  ])("rejects a non-canonical workspace key %j", async (token) => {
    const res = await claim(`203.0.113.${20 + token.length % 10}`, token);
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("429s with Retry-After once the per-IP burst is spent", async () => {
    const ip = "203.0.113.11";
    for (let i = 0; i < 10; i += 1) {
      expect((await claim(ip)).status).toBe(200);
    }
    const limited = await claim(ip);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("meters a rejected guess too, so invalid tokens are not a free oracle", async () => {
    const ip = "203.0.113.12";
    for (let i = 0; i < 10; i += 1) {
      expect((await claim(ip, "not-a-uuid")).status).toBe(400);
    }
    expect((await claim(ip)).status).toBe(429);
  });

  it("buckets per IP rather than globally", async () => {
    const ip = "203.0.113.13";
    for (let i = 0; i < 10; i += 1) await claim(ip);
    expect((await claim(ip)).status).toBe(429);
    expect((await claim("203.0.113.14")).status).toBe(200);
  });
});
