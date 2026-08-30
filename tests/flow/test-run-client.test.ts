import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readBoundedTestRunResponse } from "@/lib/flow/test-run-client";
import { TEST_RUN_UI_LIMITS } from "@/lib/flow/test-run-ui";

function envelope() {
  return {
    result: {
      runId: "client-run",
      status: "done",
      costUsdc: 0,
      outputs: {},
      events: [
        { kind: "test:start", sequence: 0, runId: "client-run" },
        { kind: "test:done", sequence: 1, runId: "client-run", status: "done", costUsdc: 0 },
      ],
      logs: [],
    },
  } as const;
}

function response(body: BodyInit | null, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function responseWithRawLength(length: string): Response {
  const value = response(JSON.stringify(envelope()));
  const headers = value.headers;
  Object.defineProperty(value, "headers", {
    value: {
      get(name: string) {
        return name.toLowerCase() === "content-length" ? length : headers.get(name);
      },
    },
  });
  return value;
}

describe("bounded scoped-test response reader", () => {
  it("parses a detached strict JSON envelope with absent or canonical length", async () => {
    const text = JSON.stringify(envelope());
    const source = envelope();
    const withoutLength = await readBoundedTestRunResponse(response(text));
    const withLength = await readBoundedTestRunResponse(response(text, {
      "content-length": String(new TextEncoder().encode(text).byteLength),
    }));

    expect(withoutLength).toEqual(source.result);
    expect(withLength).toEqual(source.result);
    expect(withoutLength).not.toBe(source.result);
    expect(Object.isFrozen(TEST_RUN_UI_LIMITS)).toBe(true);
    expect(TEST_RUN_UI_LIMITS.responseBytes).toBeGreaterThan(0);
  });

  it.each(["-1", "+1", "01", " 1", "1 ", "1.0", "1e2", "NaN"])(
    "rejects non-canonical Content-Length %s",
    async (length) => {
      expect(await readBoundedTestRunResponse(responseWithRawLength(length))).toBeNull();
    },
  );

  it("rejects a declared response beyond the derived envelope cap", async () => {
    expect(await readBoundedTestRunResponse(response(JSON.stringify(envelope()), {
      "content-length": String(TEST_RUN_UI_LIMITS.responseBytes + 1),
    }))).toBeNull();
  });

  it("hard-caps an absent or lying length and never awaits hostile cancellation", async () => {
    for (const declared of [undefined, "1"] as const) {
      const headers: Record<string, string> = declared === undefined
        ? {}
        : { "content-length": declared };
      let cancelCalls = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(TEST_RUN_UI_LIMITS.responseBytes + 1));
        },
        cancel() {
          cancelCalls += 1;
          return new Promise<void>(() => undefined);
        },
      });
      const pending = readBoundedTestRunResponse(response(stream, headers));
      const timeout = Symbol("timeout");
      const outcome = await Promise.race([
        pending,
        new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 250)),
      ]);
      expect(outcome).toBeNull();
      expect(cancelCalls).toBe(1);
    }
  });

  it("rejects the first zero-byte chunk promptly and cancels an otherwise unbounded stream", async () => {
    let pulls = 0;
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array(0));
        return pulls === 1 ? undefined : new Promise<void>(() => undefined);
      },
      cancel() { cancelCalls += 1; },
    });
    const timeout = Symbol("timeout");
    const outcome = await Promise.race([
      readBoundedTestRunResponse(response(stream)),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 250)),
    ]);

    expect(outcome).toBeNull();
    expect(cancelCalls).toBe(1);
    expect(pulls).toBeLessThanOrEqual(2);
  });

  it("rejects and cancels a response exceeding the exported chunk-count limit", async () => {
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index <= TEST_RUN_UI_LIMITS.responseChunks; index += 1) {
          controller.enqueue(new Uint8Array([0x7b]));
        }
      },
      cancel() { cancelCalls += 1; },
    });
    const timeout = Symbol("timeout");
    const outcome = await Promise.race([
      readBoundedTestRunResponse(response(stream)),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 250)),
    ]);

    expect(outcome).toBeNull();
    expect(cancelCalls).toBe(1);
    expect(TEST_RUN_UI_LIMITS.responseChunks).toBe(8_192);
  });

  it("requires declared Content-Length to match the bytes actually read", async () => {
    const text = JSON.stringify(envelope());
    const bytes = new TextEncoder().encode(text).byteLength;
    for (const declared of [bytes - 1, bytes + 1]) {
      let cancelCalls = 0;
      let reads = 0;
      const value = response(null, { "content-length": String(declared) });
      Object.defineProperty(value, "body", {
        value: {
          getReader() {
            return {
              read() {
                reads += 1;
                return Promise.resolve(reads === 1
                  ? { done: false as const, value: new TextEncoder().encode(text) }
                  : { done: true as const, value: undefined });
              },
              cancel() { cancelCalls += 1; return Promise.resolve(); },
            };
          },
        },
      });
      expect(await readBoundedTestRunResponse(value)).toBeNull();
      expect(cancelCalls).toBe(1);
    }
  });

  it("rejects media drift, malformed JSON, fatal UTF-8, and secret canaries generically", async () => {
    const canary = "CLIENT-RESPONSE-CANARY-77d2";
    expect(await readBoundedTestRunResponse(response(JSON.stringify(envelope()), {
      "content-type": "text/plain",
    }))).toBeNull();
    expect(await readBoundedTestRunResponse(response(`{"marker":"${canary}"`))).toBeNull();
    expect(await readBoundedTestRunResponse(response(new Uint8Array([0xc3, 0x28])))).toBeNull();
    expect(await readBoundedTestRunResponse(response(JSON.stringify({
      result: { ...envelope().result, logs: [{ level: "error", message: `Bearer ${canary}` }] },
    })))).toBeNull();
  });

  it("cancels a pre-aborted body without reading it", async () => {
    const controller = new AbortController();
    controller.abort();
    let pulls = 0;
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull() { pulls += 1; },
      cancel() { cancels += 1; },
    });

    expect(await readBoundedTestRunResponse(response(stream), { signal: controller.signal })).toBeNull();
    expect(pulls).toBe(0);
    expect(cancels).toBe(1);
  });

  it("returns promptly when abort wins a stuck read and suppresses late rejection", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined); },
      cancel() {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const pending = readBoundedTestRunResponse(response(stream), { signal: controller.signal });
    controller.abort();
    const timeout = Symbol("timeout");
    const outcome = await Promise.race([
      pending,
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 250)),
    ]);

    expect(outcome).toBeNull();
    expect(cancelCalls).toBe(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("stays client-safe and does not echo or throw raw response failures", () => {
    const source = readFileSync("src/lib/flow/test-run-client.ts", "utf8");
    expect(source).toContain("parseTestRunResultEnvelope");
    expect(source).toContain("TEST_RUN_UI_LIMITS.responseBytes");
    expect(source).toContain('new TextDecoder("utf-8", { fatal: true })');
    expect(source).not.toMatch(/@\/lib\/(?:db|repository|run-service|settlement|x402)/);
    expect(source).not.toMatch(/@\/lib\/flow\/(?:registry|executor|test-runner)(?:["'])/);
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/console\.|throw\s|response\.(?:text|statusText)/);
  });
});
