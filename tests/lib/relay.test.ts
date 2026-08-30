/**
 * Tests for src/lib/relay.ts
 * sign/verify HMAC, forwardToRelay success/error/timeout/oversized paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signRelayRequest, verifyRelayRequest } from "@/lib/relay";

// forwardToRelay now re-resolves the relay hostname via safeFetch before
// connecting (SSRF guard). Stub DNS so these tests don't depend on real
// network resolution of relay.example.com et al. — always answer with a
// public IP; SSRF-specific behavior is covered in tests/lib/safe-url.test.ts.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

// ── sign/verify pair with known vectors ────────────────────────────────────

describe("signRelayRequest", () => {
  it("returns a sha256=<hex> prefixed string", () => {
    const sig = signRelayRequest("hello", "secret");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("produces a deterministic signature for the same inputs", () => {
    const a = signRelayRequest("body-data", "key123");
    const b = signRelayRequest("body-data", "key123");
    expect(a).toBe(b);
  });

  it("produces different signatures for different bodies", () => {
    const a = signRelayRequest("body-a", "key");
    const b = signRelayRequest("body-b", "key");
    expect(a).not.toBe(b);
  });

  it("produces different signatures for different secrets", () => {
    const a = signRelayRequest("body", "secret-a");
    const b = signRelayRequest("body", "secret-b");
    expect(a).not.toBe(b);
  });
});

describe("verifyRelayRequest", () => {
  it("returns true for a valid signature", () => {
    const body = JSON.stringify({ hello: "world" });
    const secret = "test-secret-32-bytes-padded-12345678";
    const sig = signRelayRequest(body, secret);
    expect(verifyRelayRequest(body, secret, sig)).toBe(true);
  });

  it("returns false for a tampered body", () => {
    const secret = "test-secret";
    const sig = signRelayRequest("original", secret);
    expect(verifyRelayRequest("tampered", secret, sig)).toBe(false);
  });

  it("returns false for a wrong secret", () => {
    const body = "body";
    const sig = signRelayRequest(body, "correct-secret");
    expect(verifyRelayRequest(body, "wrong-secret", sig)).toBe(false);
  });

  it("returns false for a malformed signature (no sha256= prefix)", () => {
    expect(verifyRelayRequest("body", "secret", "badhex")).toBe(false);
  });

  it("returns false for an empty signature", () => {
    expect(verifyRelayRequest("body", "secret", "")).toBe(false);
  });

  it("uses constant-time compare (no timing error for different-length sigs)", () => {
    // Should not throw; returns false cleanly
    expect(verifyRelayRequest("body", "secret", "sha256=tooshort")).toBe(false);
  });
});

// ── forwardToRelay (stub fetch) ─────────────────────────────────────────────

describe("forwardToRelay", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to relay.url and returns parsed response on success", async () => {
    const { forwardToRelay } = await import("@/lib/relay");
    const responseBody = { result: "ok" };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(responseBody), { status: 200 }),
    );

    const output = await forwardToRelay(
      { question: "hello" },
      { url: "https://relay.example.com/run", secret: "s3cr3t" },
      "run-123",
      "test-agent",
    );

    expect(output).toEqual(responseBody);
    const [calledUrl, calledInit] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://relay.example.com/run");
    expect(calledInit.method).toBe("POST");
    const bodyStr = calledInit.body as string;
    const bodyParsed = JSON.parse(bodyStr) as Record<string, unknown>;
    expect(bodyParsed.runId).toBe("run-123");
    expect(bodyParsed.agent).toBe("test-agent");
    expect(bodyParsed.input).toEqual({ question: "hello" });
    // Verify signature header is present
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["x-suede-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers["x-suede-timestamp"]).toMatch(/^\d{4}-/);
  });

  it("throws RelayError on non-200 response", async () => {
    const { forwardToRelay, RelayError } = await import("@/lib/relay");
    const cancel = vi.fn();
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), { status: 500 }),
    );

    await expect(
      forwardToRelay({}, { url: "https://relay.example.com/run", secret: "s3cr3t" }, "r1", "slug"),
    ).rejects.toBeInstanceOf(RelayError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("throws RelayError on a response body > 256 KB", async () => {
    const { forwardToRelay, RelayError } = await import("@/lib/relay");
    const big = "x".repeat(257 * 1024);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(big, { status: 200 }),
    );

    await expect(
      forwardToRelay({}, { url: "https://relay.example.com/run", secret: "s3cr3t" }, "r1", "slug"),
    ).rejects.toBeInstanceOf(RelayError);
  });

  it("throws RelayError on fetch rejection (network error / timeout)", async () => {
    const { forwardToRelay, RelayError } = await import("@/lib/relay");
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network failure"));

    await expect(
      forwardToRelay({}, { url: "https://relay.example.com/run", secret: "s3cr3t" }, "r1", "slug"),
    ).rejects.toBeInstanceOf(RelayError);
  });
});
