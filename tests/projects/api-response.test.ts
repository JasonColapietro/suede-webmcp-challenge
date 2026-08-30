import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  invalidRequestResponse,
  parseJsonRequest,
  privateJson,
  readBoundedJsonRequest,
  readCappedJsonRequest,
} from "@/lib/projects/api-response";

const Schema = z.object({ value: z.string() }).strict();

function streamingRequest(bytes: Uint8Array, onCancel?: () => void): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Request("https://agents.suedeai.ai/private", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("bounded private JSON request parsing", () => {
  it("accepts one strict JSON object", async () => {
    const request = new Request("https://agents.suedeai.ai/private", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ value: "ok" }),
    });
    expect(await parseJsonRequest(request, Schema)).toEqual({ ok: true, data: { value: "ok" } });
  });

  it.each([undefined, "text/plain", "application/ld+json"])(
    "rejects missing or unsupported content type %s",
    async (contentType) => {
      const headers: Record<string, string> = contentType === undefined
        ? {}
        : { "content-type": contentType };
      const request = new Request("https://agents.suedeai.ai/private", {
        method: "POST", headers, body: JSON.stringify({ value: "no" }),
      });
      expect(await parseJsonRequest(request, Schema)).toEqual({ ok: false });
    },
  );

  it.each(["nope", "2097153"])("rejects declared content length %s", async (length) => {
    const request = new Request("https://agents.suedeai.ai/private", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": length },
      body: "{}",
    });
    expect(await parseJsonRequest(request, Schema)).toEqual({ ok: false });
  });

  it("cancels a chunked body as soon as it crosses the byte ceiling", async () => {
    let canceled = false;
    let chunk = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(chunk++ === 0 ? 1536 * 1024 : 1024 * 1024).fill(0x20));
      },
      cancel() {
        canceled = true;
      },
    });
    const request = new Request("https://agents.suedeai.ai/private", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(await parseJsonRequest(request, Schema))
      .toEqual({ ok: false });
    expect(canceled).toBe(true);
  });

  it("returns promptly at cap plus one without awaiting hostile cancellation", async () => {
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel() {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const request = new Request("https://agents.suedeai.ai/private", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = readCappedJsonRequest(request);
    const timeout = Symbol("timeout");
    const outcome = await Promise.race([
      pending,
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 250)),
    ]);

    expect(outcome).toEqual({ ok: false });
    expect(cancelCalls).toBe(1);
  });

  it("rejects a pre-aborted capped or bounded read and cancels each body", async () => {
    const controller = new AbortController();
    controller.abort();
    let cappedCanceled = 0;
    let boundedCanceled = 0;

    expect(await readCappedJsonRequest(
      streamingRequest(new TextEncoder().encode("{}"), () => { cappedCanceled += 1; }),
      { signal: controller.signal },
    )).toEqual({ ok: false });
    expect(await readBoundedJsonRequest(
      streamingRequest(new TextEncoder().encode("{}"), () => { boundedCanceled += 1; }),
      { signal: controller.signal },
    )).toEqual({ ok: false });
    expect({ cappedCanceled, boundedCanceled }).toEqual({ cappedCanceled: 1, boundedCanceled: 1 });
  });

  it("returns promptly when abort wins a never-resolving body read without awaiting cancel", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        streamController = value;
      },
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const request = new Request("https://agents.suedeai.ai/private", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = readCappedJsonRequest(request, { signal: controller.signal });
    controller.abort();
    const timeout = Symbol("timeout");
    const outcome = await Promise.race([
      pending,
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 250)),
    ]);
    if (outcome === timeout) {
      try { streamController?.close(); } catch { /* cleanup after a failed assertion */ }
      await pending;
    }

    expect(outcome).toEqual({ ok: false });
    expect(cancelCalls).toBe(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed UTF-8 and excessive object depth before schema recursion", async () => {
    expect(await parseJsonRequest(streamingRequest(new Uint8Array([0xc3, 0x28])), Schema))
      .toEqual({ ok: false });
    let nested: Record<string, unknown> = { value: "deep" };
    for (let index = 0; index < 70; index += 1) nested = { nested };
    const request = new Request("https://agents.suedeai.ai/private", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(nested),
    });
    expect(await parseJsonRequest(request, z.unknown())).toEqual({ ok: false });
  });

  it("returns a fixed private no-store 400 envelope", async () => {
    const response = invalidRequestResponse();
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe('{"error":"invalid request"}');
  });

  it("cannot have its privacy header overridden while preserving safe extra headers", () => {
    const response = privateJson({ ok: true }, 429, {
      "cache-control": "public, max-age=3600",
      "Retry-After": "7",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("retry-after")).toBe("7");
  });
});
