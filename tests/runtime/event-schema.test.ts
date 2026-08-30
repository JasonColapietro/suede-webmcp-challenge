import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDurableExecutionEvent } from "@/lib/runtime/event-schema";

const HASH = "a".repeat(64);

function event(type: string, payload: unknown, overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    executionId: "exec-1",
    sequence: 1,
    attempt: 0,
    type,
    at: 1,
    payload,
    ...overrides,
  };
}

const VALID_EVENTS = [
  event("execution.created", { definitionHash: HASH }),
  event("job.enqueued", { jobId: "job-1", priority: 0, availableAt: 1 }),
  event("job.claimed", { jobId: "job-1", attemptId: "attempt-1", workerId: "worker-1", leaseExpiresAt: 2 }),
  event("attempt.started", { attemptId: "attempt-1" }, { attempt: 1 }),
  event("node.started", { nodeId: "node-1" }, { attempt: 1 }),
  event("node.logged", { nodeId: "node-1", level: "info", message: "hello" }, { attempt: 1 }),
  event("node.completed", { nodeId: "node-1", output: { ok: true }, costMicroUsdc: 2, tokens: 3 }, { attempt: 1 }),
  event("node.failed", { nodeId: "node-1", error: "fixed failure" }, { attempt: 1 }),
  event("control.requested", { action: "pause" }),
  event("attempt.retry_scheduled", { attemptId: "attempt-1", error: "transient", availableAt: 5 }, { attempt: 1 }),
  event("execution.paused", {}),
  event("execution.resumed", {}),
  event("execution.cancelled", { reason: "cancelled" }),
  event("execution.succeeded", { output: { answer: 42 }, costMicroUsdc: 2, tokens: 3 }, { attempt: 1 }),
  event("execution.failed", { error: "failed", costMicroUsdc: 2, tokens: 3 }, { attempt: 1 }),
  event("execution.dead_lettered", { error: "exhausted" }, { attempt: 1 }),
] as const;

describe("durable execution event v1", () => {
  it("accepts every exact v1 event and returns deeply frozen data", () => {
    for (const raw of VALID_EVENTS) {
      const parsed = parseDurableExecutionEvent(raw);
      expect(parsed.type).toBe((raw as { type: string }).type);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.payload)).toBe(true);
    }
    const parsed = parseDurableExecutionEvent(event("node.completed", {
      nodeId: "node-1",
      output: { nested: [1, { ok: true }] },
      costMicroUsdc: 0,
      tokens: 0,
    }));
    if (parsed.type !== "node.completed") throw new Error("expected node.completed event");
    expect(Object.isFrozen(parsed.payload.output)).toBe(true);
    expect(Object.isFrozen((parsed.payload.output as { nested: unknown[] }).nested)).toBe(true);
  });

  it("enforces exact envelope and discriminated payload keys", () => {
    expect(() => parseDurableExecutionEvent({ ...(event("execution.created", { definitionHash: HASH }) as Record<string, unknown>), extra: true })).toThrow("Invalid durable execution event");
    expect(() => parseDurableExecutionEvent(event("execution.created", { definitionHash: HASH, extra: true }))).toThrow("Invalid durable execution event");
    expect(() => parseDurableExecutionEvent(event("node.logged", { nodeId: "n", message: "x", level: "debug" }))).toThrow("Invalid durable execution event");
  });

  it("accepts 512-character identities and rejects longer, blank, or unsafe identities", () => {
    expect(parseDurableExecutionEvent(event("execution.created", { definitionHash: HASH }, { executionId: "x".repeat(512) })).executionId).toHaveLength(512);
    for (const executionId of ["x".repeat(513), "", "   ", "line\nbreak"]) {
      expect(() => parseDurableExecutionEvent(event("execution.created", { definitionHash: HASH }, { executionId }))).toThrow("Invalid durable execution event");
    }
    expect(() => parseDurableExecutionEvent(event("node.started", { nodeId: "x".repeat(513) }))).toThrow("Invalid durable execution event");
    for (const nodeId of ["__proto__", "prototype", "constructor"]) {
      expect(() => parseDurableExecutionEvent(event("node.started", { nodeId }))).toThrow("Invalid durable execution event");
    }
  });

  it("bounds logs, outputs, errors, total payload bytes, and depth", () => {
    expect(() => parseDurableExecutionEvent(event("node.logged", { nodeId: "n", level: "info", message: "x".repeat(16 * 1024 + 1) }))).toThrow("Invalid durable execution event");
    expect(() => parseDurableExecutionEvent(event("node.failed", { nodeId: "n", error: "x".repeat(8 * 1024 + 1) }))).toThrow("Invalid durable execution event");
    expect(() => parseDurableExecutionEvent(event("node.completed", { nodeId: "n", output: "x".repeat(128 * 1024 + 1), costMicroUsdc: 0, tokens: 0 }))).toThrow("Invalid durable execution event");
    expect(() => parseDurableExecutionEvent(event("node.completed", { nodeId: "n", output: { value: "😀".repeat(70_000) }, costMicroUsdc: 0, tokens: 0 }))).toThrow("Invalid durable execution event");
    let deep: unknown = "leaf";
    for (let index = 0; index < 33; index += 1) deep = { value: deep };
    expect(() => parseDurableExecutionEvent(event("node.completed", { nodeId: "n", output: deep, costMicroUsdc: 0, tokens: 0 }))).toThrow("Invalid durable execution event");
  });

  it("enforces the 8192-byte UTF-8 boundary for every error and reason path", () => {
    const payloads = [
      ["node.failed", (value: string) => ({ nodeId: "n", error: value })],
      ["attempt.retry_scheduled", (value: string) => ({ attemptId: "a", error: value, availableAt: 5 })],
      ["execution.cancelled", (value: string) => ({ reason: value })],
      ["execution.failed", (value: string) => ({ error: value, costMicroUsdc: 0, tokens: 0 })],
      ["execution.dead_lettered", (value: string) => ({ error: value })],
    ] as const;
    const asciiExact = "x".repeat(8_192);
    const asciiOver = `${asciiExact}x`;
    const multibyteExact = "é".repeat(4_096);
    const multibyteOver = `${multibyteExact}é`;

    for (const [type, payload] of payloads) {
      expect(() => parseDurableExecutionEvent(event(type, payload(asciiExact)))).not.toThrow();
      expect(() => parseDurableExecutionEvent(event(type, payload(asciiOver)))).toThrow("Invalid durable execution event");
      expect(() => parseDurableExecutionEvent(event(type, payload(multibyteExact)))).not.toThrow();
      expect(() => parseDurableExecutionEvent(event(type, payload(multibyteOver)))).toThrow("Invalid durable execution event");
    }
  });

  it("rejects hostile, non-data, and noncanonical values without invoking accessors", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "schemaVersion", { enumerable: true, get: () => { getterCalls += 1; return 1; } });
    const sparse = Array(2);
    sparse[1] = "present";
    const decorated = ["safe"] as unknown[] & { extra?: string };
    decorated.extra = "no";
    const symbolic = { safe: true, [Symbol("hidden")]: "no" };
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.value = "no";
    for (const raw of [
      accessor,
      event("node.completed", { nodeId: "n", output: sparse, costMicroUsdc: 0, tokens: 0 }),
      event("node.completed", { nodeId: "n", output: decorated, costMicroUsdc: 0, tokens: 0 }),
      event("node.completed", { nodeId: "n", output: symbolic, costMicroUsdc: 0, tokens: 0 }),
      event("node.completed", { nodeId: "n", output: nullPrototype, costMicroUsdc: 0, tokens: 0 }),
      event("node.completed", { nodeId: "n", output: NaN, costMicroUsdc: 0, tokens: 0 }),
    ]) expect(() => parseDurableExecutionEvent(raw)).toThrow("Invalid durable execution event");
    expect(getterCalls).toBe(0);
  });

  it("rejects future versions, unknown types, and noncanonical numeric fields", () => {
    for (const raw of [
      event("execution.created", { definitionHash: HASH }, { schemaVersion: 2 }),
      event("future.event", {}),
      event("execution.created", { definitionHash: HASH }, { sequence: 0 }),
      event("execution.created", { definitionHash: HASH }, { sequence: 1.5 }),
      event("execution.created", { definitionHash: HASH }, { sequence: Number.MAX_SAFE_INTEGER + 1 }),
      event("execution.created", { definitionHash: HASH }, { attempt: -1 }),
      event("execution.created", { definitionHash: HASH }, { at: Infinity }),
    ]) expect(() => parseDurableExecutionEvent(raw)).toThrow("Invalid durable execution event");
    expect(() => parseDurableExecutionEvent(event("control.requested", { action: "retry" }))).toThrow("Invalid durable execution event");
  });

  it("keeps the event schema, creation sequence, and v3 retry API plan consistent", () => {
    const design = readFileSync("docs/superpowers/specs/2026-07-12-phase-3a-durable-runtime-design.md", "utf8");
    const plan = readFileSync("docs/superpowers/plans/2026-07-12-phase-3a-durable-runtime.md", "utf8");
    for (const document of [design, plan]) {
      expect(document).toContain("`execution.created` sequence 1");
      expect(document).toContain("`job.enqueued` sequence 2");
      expect(document).toContain("`job.claimed` sequence 3");
      expect(document).toContain("`attempt.started` sequence 4");
      expect(document).toContain("`control.requested` payload is strictly `cancel | pause | resume`");
      expect(document).toContain("The v3 `retry` action creates a new execution lineage and never appends to or mutates the terminal source execution stream.");
    }
  });

  it("uses one fixed non-echoing failure", () => {
    const secret = "do-not-echo-raw-value";
    try {
      parseDurableExecutionEvent(event("node.failed", { nodeId: "n", error: secret, extra: true }));
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toEqual(new Error("Invalid durable execution event"));
      expect(String(error)).not.toContain(secret);
    }
  });
});
