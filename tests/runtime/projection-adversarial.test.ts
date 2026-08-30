import { describe, expect, it } from "vitest";
import { parseDurableExecutionEvent } from "@/lib/runtime/event-schema";
import { foldExecutionEvents } from "@/lib/runtime/projection";

const HASH = "a".repeat(64);
const raw = (sequence: number, type: string, payload: Record<string, unknown>, attempt = 0) => ({
  schemaVersion: 1, executionId: "exec-1", sequence, attempt, type, at: sequence, payload,
});
const parsed = (sequence: number, type: string, payload: Record<string, unknown>, attempt = 0) =>
  parseDurableExecutionEvent(raw(sequence, type, payload, attempt));

describe("durable projection adversarial transitions", () => {
  it("rejects empty, duplicate, missing, out-of-order, and cross-execution streams", () => {
    const created = parsed(1, "execution.created", { definitionHash: HASH });
    const enqueued = parsed(2, "job.enqueued", { jobId: "j", priority: 0, availableAt: 2 });
    for (const stream of [
      [],
      [created, created],
      [created, { ...enqueued, sequence: 3 }],
      [enqueued, created],
      [created, { ...enqueued, executionId: "exec-2" }],
    ]) expect(() => foldExecutionEvents(stream as never)).toThrow("Invalid durable execution projection");
  });

  it("validates typed-looking events again and never invokes caller getters", () => {
    let calls = 0;
    const hostile = Object.defineProperty({}, "schemaVersion", { enumerable: true, get: () => { calls += 1; return 1; } });
    expect(() => foldExecutionEvents([hostile as never])).toThrow("Invalid durable execution projection");
    expect(calls).toBe(0);
    const forged = { ...raw(1, "execution.created", { definitionHash: HASH }), extra: true };
    expect(() => foldExecutionEvents([forged as never])).toThrow("Invalid durable execution projection");

    let arrayGetterCalls = 0;
    const accessorStream = [] as unknown[];
    Object.defineProperty(accessorStream, "0", {
      enumerable: true,
      get: () => {
        arrayGetterCalls += 1;
        return raw(1, "execution.created", { definitionHash: HASH });
      },
    });
    Object.defineProperty(accessorStream, "length", { value: 1 });
    expect(() => foldExecutionEvents(accessorStream as never)).toThrow("Invalid durable execution projection");
    expect(arrayGetterCalls).toBe(0);
  });

  it("rejects impossible lifecycle, attempt, node pairing, and counter transitions", () => {
    const created = parsed(1, "execution.created", { definitionHash: HASH });
    const enqueued = parsed(2, "job.enqueued", { jobId: "j", priority: 0, availableAt: 2 });
    const claimed = parsed(3, "job.claimed", { jobId: "j", attemptId: "a1", workerId: "w", leaseExpiresAt: 10 }, 1);
    const started = parsed(4, "attempt.started", { attemptId: "a1" }, 1);
    const nodeStarted = parsed(5, "node.started", { nodeId: "n" }, 1);
    const cases = [
      [created, parsed(2, "execution.succeeded", { output: null, costMicroUsdc: 0, tokens: 0 })],
      [created, enqueued, parsed(3, "attempt.started", { attemptId: "a1" }, 1)],
      [created, enqueued, claimed, parsed(4, "attempt.started", { attemptId: "different" }, 1)],
      [created, enqueued, claimed, started, parsed(5, "node.completed", { nodeId: "n", output: null, costMicroUsdc: 0, tokens: 0 }, 1)],
      [created, enqueued, claimed, started, nodeStarted, parsed(6, "node.started", { nodeId: "n" }, 1)],
      [created, enqueued, claimed, started, nodeStarted, parsed(6, "node.completed", { nodeId: "n", output: null, costMicroUsdc: 3, tokens: 2 }, 1), parsed(7, "execution.succeeded", { output: null, costMicroUsdc: 2, tokens: 2 }, 1)],
      [created, enqueued, claimed, started, nodeStarted, parsed(6, "node.completed", { nodeId: "n", output: null, costMicroUsdc: 0, tokens: 0 }, 1), parsed(7, "node.started", { nodeId: "n" }, 1)],
      [created, enqueued, claimed, started, nodeStarted, parsed(6, "node.failed", { nodeId: "n", error: "failed" }, 1), parsed(7, "node.started", { nodeId: "n" }, 1)],
      [created, enqueued, claimed, started, nodeStarted, parsed(6, "node.completed", { nodeId: "n", output: null, costMicroUsdc: 3, tokens: 2 }, 1), parsed(7, "execution.succeeded", { output: null, costMicroUsdc: 4, tokens: 2 }, 1)],
      [created, enqueued, claimed, started, nodeStarted, parsed(6, "node.completed", { nodeId: "n", output: null, costMicroUsdc: 3, tokens: 2 }, 1), parsed(7, "execution.failed", { error: "x", costMicroUsdc: 3, tokens: 3 }, 1)],
    ];
    for (const stream of cases) expect(() => foldExecutionEvents(stream)).toThrow("Invalid durable execution projection");
  });

  it("rejects aggregate node overflow with the fixed projection error", () => {
    const specs: Array<[string, Record<string, unknown>, number?]> = [
      ["execution.created", { definitionHash: HASH }],
      ["job.enqueued", { jobId: "j", priority: 0, availableAt: 2 }],
      ["job.claimed", { jobId: "j", attemptId: "a", workerId: "w", leaseExpiresAt: 10 }, 1],
      ["attempt.started", { attemptId: "a" }, 1],
    ];
    for (let index = 0; index <= 1_000; index += 1) specs.push(["node.started", { nodeId: `n-${index}` }, 1]);
    const stream = specs.map(([type, payload, attempt = 0], index) => parsed(index + 1, type, payload, attempt));
    expect(() => foldExecutionEvents(stream)).toThrow(new Error("Invalid durable execution projection"));
  });

  it("rejects immediate and non-adjacent attempt ID reuse without exposing replay bookkeeping", () => {
    const prefix = [
      parsed(1, "execution.created", { definitionHash: HASH }),
      parsed(2, "job.enqueued", { jobId: "j", priority: 0, availableAt: 2 }),
      parsed(3, "job.claimed", { jobId: "j", attemptId: "a1", workerId: "w1", leaseExpiresAt: 10 }, 1),
      parsed(4, "attempt.started", { attemptId: "a1" }, 1),
      parsed(5, "attempt.retry_scheduled", { attemptId: "a1", error: "retry-1", availableAt: 6 }, 1),
    ];
    expect(() => foldExecutionEvents([
      ...prefix,
      parsed(6, "job.claimed", { jobId: "j", attemptId: "a1", workerId: "w2", leaseExpiresAt: 20 }, 2),
    ])).toThrow("Invalid durable execution projection");

    const distinctSecondAttempt = [
      ...prefix,
      parsed(6, "job.claimed", { jobId: "j", attemptId: "a2", workerId: "w2", leaseExpiresAt: 20 }, 2),
      parsed(7, "attempt.started", { attemptId: "a2" }, 2),
      parsed(8, "attempt.retry_scheduled", { attemptId: "a2", error: "retry-2", availableAt: 9 }, 2),
    ];
    expect(() => foldExecutionEvents([
      ...distinctSecondAttempt,
      parsed(9, "job.claimed", { jobId: "j", attemptId: "a1", workerId: "w3", leaseExpiresAt: 30 }, 3),
    ])).toThrow("Invalid durable execution projection");

    const projection = foldExecutionEvents(distinctSecondAttempt);
    expect(Object.hasOwn(projection, "seenAttemptIds")).toBe(false);
    expect(JSON.stringify(projection)).not.toContain("seenAttemptIds");
  });

  it("keeps terminal projections immutable", () => {
    const terminal = [
      parsed(1, "execution.created", { definitionHash: HASH }),
      parsed(2, "job.enqueued", { jobId: "j", priority: 0, availableAt: 2 }),
      parsed(3, "job.claimed", { jobId: "j", attemptId: "a", workerId: "w", leaseExpiresAt: 4 }, 1),
      parsed(4, "attempt.started", { attemptId: "a" }, 1),
      parsed(5, "execution.succeeded", { output: null, costMicroUsdc: 0, tokens: 0 }, 1),
    ];
    expect(() => foldExecutionEvents([...terminal, parsed(6, "control.requested", { action: "cancel" }, 1)])).toThrow("Invalid durable execution projection");
  });
});
