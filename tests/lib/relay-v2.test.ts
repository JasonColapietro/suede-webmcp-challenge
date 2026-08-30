import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeFetch } from "@/lib/net/safe-url";
import { signRelayRequest } from "@/lib/relay";
import {
  executeRelayV2,
  queryRelayV2Status,
  relayV2EndpointBindingHash,
  type RelayV2Delivery,
} from "@/lib/relay-v2";

vi.mock("@/lib/net/safe-url", () => ({
  safeFetch: vi.fn(),
}));

const relay = {
  url: "https://relay.example.com/v2",
  secret: "relay-secret-that-must-never-be-returned",
};

const issuedAt = "2026-08-13T16:00:00.000Z";
const notAfter = "2026-08-13T16:00:15.000Z";

function responseBody(
  state: RelayV2Delivery["state"],
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      protocol: "suede-relay/2",
      deliveryId: "run-123",
      state,
      ...extra,
    }),
    { status: state === "failed" ? 500 : 200 },
  );
}

describe("relayV2EndpointBindingHash", () => {
  it("binds the exact URL, creation time, and protocol version deterministically", () => {
    const binding = {
      url: "https://relay.example.com/v2",
      createdAt: "2026-08-13T15:59:00.000Z",
      protocolVersion: "suede-relay/2",
    } as const;

    expect(relayV2EndpointBindingHash(binding)).toBe(
      "sha256=1a860e3250893deb848bbae394bda6e78d3c64f56e4ebb679b409f7a584da570",
    );
    expect(relayV2EndpointBindingHash(binding)).toBe(relayV2EndpointBindingHash(binding));
  });

  it("changes when any bound endpoint attribute changes", () => {
    const base = {
      url: "https://relay.example.com/v2",
      createdAt: "2026-08-13T15:59:00.000Z",
      protocolVersion: "suede-relay/2",
    };
    const values = [
      relayV2EndpointBindingHash(base),
      relayV2EndpointBindingHash({ ...base, url: "https://other.example.com/v2" }),
      relayV2EndpointBindingHash({ ...base, createdAt: "2026-08-13T16:00:00.000Z" }),
      relayV2EndpointBindingHash({ ...base, protocolVersion: "suede-relay/3" }),
    ];

    expect(new Set(values).size).toBe(values.length);
  });
});

describe("executeRelayV2", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(issuedAt));
    vi.mocked(safeFetch).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs the full execute body and sends one bounded non-redirecting POST", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(
      responseBody("completed", { output: { verdict: "approved" } }),
    );

    const result = await executeRelayV2({
      relay,
      runId: "run-123",
      agent: "po-match-gate-mkgu0",
      input: { invoice: "INV-42" },
    });

    expect(result).toEqual({
      kind: "delivery",
      protocol: "suede-relay/2",
      deliveryId: "run-123",
      state: "completed",
      output: { verdict: "approved" },
      httpStatus: 200,
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, init, options] = vi.mocked(safeFetch).mock.calls[0];
    if (!init) throw new Error("relay request init missing");
    expect(url).toBe(relay.url);
    expect(options).toEqual({ timeoutMs: 15_000, maxRedirects: 0 });
    expect(init.method).toBe("POST");
    const rawBody = String(init.body);
    expect(JSON.parse(rawBody)).toEqual({
      protocol: "suede-relay/2",
      operation: "execute",
      deliveryId: "run-123",
      agent: "po-match-gate-mkgu0",
      input: { invoice: "INV-42" },
      issuedAt,
      notAfter,
    });
    const headers = init.headers as Record<string, string>;
    expect(headers).toEqual({
      "Content-Type": "application/json",
      "x-suede-signature": signRelayRequest(rawBody, relay.secret),
      "x-suede-timestamp": issuedAt,
      "Idempotency-Key": "run-123",
    });
  });

  it.each(["completed", "failed", "accepted", "running", "unknown"] as const)(
    "accepts a delivery-ID-matching %s response",
    async (state) => {
      vi.mocked(safeFetch).mockResolvedValueOnce(responseBody(state, { output: "kept" }));

      const result = await executeRelayV2({
        relay,
        runId: "run-123",
        agent: "agent",
        input: null,
      });

      expect(result.kind).toBe("delivery");
      expect((result as RelayV2Delivery).state).toBe(state);
      expect((result as RelayV2Delivery).deliveryId).toBe("run-123");
    },
  );

  it("treats a response for a different delivery as ambiguous", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          protocol: "suede-relay/2",
          deliveryId: "different-run",
          state: "completed",
        }),
      ),
    );

    await expect(
      executeRelayV2({ relay, runId: "run-123", agent: "agent", input: {} }),
    ).resolves.toEqual({
      kind: "ambiguous",
      deliveryId: "run-123",
      reason: "malformed",
      httpStatus: 200,
    });
  });

  it("treats an unsupported state as an ambiguous malformed response", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          protocol: "suede-relay/2",
          deliveryId: "run-123",
          state: "queued-forever",
        }),
      ),
    );

    const result = await executeRelayV2({ relay, runId: "run-123", agent: "agent", input: {} });

    expect(result).toEqual({
      kind: "ambiguous",
      deliveryId: "run-123",
      reason: "malformed",
      httpStatus: 200,
    });
  });

  it("classifies a timeout as ambiguous without throwing", async () => {
    vi.mocked(safeFetch).mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));

    await expect(
      executeRelayV2({ relay, runId: "run-123", agent: "agent", input: {} }),
    ).resolves.toEqual({ kind: "ambiguous", deliveryId: "run-123", reason: "timeout" });
  });

  it("classifies a response-body timeout as ambiguous without throwing", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new DOMException("timed out", "TimeoutError"));
          },
        }),
      ),
    );

    await expect(
      executeRelayV2({ relay, runId: "run-123", agent: "agent", input: {} }),
    ).resolves.toEqual({
      kind: "ambiguous",
      deliveryId: "run-123",
      reason: "timeout",
      httpStatus: 200,
    });
  });

  it("classifies a network failure as ambiguous without exposing its message", async () => {
    vi.mocked(safeFetch).mockRejectedValueOnce(new Error("secret-bearing network failure"));

    const result = await executeRelayV2({ relay, runId: "run-123", agent: "agent", input: {} });

    expect(result).toEqual({ kind: "ambiguous", deliveryId: "run-123", reason: "network" });
    expect(JSON.stringify(result)).not.toContain("secret-bearing");
    expect(JSON.stringify(result)).not.toContain(relay.secret);
  });

  it("classifies invalid JSON as an ambiguous malformed response", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(new Response("not-json", { status: 502 }));

    await expect(
      executeRelayV2({ relay, runId: "run-123", agent: "agent", input: {} }),
    ).resolves.toEqual({
      kind: "ambiguous",
      deliveryId: "run-123",
      reason: "malformed",
      httpStatus: 502,
    });
  });

  it("classifies a body over 256 KB as ambiguous and cancels further reading", async () => {
    const oversized = JSON.stringify({
      protocol: "suede-relay/2",
      deliveryId: "run-123",
      state: "completed",
      output: "x".repeat(256 * 1024),
    });
    vi.mocked(safeFetch).mockResolvedValueOnce(new Response(oversized));

    await expect(
      executeRelayV2({ relay, runId: "run-123", agent: "agent", input: {} }),
    ).resolves.toEqual({
      kind: "ambiguous",
      deliveryId: "run-123",
      reason: "oversize",
      httpStatus: 200,
    });
  });

  it("classifies an input that cannot be serialized as malformed without calling the relay", async () => {
    const input: Record<string, unknown> = {};
    input.self = input;

    const result = await executeRelayV2({ relay, runId: "run-123", agent: "agent", input });

    expect(result).toEqual({ kind: "ambiguous", deliveryId: "run-123", reason: "malformed" });
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe("queryRelayV2Status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(issuedAt));
    vi.mocked(safeFetch).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs a status request with no input and returns a matching status", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(responseBody("running"));

    const result = await queryRelayV2Status({
      relay,
      deliveryId: "run-123",
      agent: "po-match-gate-mkgu0",
    });

    expect(result).toEqual({
      kind: "delivery",
      protocol: "suede-relay/2",
      deliveryId: "run-123",
      state: "running",
      httpStatus: 200,
    });
    const [, init, options] = vi.mocked(safeFetch).mock.calls[0];
    if (!init) throw new Error("relay status request init missing");
    expect(options).toEqual({ timeoutMs: 15_000, maxRedirects: 0 });
    const rawBody = String(init.body);
    expect(JSON.parse(rawBody)).toEqual({
      protocol: "suede-relay/2",
      operation: "status",
      deliveryId: "run-123",
      agent: "po-match-gate-mkgu0",
      issuedAt,
      notAfter,
    });
    expect(rawBody).not.toContain("input");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-suede-signature"]).toBe(signRelayRequest(rawBody, relay.secret));
    expect(headers["x-suede-timestamp"]).toBe(issuedAt);
    expect(headers).not.toHaveProperty("Idempotency-Key");
  });

  it.each([
    [new DOMException("timed out", "TimeoutError"), "timeout"],
    [new Error("network unavailable"), "network"],
  ] as const)("returns unavailable when status transport fails", async (error, reason) => {
    vi.mocked(safeFetch).mockRejectedValueOnce(error);

    await expect(
      queryRelayV2Status({ relay, deliveryId: "run-123", agent: "agent" }),
    ).resolves.toEqual({ kind: "unavailable", deliveryId: "run-123", reason });
  });

  it("returns unavailable for malformed or delivery-ID-mismatched status data", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          protocol: "suede-relay/2",
          deliveryId: "another-run",
          state: "completed",
        }),
      ),
    );

    await expect(
      queryRelayV2Status({ relay, deliveryId: "run-123", agent: "agent" }),
    ).resolves.toEqual({
      kind: "unavailable",
      deliveryId: "run-123",
      reason: "malformed",
      httpStatus: 200,
    });
  });

  it("returns unavailable for an oversized status response", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(
      new Response("x".repeat(256 * 1024 + 1), {
        headers: { "Content-Length": String(256 * 1024 + 1) },
      }),
    );

    await expect(
      queryRelayV2Status({ relay, deliveryId: "run-123", agent: "agent" }),
    ).resolves.toEqual({
      kind: "unavailable",
      deliveryId: "run-123",
      reason: "oversize",
      httpStatus: 200,
    });
  });
});
