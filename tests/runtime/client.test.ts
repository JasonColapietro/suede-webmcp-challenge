import { describe, expect, it, vi } from "vitest";
import {
  durableActionAvailability,
  enqueueDurableRun,
  parseDurableEnqueueEnvelope,
  parseDurableRunEnvelope,
  readBoundedDurableJson,
  readDurableEventStream,
} from "@/lib/runtime/client";

describe("durable browser client contracts", () => {
  it("accepts exact enqueue and owner-view envelopes and rejects extra keys", () => {
    expect(parseDurableEnqueueEnvelope({
      runId: "run_1", state: "queued", statusUrl: "/api/v3/runs/run_1", eventsUrl: "/api/v3/runs/run_1/events",
    })?.runId).toBe("run_1");
    expect(parseDurableEnqueueEnvelope({
      runId: "run_1", state: "queued", statusUrl: "/api/v3/runs/run_1", eventsUrl: "/api/v3/runs/run_1/events", extra: true,
    })).toBeNull();
    expect(parseDurableRunEnvelope({ run: ownerView("running", "running") })?.run.flowVersionId).toBe("version_1");
  });

  it("derives controls from both state and desired state", () => {
    expect(durableActionAvailability("running", "running")).toEqual(["pause", "cancel"]);
    expect(durableActionAvailability("running", "paused")).toEqual(["cancel"]);
    expect(durableActionAvailability("paused", "paused")).toEqual(["resume", "cancel"]);
    expect(durableActionAvailability("failed", "running")).toEqual(["retry"]);
    expect(durableActionAvailability("running", "cancelled")).toEqual([]);
    expect(durableActionAvailability("cancelled", "cancelled")).toEqual(["retry"]);
    expect(durableActionAvailability("succeeded", "paused")).toEqual([]);
    expect(durableActionAvailability("dead", "cancelled")).toEqual([]);
    const states = ["queued", "running", "paused", "succeeded", "failed", "cancelled", "dead"] as const;
    const desired = ["running", "paused", "cancelled"] as const;
    for (const state of states) for (const target of desired) {
      const canonical =
        (state === "queued" || state === "running") && target === "running" ? ["pause", "cancel"] :
        (state === "queued" || state === "running") && target === "paused" ? ["cancel"] :
        state === "paused" && target === "paused" ? ["resume", "cancel"] :
        state === "cancelled" && target === "cancelled" ? ["retry"] :
        (state === "succeeded" || state === "failed" || state === "dead") && target === "running" ? ["retry"] : [];
      expect(durableActionAvailability(state, target), `${state}/${target}`).toEqual(canonical);
    }
  });

  it("rejects hostile accessors without invoking them", () => {
    let invoked = false;
    const projection = ownerView("running", "running").projection;
    Object.defineProperty(projection, "nodes", { enumerable: true, get() { invoked = true; return {}; } });
    expect(parseDurableRunEnvelope({ run: { ...ownerView("running", "running"), projection } })).toBeNull();
    expect(invoked).toBe(false);
  });

  it("streams strict contiguous CRLF frames and resumes from N", async () => {
    const payload = (sequence: number) => JSON.stringify({ schemaVersion: 1, executionId: "run_1", sequence, attempt: 0, type: sequence === 2 ? "job.enqueued" : "execution.created", at: sequence, payload: sequence === 2 ? { jobId: "job_1", priority: 0, availableAt: 1 } : { definitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    const body = `id: 1\r\nevent: durable-execution-event\r\ndata: ${payload(1)}\r\n\r\nid: 2\r\nevent: durable-execution-event\r\ndata: ${payload(2)}\r\n\r\n`;
    const seen: number[] = [];
    const cursor = await readDurableEventStream({ response: new Response(body, { headers: { "content-type": "text/event-stream" } }), runId: "run_1", after: 0, onEvent: (event) => seen.push(event.sequence) });
    expect(cursor).toBe(2); expect(seen).toEqual([1, 2]);
  });

  it("fails closed on duplicate sequences and cancels the reader", async () => {
    let cancelled = false;
    const event = JSON.stringify({ schemaVersion: 1, executionId: "run_1", sequence: 1, attempt: 0, type: "execution.created", at: 1, payload: { definitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`id: 1\nevent: durable-execution-event\ndata: ${event}\n\nid: 1\nevent: durable-execution-event\ndata: ${event}\n\n`)); }, cancel() { cancelled = true; } });
    await expect(readDurableEventStream({ response: new Response(stream, { headers: { "content-type": "text/event-stream" } }), runId: "run_1", after: 0, onEvent() {} })).rejects.toThrow("invalid durable event stream");
    expect(cancelled).toBe(true);
  });

  it("enqueues exactly once with one idempotency key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "run_1", state: "queued", statusUrl: "/api/v3/runs/run_1", eventsUrl: "/api/v3/runs/run_1/events" }), { status: 202, headers: { "content-type": "application/json" } }));
    const result = await enqueueDurableRun({ flowId: "flow_1", flowVersionId: "version_1", triggerInput: {}, fetch, createId: () => "idem_1" });
    expect(result.status).toBe("accepted"); expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ "idempotency-key": "idem_1" });
  });

  it("reuses a caller-owned pending key and rejects an aggregate oversized body before fetch", async () => {
    const accepted = new Response(JSON.stringify({ runId: "run_1", state: "queued", statusUrl: "/api/v3/runs/run_1", eventsUrl: "/api/v3/runs/run_1/events" }), { status: 202, headers: { "content-type": "application/json" } });
    const fetch = vi.fn().mockResolvedValue(accepted);
    await enqueueDurableRun({ flowId: "flow_1", flowVersionId: "version_1", triggerInput: {}, fetch, idempotencyKey: "stable_1", createId: () => "wrong_1" });
    expect((fetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ "idempotency-key": "stable_1" });

    const tooLargeFetch = vi.fn();
    const triggerInput = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`field_${index}`, "x".repeat(65_000)]));
    const rejected = await enqueueDurableRun({ flowId: "flow_1", flowVersionId: "version_1", triggerInput, fetch: tooLargeFetch, idempotencyKey: "stable_2" });
    expect(rejected).toEqual({ status: "rejected" });
    expect(tooLargeFetch).not.toHaveBeenCalled();

    let invoked = false;
    const hostile = {};
    Object.defineProperty(hostile, "secret", { enumerable: true, get() { invoked = true; return "stolen"; } });
    const hostileFetch = vi.fn();
    expect(await enqueueDurableRun({ flowId: "flow_1", flowVersionId: "version_1", triggerInput: hostile, fetch: hostileFetch, idempotencyKey: "stable_3" })).toEqual({ status: "rejected" });
    expect(invoked).toBe(false); expect(hostileFetch).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 409])("rejects definitive non-admission status %i", async (status) => {
    const result = await enqueueDurableRun({ flowId: "flow_1", flowVersionId: "version_1", triggerInput: {}, fetch: vi.fn().mockResolvedValue(new Response(null, { status })), createId: () => "idem_1" });
    expect(result.status).toBe("rejected");
  });

  it.each([408, 429, 500, 503])("keeps ambiguous status %i recoverable with idempotency", async (status) => {
    const result = await enqueueDurableRun({ flowId: "flow_1", flowVersionId: "version_1", triggerInput: {}, fetch: vi.fn().mockResolvedValue(new Response(null, { status })), createId: () => "idem_1" });
    expect(result.status).toBe("error");
  });

  it("reports 422 as the sole not-admitted result", async () => {
    const result = await enqueueDurableRun({ flowId: "flow_1", flowVersionId: "version_1", triggerInput: {}, fetch: vi.fn().mockResolvedValue(new Response(null, { status: 422 })), createId: () => "idem_1" });
    expect(result.status).toBe("not-admitted");
  });

  it("fails closed on invalid UTF-8 and poisoned receipt URLs", async () => {
    const bytes = new Uint8Array([0xc3, 0x28]);
    const utf8 = await enqueueDurableRun({ flowId: "flow_1", flowVersionId: "version_1", triggerInput: {}, fetch: vi.fn().mockResolvedValue(new Response(bytes, { status: 202, headers: { "content-type": "application/json" } })), createId: () => "idem_1" });
    expect(utf8.status).toBe("error");
    expect(parseDurableEnqueueEnvelope({ runId: "run_1", state: "queued", statusUrl: "https://evil.invalid/run_1", eventsUrl: "/api/v3/runs/run_1/events" })).toBeNull();
  });

  it("cancels a response body rejected by its declared bound", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    expect(await readBoundedDurableJson(new Response(body, { headers: { "content-type": "application/json", "content-length": "999999" } }))).toBeNull();
    await Promise.resolve(); expect(cancelled).toBe(true);
  });

  it("cancels a pending JSON reader promptly on abort", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => undefined); }, cancel() { cancelled = true; } });
    const controller = new AbortController();
    const pending = readBoundedDurableJson(new Response(body, { headers: { "content-type": "application/json" } }), controller.signal);
    controller.abort(); expect(await pending).toBeNull(); expect(cancelled).toBe(true);
  });

  it("rejects sparse output arrays without reading inherited values", () => {
    const run = ownerView("running", "running"); const sparse = Array(2); sparse[1] = "value";
    (run.projection as { output: unknown }).output = sparse;
    expect(parseDurableRunEnvelope({ run })).toBeNull();
  });

  it("rejects accessor-backed output arrays without invoking them", () => {
    let invoked = false; const hostile: unknown[] = [];
    Object.defineProperty(hostile, "0", { enumerable: true, get() { invoked = true; return "secret"; } });
    Object.defineProperty(hostile, "length", { value: 1 });
    const run = ownerView("running", "running"); (run.projection as { output: unknown }).output = hostile;
    expect(parseDurableRunEnvelope({ run })).toBeNull(); expect(invoked).toBe(false);
  });

  it("rejects sparse and accessor-backed projection logs and controls", () => {
    const sparse = ownerView("running", "running"); (sparse.projection as { logs: unknown }).logs = Array(1);
    expect(parseDurableRunEnvelope({ run: sparse })).toBeNull();
    let invoked = false; const controls: unknown[] = [];
    Object.defineProperty(controls, "0", { enumerable: true, get() { invoked = true; return { sequence: 1, action: "pause" }; } }); Object.defineProperty(controls, "length", { value: 1 });
    const hostile = ownerView("running", "running"); (hostile.projection as { controlRequests: unknown }).controlRequests = controls;
    expect(parseDurableRunEnvelope({ run: hostile })).toBeNull(); expect(invoked).toBe(false);
  });

  it("bounds projection error strings in UTF-8 bytes", () => {
    const run = ownerView("running", "running");
    (run.projection as { retry: unknown }).retry = { attempt: 1, availableAt: 2, error: "🔥".repeat(3_000) };
    expect(parseDurableRunEnvelope({ run })).toBeNull();
  });

  it("rejects truncated UTF-8, sequence gaps, and cross-run frames", async () => {
    const truncated = new Response(new Uint8Array([0x69, 0x64, 0x3a, 0x20, 0xc3]), { headers: { "content-type": "text/event-stream" } });
    await expect(readDurableEventStream({ response: truncated, runId: "run_1", after: 0, onEvent() {} })).rejects.toThrow();
    const make = (executionId: string, sequence: number) => ({ schemaVersion: 1, executionId, sequence, attempt: 0, type: "execution.created", at: 1, payload: { definitionHash: "a".repeat(64) } });
    await expect(readDurableEventStream({ response: sse(make("run_1", 2)), runId: "run_1", after: 0, onEvent() {} })).rejects.toThrow("invalid durable event stream");
    await expect(readDurableEventStream({ response: sse(make("other_1", 1)), runId: "run_1", after: 0, onEvent() {} })).rejects.toThrow("invalid durable event stream");
  });

  it("bounds individual SSE frames and total connection bytes", async () => {
    const frame = `id: 1\nevent: durable-execution-event\ndata: ${"x".repeat(300_000)}\n\n`;
    await expect(readDurableEventStream({ response: new Response(frame, { headers: { "content-type": "text/event-stream" } }), runId: "run_1", after: 0, onEvent() {} })).rejects.toThrow("invalid durable event stream");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(200_000)); controller.enqueue(new Uint8Array(200_000)); controller.enqueue(new Uint8Array(200_000)); controller.close(); } });
    await expect(readDurableEventStream({ response: new Response(body, { headers: { "content-type": "text/event-stream" } }), runId: "run_1", after: 0, onEvent() {} })).rejects.toThrow("invalid durable event stream");
  });

  it("rejects poisoned media types while accepting parameterized exact types", async () => {
    expect(await readBoundedDurableJson(new Response("{}", { headers: { "content-type": "application/jsonevil" } }))).toBeNull();
    expect(await readBoundedDurableJson(new Response("{}", { headers: { "content-type": "application/json; charset=utf-8" } }))).toEqual({});
    await expect(readDurableEventStream({ response: new Response("", { headers: { "content-type": "text/event-streamevil" } }), runId: "run_1", after: 0, onEvent() {} })).rejects.toThrow();
  });

  it("cancels a pending SSE reader on abort", async () => {
    let cancelled = false; const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => undefined); }, cancel() { cancelled = true; } });
    const pending = readDurableEventStream({ response: new Response(body, { headers: { "content-type": "text/event-stream" } }), runId: "run_1", after: 0, signal: controller.signal, onEvent() {} });
    controller.abort(); await expect(pending).resolves.toBe(0); expect(cancelled).toBe(true);
  });
});

function sse(value: unknown): Response {
  const sequence = (value as { sequence: number }).sequence;
  return new Response(`id: ${sequence}\nevent: durable-execution-event\ndata: ${JSON.stringify(value)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

function ownerView(state: string, desiredState: string) {
  return {
    executionId: "run_1", flowId: "flow_1", flowVersionId: "version_1", parentExecutionId: null,
    createdAt: 1, updatedAt: 2, finishedAt: null, deadlineAt: 99,
    projection: {
      schemaVersion: 1, executionId: "run_1", sequence: 2, state, desiredState, attempt: 0,
      jobId: "job_1", attemptId: null, costMicroUsdc: 0, tokens: 0, output: null, error: null,
      nodes: {}, logs: [], logCount: 0, controlRequests: [], controlRequestCount: 0,
      retry: null, deadLetter: null,
    },
  };
}
