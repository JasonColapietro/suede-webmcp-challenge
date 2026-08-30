import { describe, it, expect, vi } from "vitest";
import {
  createHttpExecutor,
  httpNode,
  httpParamsSchema,
  MAX_TIMEOUT_MS,
} from "@/lib/flow/nodes/http";
import { NODE_DEFS } from "@/lib/flow/nodes";
import { NODE_META, getNodeMeta } from "@/lib/flow/node-meta";
import { createNodeExecutionProvenance } from "@/lib/flow/executor";
import { makeCtx } from "../_helpers";

// A lookupFn that never touches real DNS - every hostname resolves to a
// public address unless explicitly overridden per-test.
const publicLookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

function jsonResponse(status: number, data: unknown, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

describe("http node registration", () => {
  it("is registered in the server executor list and client-safe meta", () => {
    expect(NODE_DEFS.some((d) => d.type === "http")).toBe(true);
    expect(NODE_META.some((m) => m.type === "http")).toBe(true);
    expect(getNodeMeta("http")?.priceUsdc).toBeUndefined();
  });
});

describe("http node executor", () => {
  it("performs a GET and parses a JSON response into { status, body }", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { hello: "world" }));
    const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    const res = await executor(makeCtx(), { method: "GET", url: "https://example.com/api" }, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toEqual({ status: 200, body: { hello: "world" } });
      expect(res.costUsdc).toBe(0);
    }
  });

  it("returns the raw text body when content-type is not JSON", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("plain text reply", { status: 200, headers: { "content-type": "text/plain" } }));
    const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    const res = await executor(makeCtx(), { method: "GET", url: "https://example.com/text" }, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toEqual({ status: 200, body: "plain text reply" });
    }
  });

  it("falls back to text when the body claims JSON but fails to parse", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("not json{", { status: 200, headers: { "content-type": "application/json" } }));
    const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    const res = await executor(makeCtx(), { method: "GET", url: "https://example.com/bad-json" }, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toEqual({ status: 200, body: "not json{" });
    }
  });

  it("treats a non-2xx response as a normal result, not a node failure", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(404, { error: "not found" }));
    const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    const res = await executor(makeCtx(), { method: "GET", url: "https://example.com/missing" }, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.outputs.result as { status: number }).status).toBe(404);
    }
  });

  it("interpolates {{...}} templates in url, headers, and body from upstream inputs", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    const res = await executor(
      makeCtx(),
      {
        method: "POST",
        url: "https://example.com/users/{{in.userId}}",
        headers: { "X-Trace": "{{in.traceId}}" },
        body: '{"note":"{{in.note}}"}',
      },
      { in: { userId: "42", traceId: "abc-123", note: "hello" } },
    );
    expect(res.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://example.com/users/42");
    expect((init.headers as Record<string, string>)["X-Trace"]).toBe("abc-123");
    expect(init.body).toBe('{"note":"hello"}');
  });

  it("never forwards process env or attaches implicit auth headers", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    await executor(makeCtx(), { method: "GET", url: "https://example.com/x" }, {});
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual([]);
  });

  it("merges trusted connection headers byte-for-byte after interpolating static headers only", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    const provenance = createNodeExecutionProvenance({
      headers: { Authorization: "Bearer {{in.mustRemainLiteral}}", "X-Connection": "raw{{value}}" },
    });

    const result = await executor(
      makeCtx(),
      {
        method: "GET",
        url: "https://example.com/resource",
        headers: { "X-Static": "{{in.staticValue}}" },
      },
      { in: { staticValue: "interpolated", mustRemainLiteral: "leak" } },
      provenance,
    );

    expect(result.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({
      "X-Static": "interpolated",
      Authorization: "Bearer {{in.mustRemainLiteral}}",
      "X-Connection": "raw{{value}}",
    });
  });

  it("ignores absent or forged provenance and refuses case-insensitive collisions before fetch", async () => {
    const fetchFn = vi.fn().mockImplementation(async () => jsonResponse(200, { ok: true }));
    const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    await executor(
      makeCtx(),
      { method: "GET", url: "https://example.com", headers: { "X-Static": "safe" } },
      {},
      { headers: { Authorization: "Bearer forged" } },
    );
    expect((fetchFn.mock.calls[0]?.[1] as RequestInit).headers).toEqual({ "X-Static": "safe" });

    fetchFn.mockClear();
    const headerCanary = "X-Private-Canary";
    const valueCanary = "private-value-canary";
    const provenance = createNodeExecutionProvenance({ headers: { [headerCanary]: valueCanary } });
    const result = await executor(
      makeCtx(),
      { method: "GET", url: "https://example.com", headers: { "x-private-canary": "static" } },
      {},
      provenance,
    );
    expect(result.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error).not.toContain(headerCanary);
      expect(result.error).not.toContain(valueCanary);
    }
  });

  it("does not echo connection material through authenticated fetch failures", async () => {
    const secret = "fetch-error-secret-canary";
    const fetchFn = vi.fn().mockRejectedValue(new Error(secret));
    const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    const result = await executor(
      makeCtx(),
      { method: "GET", url: "https://example.com" },
      {},
      createNodeExecutionProvenance({ headers: { Authorization: `Bearer ${secret}` } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain(secret);
  });

  describe("authenticated response containment", () => {
    const FIXED_RESPONSE_ERROR = "Authenticated response unavailable";
    const basicUsername = "basic-user-canary";
    const basicPassword = "basic-password-canary";
    const basicDecoded = `${basicUsername}:${basicPassword}`;
    const basicEncoded = Buffer.from(basicDecoded, "utf8").toString("base64");
    const cases = [
      {
        kind: "api key",
        headers: { "X-Api-Key": "api-key-canary" },
        canaries: ["api-key-canary"],
      },
      {
        kind: "bearer",
        headers: { Authorization: "Bearer bearer-token-canary" },
        canaries: ["Bearer bearer-token-canary", "bearer-token-canary"],
      },
      {
        kind: "basic",
        headers: { Authorization: `Basic ${basicEncoded}` },
        canaries: [`Basic ${basicEncoded}`, basicEncoded, basicDecoded, basicUsername, basicPassword],
      },
      {
        kind: "custom headers",
        headers: { "X-Custom-One": "custom-one-canary", "X-Custom-Two": "custom-two-canary" },
        canaries: ["custom-one-canary", "custom-two-canary"],
      },
    ] as const;

    async function expectContainedResponse(
      headers: Readonly<Record<string, string>>,
      response: Response,
      canaries: readonly string[],
    ): Promise<void> {
      const executor = createHttpExecutor({
        fetchFn: vi.fn().mockResolvedValue(response),
        lookupFn: publicLookup,
      });
      const result = await executor(
        makeCtx(),
        { method: "GET", url: "https://example.com/echo" },
        {},
        createNodeExecutionProvenance({ headers }),
      );
      expect(result).toEqual({ ok: false, error: FIXED_RESPONSE_ERROR, costUsdc: 0 });
      const serialized = JSON.stringify(result);
      for (const canary of canaries) expect(serialized).not.toContain(canary);
    }

    it.each(cases)("refuses embedded $kind material in text and exact JSON keys or values", async ({ headers, canaries }) => {
      for (const canary of canaries) {
        await expectContainedResponse(
          headers,
          new Response(`public prefix ${canary} public suffix`, {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
          canaries,
        );
        await expectContainedResponse(
          headers,
          jsonResponse(200, { echo: `public prefix ${canary} public suffix` }),
          canaries,
        );
        await expectContainedResponse(
          headers,
          jsonResponse(200, { [`public-prefix-${canary}-public-suffix`]: true }),
          canaries,
        );
      }
    });

    it("refuses an escaped representation of a trusted header value", async () => {
      const secret = "escaped-\\\"api-key-canary";
      const escaped = JSON.stringify(secret).slice(1, -1);
      expect(escaped).not.toBe(secret);
      await expectContainedResponse(
        { "X-Api-Key": secret },
        new Response(`public ${escaped} public`, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
        [secret, escaped],
      );
    });

    it("contains locked and erroring authenticated response streams", async () => {
      const lockedCanary = "locked-stream-secret-canary";
      const locked = new Response("public", { headers: { "content-type": "text/plain" } });
      const reader = locked.body?.getReader();
      await expectContainedResponse(
        { Authorization: `Bearer ${lockedCanary}` },
        locked,
        [lockedCanary],
      );
      reader?.releaseLock();

      const streamCanary = "stream-error-secret-canary";
      const erroring = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error(streamCanary));
        },
      });
      await expectContainedResponse(
        { Authorization: `Bearer ${streamCanary}` },
        new Response(erroring, { headers: { "content-type": "text/plain" } }),
        [streamCanary],
      );
    });

    it("contains authenticated response header and JSON parse failures", async () => {
      const headerCanary = "header-read-secret-canary";
      const hostileHeaders = new Response("public");
      Object.defineProperty(hostileHeaders, "headers", {
        value: { get: () => { throw new Error(headerCanary); } },
      });
      await expectContainedResponse(
        { Authorization: `Bearer ${headerCanary}` },
        hostileHeaders,
        [headerCanary],
      );

      const parseCanary = "parse-failure-secret-canary";
      await expectContainedResponse(
        { Authorization: `Bearer ${parseCanary}` },
        new Response(`{\"echo\":\"${parseCanary}\"`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        [parseCanary],
      );
    });
  });

  it("rejects params that fail schema validation", async () => {
    const executor = createHttpExecutor({ fetchFn: vi.fn(), lookupFn: publicLookup });
    const res = await executor(makeCtx(), { method: "TRACE", url: "https://example.com" }, {});
    expect(res.ok).toBe(false);
  });

  describe("SSRF guards", () => {
    it("pins the request to the validated address instead of resolving again", async () => {
      const lookupFn = vi.fn()
        .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
        .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
      const dispatcher = { identity: "http-node-public-pin" };
      const close = vi.fn().mockResolvedValue(undefined);
      const dispatcherFactory = vi.fn(() => ({ dispatcher, close }));
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { pinned: true }));
      const executor = createHttpExecutor({ fetchFn, lookupFn, dispatcherFactory } as never);

      const result = await executor(
        makeCtx(),
        { method: "GET", url: "https://api.example.com/resource" },
        {},
      );

      expect(result.ok).toBe(true);
      expect(lookupFn).toHaveBeenCalledTimes(1);
      expect(dispatcherFactory).toHaveBeenCalledWith({
        address: "93.184.216.34",
        family: 4,
        hostname: "api.example.com",
      });
      expect(fetchFn).toHaveBeenCalledWith(
        "https://api.example.com/resource",
        expect.objectContaining({ dispatcher, redirect: "manual" }),
      );
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("re-pins each safe redirect to that hop's freshly validated address", async () => {
      const lookupFn = vi.fn()
        .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
        .mockResolvedValueOnce([{ address: "93.184.216.35", family: 4 }]);
      const transports = [
        { dispatcher: { identity: "http-hop-1" }, close: vi.fn().mockResolvedValue(undefined) },
        { dispatcher: { identity: "http-hop-2" }, close: vi.fn().mockResolvedValue(undefined) },
      ];
      const dispatcherFactory = vi.fn()
        .mockReturnValueOnce(transports[0])
        .mockReturnValueOnce(transports[1]);
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/final" } }))
        .mockResolvedValueOnce(jsonResponse(200, { landed: true }));
      const executor = createHttpExecutor({ fetchFn, lookupFn, dispatcherFactory } as never);

      const result = await executor(
        makeCtx(),
        { method: "GET", url: "https://api.example.com/start" },
        {},
      );

      expect(result.ok).toBe(true);
      expect(dispatcherFactory.mock.calls).toEqual([
        [{ address: "93.184.216.34", family: 4, hostname: "api.example.com" }],
        [{ address: "93.184.216.35", family: 4, hostname: "api.example.com" }],
      ]);
      expect(fetchFn.mock.calls.map((call) => [call[0], call[1].dispatcher])).toEqual([
        ["https://api.example.com/start", transports[0].dispatcher],
        ["https://api.example.com/final", transports[1].dispatcher],
      ]);
      expect(transports[0].close).toHaveBeenCalledTimes(1);
      expect(transports[1].close).toHaveBeenCalledTimes(1);
    });

    it("blocks localhost", async () => {
      const fetchFn = vi.fn();
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
      const res = await executor(makeCtx(), { method: "GET", url: "http://localhost:8080/admin" }, {});
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/blocked/i);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("blocks a literal private IP", async () => {
      const fetchFn = vi.fn();
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
      const res = await executor(makeCtx(), { method: "GET", url: "http://10.0.0.5/" }, {});
      expect(res.ok).toBe(false);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("blocks the cloud metadata address", async () => {
      const fetchFn = vi.fn();
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
      const res = await executor(
        makeCtx(),
        { method: "GET", url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" },
        {},
      );
      expect(res.ok).toBe(false);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("blocks a hostname that resolves to a private address", async () => {
      const fetchFn = vi.fn();
      const rebindingLookup = vi.fn().mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const executor = createHttpExecutor({ fetchFn, lookupFn: rebindingLookup });
      const res = await executor(makeCtx(), { method: "GET", url: "http://sneaky.example.com/" }, {});
      expect(res.ok).toBe(false);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("blocks a disallowed scheme", async () => {
      const fetchFn = vi.fn();
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
      const res = await executor(makeCtx(), { method: "GET", url: "file:///etc/passwd" }, {});
      expect(res.ok).toBe(false);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("re-validates every redirect hop and blocks a redirect into a private range", async () => {
      const fetchFn = vi.fn().mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
      );
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
      const res = await executor(makeCtx(), { method: "GET", url: "https://example.com/redirect-me" }, {});
      expect(res.ok).toBe(false);
      expect(fetchFn).toHaveBeenCalledTimes(1); // never followed the bad hop
    });

    it("follows a safe redirect chain and returns the final response", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: "https://example.com/final" } }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { landed: true }));
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
      const res = await executor(makeCtx(), { method: "GET", url: "https://example.com/start" }, {});
      expect(res.ok).toBe(true);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      if (res.ok) expect(res.outputs.result).toEqual({ status: 200, body: { landed: true } });
    });

    it.each([301, 302, 303, 307, 308])(
      "refuses authenticated cross-origin boundaries for redirect status %s before a second fetch",
      async (status) => {
        for (const location of [
          "http://example.com/final",
          "https://other.example/final",
          "https://example.com:444/final",
        ]) {
          const fetchFn = vi.fn().mockResolvedValueOnce(new Response(null, {
            status,
            headers: { location },
          })).mockResolvedValue(jsonResponse(200, { followed: true }));
          const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
          const secret = "redirect-secret-canary";
          const result = await executor(
            makeCtx(),
            { method: "POST", url: "https://example.com/start", body: "payload" },
            {},
            createNodeExecutionProvenance({ headers: { Authorization: `Bearer ${secret}` } }),
          );
          expect(result.ok).toBe(false);
          expect(fetchFn).toHaveBeenCalledTimes(1);
          if (!result.ok) {
            expect(result.error).not.toContain(secret);
            expect(result.error).not.toContain(location);
          }
        }
      },
    );

    it("allows authenticated relative and normalized punycode/default-port same-origin redirects", async () => {
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/middle" } }))
        .mockResolvedValueOnce(new Response(null, {
          status: 307,
          headers: { location: "https://xn--bcher-kva.example:443/final" },
        }))
        .mockResolvedValueOnce(jsonResponse(200, { landed: true }));
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
      const result = await executor(
        makeCtx(),
        { method: "GET", url: "https://bücher.example/start" },
        {},
        createNodeExecutionProvenance({ headers: { Authorization: "Bearer exact" } }),
      );
      expect(result.ok).toBe(true);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(fetchFn.mock.calls.map((call) => call[0])).toEqual([
        "https://xn--bcher-kva.example/start",
        "https://xn--bcher-kva.example/middle",
        "https://xn--bcher-kva.example/final",
      ]);
    });

    it("preserves safe unauthenticated cross-origin redirects", async () => {
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(new Response(null, {
          status: 302,
          headers: { location: "https://other.example/final" },
        }))
        .mockResolvedValueOnce(jsonResponse(200, { landed: true }));
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
      const result = await executor(makeCtx(), { method: "GET", url: "https://example.com/start" }, {});
      expect(result.ok).toBe(true);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("refuses URL userinfo initially and on redirects without exposing it", async () => {
      const fetchFn = vi.fn().mockImplementation(async () => jsonResponse(200, { followed: true }));
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
      const initial = await executor(
        makeCtx(),
        { method: "GET", url: "https://user:password-canary@example.com/start" },
        {},
      );
      expect(initial.ok).toBe(false);
      expect(fetchFn).not.toHaveBeenCalled();
      if (!initial.ok) expect(initial.error).not.toContain("password-canary");

      fetchFn.mockClear();
      fetchFn.mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://user:redirect-password-canary@example.com/final" },
      })).mockResolvedValue(jsonResponse(200, { followed: true }));
      const redirected = await executor(makeCtx(), { method: "GET", url: "https://example.com/start" }, {});
      expect(redirected.ok).toBe(false);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      if (!redirected.ok) expect(redirected.error).not.toContain("redirect-password-canary");
    });

    it("gives up after too many redirects", async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://example.com/loop" } }),
      );
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup, maxRedirects: 2 });
      const res = await executor(makeCtx(), { method: "GET", url: "https://example.com/loop" }, {});
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/redirect/i);
    });
  });

  describe("timeout", () => {
    it("aborts and reports a timeout error when the request never resolves", async () => {
      const fetchFn = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
      const res = await executor(
        makeCtx(),
        { method: "GET", url: "https://example.com/slow", timeoutMs: 15 },
        {},
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/timed out/i);
    });

    it("clamps a requested timeout above the max instead of honoring it verbatim", async () => {
      // Spy on setTimeout so we can assert the clamp and fire the abort
      // manually, instead of burning MAX_TIMEOUT_MS of real wall-clock time.
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      const fetchFn = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
      const resultPromise = executor(
        makeCtx(),
        { method: "GET", url: "https://example.com/slow", timeoutMs: MAX_TIMEOUT_MS * 10 },
        {},
      );

      // Let the executor's microtask chain (schema parse -> URL guard ->
      // DNS lookup -> setTimeout) run before we inspect the spy.
      await new Promise((resolve) => setImmediate(resolve));

      const abortTimerCall = setTimeoutSpy.mock.calls.find(
        (call): call is [(...args: unknown[]) => void, number] =>
          typeof call[1] === "number" && call[1] > 0,
      );
      expect(abortTimerCall?.[1]).toBe(MAX_TIMEOUT_MS); // clamped, not the requested 300s
      abortTimerCall?.[0](); // fire the abort callback synchronously

      const res = await resultPromise;
      expect(res.ok).toBe(false);
      setTimeoutSpy.mockRestore();
    });
  });

  describe("response size cap", () => {
    it("aborts a response that exceeds the configured byte cap", async () => {
      const bigChunk = new Uint8Array(1024).fill(65); // 1 KB of 'A'
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bigChunk);
          controller.enqueue(bigChunk);
          controller.close();
        },
      });
      const fetchFn = vi
        .fn()
        .mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/plain" } }));
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup, maxResponseBytes: 512 });
      const res = await executor(makeCtx(), { method: "GET", url: "https://example.com/big" }, {});
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/size cap/i);
    });

    it("accepts a response under the cap", async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        new Response("small", { status: 200, headers: { "content-type": "text/plain" } }),
      );
      const executor = createHttpExecutor({ fetchFn, lookupFn: publicLookup, maxResponseBytes: 512 });
      const res = await executor(makeCtx(), { method: "GET", url: "https://example.com/small" }, {});
      expect(res.ok).toBe(true);
    });
  });
});

describe("httpParamsSchema", () => {
  it("defaults method to GET", () => {
    const parsed = httpParamsSchema.parse({ url: "https://example.com" });
    expect(parsed.method).toBe("GET");
  });

  it("rejects an unsupported method", () => {
    expect(() => httpParamsSchema.parse({ url: "https://example.com", method: "CONNECT" })).toThrow();
  });

  it("rejects a missing url", () => {
    expect(() => httpParamsSchema.parse({})).toThrow();
  });
});

describe("httpNode default export", () => {
  it("uses the real global fetch and dns lookup by default (smoke test via SSRF block)", async () => {
    const res = await httpNode.executor(makeCtx(), { method: "GET", url: "http://127.0.0.1:1/" }, {});
    expect(res.ok).toBe(false);
  });
});
