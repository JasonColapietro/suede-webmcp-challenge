import { describe, expect, it } from "vitest";
import { parseDurableExecutionEvent } from "@/lib/runtime/event-schema";
import { foldExecutionEvents } from "@/lib/runtime/projection";

const HASH = "a".repeat(64);

function events(specs: readonly [string, Record<string, unknown>, number?][]) {
  return specs.map(([type, payload, attempt = 0], index) => parseDurableExecutionEvent({
    schemaVersion: 1,
    executionId: "exec-1",
    sequence: index + 1,
    attempt,
    type,
    at: index + 1,
    payload,
  }));
}

describe("durable execution projection", () => {
  it("folds the complete success lifecycle with integer counters and paired nodes", () => {
    const stream = events([
      ["execution.created", { definitionHash: HASH }],
      ["job.enqueued", { jobId: "job-1", priority: 0, availableAt: 2 }],
      ["job.claimed", { jobId: "job-1", attemptId: "attempt-1", workerId: "worker-1", leaseExpiresAt: 10 }, 1],
      ["attempt.started", { attemptId: "attempt-1" }, 1],
      ["node.started", { nodeId: "node-1" }, 1],
      ["node.logged", { nodeId: "node-1", level: "info", message: "working" }, 1],
      ["node.completed", { nodeId: "node-1", output: { result: 1 }, costMicroUsdc: 7, tokens: 9 }, 1],
      ["execution.succeeded", { output: { done: true }, costMicroUsdc: 7, tokens: 9 }, 1],
    ]);
    const projection = foldExecutionEvents(stream);
    expect(projection).toMatchObject({
      schemaVersion: 1,
      executionId: "exec-1",
      definitionHash: HASH,
      sequence: 8,
      state: "succeeded",
      desiredState: "running",
      attempt: 1,
      costMicroUsdc: 7,
      tokens: 9,
      output: { done: true },
      error: null,
      retry: null,
      deadLetter: null,
      logCount: 1,
      controlRequestCount: 0,
    });
    expect(projection.nodes).toEqual({
      "node-1": { state: "completed", attempt: 1, output: { result: 1 }, error: null },
    });
    expect(projection.logs).toEqual([{ sequence: 6, nodeId: "node-1", level: "info", message: "working" }]);
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it("derives control, pause, resume, cancellation, retry, failure, and dead-letter facts", () => {
    const paused = foldExecutionEvents(events([
      ["execution.created", { definitionHash: HASH }],
      ["job.enqueued", { jobId: "job-1", priority: 0, availableAt: 2 }],
      ["control.requested", { action: "pause" }],
      ["execution.paused", {}],
      ["control.requested", { action: "resume" }],
      ["execution.resumed", {}],
      ["job.claimed", { jobId: "job-1", attemptId: "a1", workerId: "w", leaseExpiresAt: 10 }, 1],
      ["attempt.started", { attemptId: "a1" }, 1],
      ["node.started", { nodeId: "n" }, 1],
      ["node.failed", { nodeId: "n", error: "transient" }, 1],
      ["attempt.retry_scheduled", { attemptId: "a1", error: "transient", availableAt: 20 }, 1],
      ["job.claimed", { jobId: "job-1", attemptId: "a2", workerId: "w", leaseExpiresAt: 30 }, 2],
      ["attempt.started", { attemptId: "a2" }, 2],
      ["execution.dead_lettered", { error: "exhausted" }, 2],
    ]));
    expect(paused.state).toBe("dead");
    expect(paused.desiredState).toBe("running");
    expect(paused.retry).toEqual({ attempt: 1, availableAt: 20, error: "transient" });
    expect(paused.deadLetter).toEqual({ attempt: 2, error: "exhausted" });
    expect(paused.controlRequests).toEqual([
      { sequence: 3, action: "pause" },
      { sequence: 5, action: "resume" },
    ]);

    const cancelled = foldExecutionEvents(events([
      ["execution.created", { definitionHash: HASH }],
      ["job.enqueued", { jobId: "j", priority: 0, availableAt: 1 }],
      ["control.requested", { action: "cancel" }],
      ["execution.cancelled", { reason: "cancelled" }],
    ]));
    expect(cancelled).toMatchObject({ state: "cancelled", desiredState: "cancelled", error: "cancelled" });

    const failed = foldExecutionEvents(events([
      ["execution.created", { definitionHash: HASH }],
      ["job.enqueued", { jobId: "j", priority: 0, availableAt: 1 }],
      ["job.claimed", { jobId: "j", attemptId: "a", workerId: "w", leaseExpiresAt: 2 }, 1],
      ["attempt.started", { attemptId: "a" }, 1],
      ["execution.failed", { error: "permanent", costMicroUsdc: 0, tokens: 0 }, 1],
    ]));
    expect(failed).toMatchObject({ state: "failed", error: "permanent", costMicroUsdc: 0, tokens: 0 });
  });

  it("replays a crashed in-flight node on the next attempt", () => {
    const projection = foldExecutionEvents(events([
      ["execution.created", { definitionHash: HASH }],
      ["job.enqueued", { jobId: "j", priority: 0, availableAt: 2 }],
      ["job.claimed", { jobId: "j", attemptId: "a1", workerId: "w1", leaseExpiresAt: 10 }, 1],
      ["attempt.started", { attemptId: "a1" }, 1],
      ["node.started", { nodeId: "n" }, 1],
      ["attempt.retry_scheduled", { attemptId: "a1", error: "lease expired", availableAt: 20 }, 1],
      ["job.claimed", { jobId: "j", attemptId: "a2", workerId: "w2", leaseExpiresAt: 30 }, 2],
      ["attempt.started", { attemptId: "a2" }, 2],
      ["node.started", { nodeId: "n" }, 2],
      ["node.completed", { nodeId: "n", output: "replayed", costMicroUsdc: 0, tokens: 0 }, 2],
      ["execution.succeeded", { output: "done", costMicroUsdc: 0, tokens: 0 }, 2],
    ]));
    expect(projection.nodes.n).toEqual({ state: "completed", attempt: 2, output: "replayed", error: null });
  });

  it("replays an in-flight node after cooperative pause and whole-run resume", () => {
    const projection = foldExecutionEvents(events([
      ["execution.created", { definitionHash: HASH }],
      ["job.enqueued", { jobId: "j", priority: 0, availableAt: 2 }],
      ["job.claimed", { jobId: "j", attemptId: "a1", workerId: "w1", leaseExpiresAt: 10 }, 1],
      ["attempt.started", { attemptId: "a1" }, 1],
      ["node.started", { nodeId: "n" }, 1],
      ["control.requested", { action: "pause" }, 1],
      ["execution.paused", {}, 1],
      ["control.requested", { action: "resume" }, 1],
      ["execution.resumed", {}, 1],
      ["job.claimed", { jobId: "j", attemptId: "a2", workerId: "w2", leaseExpiresAt: 20 }, 2],
      ["attempt.started", { attemptId: "a2" }, 2],
      ["node.started", { nodeId: "n" }, 2],
      ["node.completed", { nodeId: "n", output: null, costMicroUsdc: 0, tokens: 0 }, 2],
      ["execution.succeeded", { output: null, costMicroUsdc: 0, tokens: 0 }, 2],
    ]));
    expect(projection).toMatchObject({ state: "succeeded", attempt: 2 });
    expect(projection.nodes.n.attempt).toBe(2);
  });

  it("bounds node records and log/control history while retaining total counts", () => {
    const nodeSpecs: Array<[string, Record<string, unknown>, number?]> = [
      ["execution.created", { definitionHash: HASH }],
      ["job.enqueued", { jobId: "j", priority: 0, availableAt: 2 }],
      ["job.claimed", { jobId: "j", attemptId: "a", workerId: "w", leaseExpiresAt: 10 }, 1],
      ["attempt.started", { attemptId: "a" }, 1],
    ];
    for (let index = 0; index < 1_000; index += 1) {
      nodeSpecs.push(["node.started", { nodeId: `n-${index}` }, 1]);
      nodeSpecs.push(["node.completed", { nodeId: `n-${index}`, output: null, costMicroUsdc: 0, tokens: 0 }, 1]);
    }
    const boundedNodes = foldExecutionEvents(events(nodeSpecs));
    expect(Object.keys(boundedNodes.nodes)).toHaveLength(1_000);

    const logSpecs: Array<[string, Record<string, unknown>, number?]> = [
      ["execution.created", { definitionHash: HASH }],
      ["job.enqueued", { jobId: "j", priority: 0, availableAt: 2 }],
      ["job.claimed", { jobId: "j", attemptId: "a", workerId: "w", leaseExpiresAt: 10 }, 1],
      ["attempt.started", { attemptId: "a" }, 1],
      ["node.started", { nodeId: "n" }, 1],
    ];
    for (let index = 0; index < 205; index += 1) logSpecs.push(["node.logged", { nodeId: "n", level: "info", message: `log-${index}` }, 1]);
    const boundedLogs = foldExecutionEvents(events(logSpecs));
    expect(boundedLogs.logCount).toBe(205);
    expect(boundedLogs.logs).toHaveLength(200);
    expect(boundedLogs.logs[0]?.message).toBe("log-5");
    expect(boundedLogs.logs.at(-1)?.message).toBe("log-204");

    const controlSpecs: Array<[string, Record<string, unknown>, number?]> = [
      ["execution.created", { definitionHash: HASH }],
      ["job.enqueued", { jobId: "j", priority: 0, availableAt: 2 }],
    ];
    for (let index = 0; index < 51; index += 1) {
      controlSpecs.push(["control.requested", { action: "pause" }], ["execution.paused", {}], ["control.requested", { action: "resume" }], ["execution.resumed", {}]);
    }
    const boundedControls = foldExecutionEvents(events(controlSpecs));
    expect(boundedControls.controlRequestCount).toBe(102);
    expect(boundedControls.controlRequests).toHaveLength(100);
  });

  it("derives cancelled and dead totals only from accumulated node facts", () => {
    const prefix: Array<[string, Record<string, unknown>, number?]> = [
      ["execution.created", { definitionHash: HASH }],
      ["job.enqueued", { jobId: "j", priority: 0, availableAt: 2 }],
      ["job.claimed", { jobId: "j", attemptId: "a", workerId: "w", leaseExpiresAt: 10 }, 1],
      ["attempt.started", { attemptId: "a" }, 1],
      ["node.started", { nodeId: "n" }, 1],
      ["node.completed", { nodeId: "n", output: null, costMicroUsdc: 5, tokens: 6 }, 1],
    ];
    const cancelled = foldExecutionEvents(events([
      ...prefix,
      ["control.requested", { action: "cancel" }, 1],
      ["execution.cancelled", { reason: "cancelled" }, 1],
    ]));
    const dead = foldExecutionEvents(events([
      ...prefix,
      ["execution.dead_lettered", { error: "exhausted" }, 1],
    ]));
    expect(cancelled).toMatchObject({ state: "cancelled", costMicroUsdc: 5, tokens: 6 });
    expect(dead).toMatchObject({ state: "dead", costMicroUsdc: 5, tokens: 6 });
  });

  it("is deterministic across full replay and never mutates its inputs", () => {
    const stream = events([
      ["execution.created", { definitionHash: HASH }],
      ["job.enqueued", { jobId: "j", priority: 1, availableAt: 2 }],
    ]);
    const before = JSON.stringify(stream);
    expect(foldExecutionEvents(stream)).toEqual(foldExecutionEvents(stream));
    expect(JSON.stringify(stream)).toBe(before);
  });
});
