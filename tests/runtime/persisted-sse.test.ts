import { describe, expect, it, vi } from "vitest";
import { createPersistedEventStream } from "@/lib/runtime/control";
import { parseEventCursor, sseEventFrame } from "@/lib/runtime/api-contract";
import type { DurableRuntimeRepository } from "@/lib/runtime/repository";
import type { DurableExecutionEventV1, DurableExecutionProjection } from "@/lib/runtime/types";

function event(sequence: number, type: "execution.created" | "job.enqueued" = "execution.created"): DurableExecutionEventV1 {
  return type === "execution.created"
    ? { schemaVersion: 1, executionId: "run", sequence, attempt: 0, type, at: sequence, payload: { definitionHash: "d".repeat(64) } }
    : { schemaVersion: 1, executionId: "run", sequence, attempt: 0, type, at: sequence, payload: { jobId: "job", priority: 0, availableAt: 1 } };
}

const projection = (sequence: number, state: DurableExecutionProjection["state"]): DurableExecutionProjection => ({
  schemaVersion: 1, executionId: "run", definitionHash: "d".repeat(64), sequence, state, desiredState: "running", attempt: 0,
  jobId: "job", attemptId: null, costMicroUsdc: 0, tokens: 0, output: null, error: null, nodes: {}, logs: [], logCount: 0,
  controlRequests: [], controlRequestCount: 0, retry: null, deadLetter: null,
});

function repository(options: { events: DurableExecutionEventV1[]; state?: DurableExecutionProjection["state"]; sequence?: number; calls?: string[] }): DurableRuntimeRepository {
  const calls = options.calls ?? [];
  return {
    listEvents: async (_owner: string, _run: string, after: number, limit: number) => { calls.push(`list:${after}`); return options.events.filter((item) => item.sequence > after).slice(0, limit); },
    getExecutionView: async () => { calls.push("view"); const p = projection(options.sequence ?? options.events.at(-1)?.sequence ?? 0, options.state ?? "succeeded"); return { executionId: "run", flowId: "flow", flowVersionId: "version", parentExecutionId: null, createdAt: 1, updatedAt: 1, finishedAt: 1, deadlineAt: null, projection: p }; },
  } as unknown as DurableRuntimeRepository;
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(); const decoder = new TextDecoder(); let result = "";
  while (true) { const part = await reader.read(); if (part.done) return result; result += decoder.decode(part.value, { stream: true }); }
}

describe("persisted durable SSE", () => {
  it.each([
    ["https://x.test/events", {}, 0], ["https://x.test/events?after=0", {}, 0], ["https://x.test/events?after=12", {}, 12],
    ["https://x.test/events", { "last-event-id": "9" }, 9], ["https://x.test/events?after=9", { "last-event-id": "9" }, 9],
  ] as const)("parses one canonical cursor", (url, headers, expected) => {
    expect(parseEventCursor(new Request(url, { headers }))).toBe(expected);
  });

  it.each(["?after=", "?after=01", "?after=+1", "?after=-1", "?after=1.0", "?after=1&after=1", "?after=1&extra=2", "?after=9007199254740992"])("rejects invalid cursor %s", (query) => {
    expect(parseEventCursor(new Request(`https://x.test/events${query}`))).toBe("invalid");
  });

  it("emits exact contiguous stored frames and reconnects after N without duplication", async () => {
    const events = [event(1), event(2, "job.enqueued")];
    const controller = new AbortController();
    expect(await text(createPersistedEventStream({ repository: repository({ events }), ownerId: "owner", executionId: "run", after: 0, signal: controller.signal })))
      .toBe(events.map(sseEventFrame).join(""));
    expect(await text(createPersistedEventStream({ repository: repository({ events }), ownerId: "owner", executionId: "run", after: 1, signal: controller.signal })))
      .toBe(sseEventFrame(events[1]!));
    expect(sseEventFrame(events[0]!)).toContain("event: durable-execution-event\n");
  });

  it("fails closed on noncontiguous or wrong-run repository rows before enqueue", async () => {
    const controller = new AbortController();
    expect(await text(createPersistedEventStream({ repository: repository({ events: [event(2)] }), ownerId: "owner", executionId: "run", after: 0, signal: controller.signal }))).toBe("");
    expect(await text(createPersistedEventStream({ repository: repository({ events: [{ ...event(1), executionId: "other" }] }), ownerId: "owner", executionId: "run", after: 0, signal: controller.signal }))).toBe("");
  });

  it("never performs a repository read when already aborted", async () => {
    const calls: string[] = []; const controller = new AbortController(); controller.abort();
    expect(await text(createPersistedEventStream({ repository: repository({ events: [], calls }), ownerId: "owner", executionId: "run", after: 0, signal: controller.signal }))).toBe("");
    expect(calls).toEqual([]);
  });

  it("reader cancellation aborts polling and performs zero later reads", async () => {
    const calls: string[] = []; const controller = new AbortController();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const stream = createPersistedEventStream({ repository: repository({ events: [], state: "queued", sequence: 0, calls }), ownerId: "owner", executionId: "run", after: 0, signal: controller.signal, wait: async (_ms, signal) => Promise.race([waiting, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]) });
    const reader = stream.getReader();
    await vi.waitFor(() => expect(calls).toEqual(["list:0", "view"]));
    await reader.cancel(); release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["list:0", "view"]);
  });

  it("applies encoded byte and event caps without partial frames", async () => {
    const events = [event(1), event(2, "job.enqueued")]; const controller = new AbortController();
    const firstBytes = new TextEncoder().encode(sseEventFrame(events[0]!)).byteLength;
    expect(await text(createPersistedEventStream({ repository: repository({ events }), ownerId: "owner", executionId: "run", after: 0, signal: controller.signal, maximumBytes: firstBytes, maximumEvents: 100 })))
      .toBe(sseEventFrame(events[0]!));
    expect(await text(createPersistedEventStream({ repository: repository({ events }), ownerId: "owner", executionId: "run", after: 0, signal: controller.signal, maximumEvents: 1 })))
      .toBe(sseEventFrame(events[0]!));
  });
});
