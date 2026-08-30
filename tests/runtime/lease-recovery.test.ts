import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { foldExecutionEvents } from "@/lib/runtime/projection";
import type { DurableExecutionEventV1 } from "@/lib/runtime/types";
import { createInput, task3Fixture } from "./task3-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function claimed(maxAttempts = 2) {
  const setup = task3Fixture(); roots.push(setup.root);
  await setup.repo.createExecution(createInput(1, { maxAttempts }));
  const result = await setup.repo.claimNextJob({ workerId: "worker", leaseDurationMs: 10 });
  if (result.status !== "claimed") throw new Error("expected claim");
  return { ...setup, claim: result.claim };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

async function seedLargeLeasedHistory(repo: Awaited<ReturnType<typeof claimed>>["repo"], path: string): Promise<void> {
  const base = [...await repo.listEvents("owner", "execution-1", 0, 10)] as DurableExecutionEventV1[];
  const events: DurableExecutionEventV1[] = [...base, { schemaVersion: 1, executionId: "execution-1", sequence: 5, attempt: 1, type: "node.started", at: 11, payload: { nodeId: "node" } }];
  for (let index = 0; index < 1_001; index += 1) events.push({ schemaVersion: 1, executionId: "execution-1", sequence: index + 6, attempt: 1, type: "node.logged", at: index + 12, payload: { nodeId: "node", level: "info", message: `log-${index}` } });
  const db = new Database(path); const insert = db.prepare("INSERT INTO execution_events (execution_id, seq, schema_version, attempt, type, at, payload_json) VALUES (?, ?, 1, ?, ?, ?, ?)");
  db.transaction(() => { for (const event of events.slice(4)) insert.run(event.executionId, event.sequence, event.attempt, event.type, event.at, JSON.stringify(event.payload)); })();
  const projection = foldExecutionEvents(events);
  db.prepare("UPDATE durable_executions SET projected_event_seq = ?, next_event_seq = ?, projection_json = ?, updated_at = ? WHERE id = 'execution-1'").run(projection.sequence, projection.sequence + 1, canonicalJson(projection), events[events.length - 1]!.at);
  db.close();
}

describe("lease fencing and recovery", () => {
  it("has no public generic event append that can bypass a lease", async () => {
    const { repo } = await claimed();
    expect("appendEvent" in repo).toBe(false);
    repo.close();
  });

  it("uses only its trusted clock for claim, leased event, and completion timestamps", async () => {
    const setup = task3Fixture(); roots.push(setup.root); await setup.repo.createExecution(createInput(1));
    const claim = await setup.repo.claimNextJob({ workerId: "worker", leaseDurationMs: 10, now: Number.MAX_SAFE_INTEGER } as never);
    if (claim.status !== "claimed") throw new Error("expected trusted-clock claim");
    expect(claim.claim.leaseExpiresAt).toBe(20);
    setup.clock.now = 15;
    expect((await setup.repo.appendLeasedEvent({ jobId: claim.claim.jobId, attemptId: claim.claim.attemptId, leaseToken: claim.claim.leaseToken, expectedSequence: 4, event: { schemaVersion: 1, attempt: 99, type: "node.started", at: Number.MAX_SAFE_INTEGER, payload: { nodeId: "node" } } } as never)).status).toBe("appended");
    setup.clock.now = 16;
    expect((await setup.repo.completeAttempt({ jobId: claim.claim.jobId, attemptId: claim.claim.attemptId, leaseToken: claim.claim.leaseToken, now: -1, output: { ok: true } } as never)).status).toBe("completed");
    const db = new Database(setup.path);
    expect(db.prepare("SELECT seq, at FROM execution_events WHERE seq >= 3 ORDER BY seq").all()).toEqual([{ seq: 3, at: 10 }, { seq: 4, at: 10 }, { seq: 5, at: 15 }, { seq: 6, at: 16 }]);
    expect(db.prepare("SELECT finished_at FROM execution_attempts").get()).toEqual({ finished_at: 16 });
    db.close(); setup.repo.close();
  });

  it("appends under the live lease and completes the exact attempt", async () => {
    const { repo, path, claim, clock } = await claimed(); clock.now = 15;
    const appended = await repo.appendLeasedEvent({ jobId: claim.jobId, attemptId: claim.attemptId, leaseToken: claim.leaseToken, expectedSequence: 4, event: { schemaVersion: 1, type: "node.started", payload: { nodeId: "node" } } });
    expect(appended.status).toBe("appended"); clock.now = 16;
    const completed = await repo.completeAttempt({ jobId: claim.jobId, attemptId: claim.attemptId, leaseToken: claim.leaseToken, output: { ok: true } });
    expect(completed.status).toBe("completed");
    if (completed.status === "completed") expect(completed.execution).toMatchObject({ state: "succeeded", output: { ok: true }, sequence: 6 });
    clock.now = 17; expect((await repo.completeAttempt({ jobId: claim.jobId, attemptId: claim.attemptId, leaseToken: claim.leaseToken, output: {} })).status).toBe("lost");
    const db = new Database(path);
    expect(db.prepare("SELECT state FROM execution_jobs").get()).toEqual({ state: "completed" });
    expect(db.prepare("SELECT state, finished_at FROM execution_attempts").get()).toEqual({ state: "succeeded", finished_at: 16 });
    db.close(); repo.close();
  });

  it("schedules deterministic failure retry and permanently fails a later exact attempt", async () => {
    const { repo, path, claim, clock } = await claimed(); clock.now = 15;
    expect((await repo.failAttempt({ jobId: claim.jobId, attemptId: claim.attemptId, leaseToken: claim.leaseToken, classification: "transient", error: "temporary" })).status).toBe("retry-scheduled");
    const db = new Database(path); const availableAt = (db.prepare("SELECT available_at FROM execution_jobs").get() as { available_at: number }).available_at; db.close();
    clock.now = availableAt;
    const next = await repo.claimNextJob({ workerId: "worker-2", leaseDurationMs: 100 });
    if (next.status !== "claimed") throw new Error("expected retry claim"); clock.now += 1;
    expect((await repo.failAttempt({ jobId: next.claim.jobId, attemptId: next.claim.attemptId, leaseToken: next.claim.leaseToken, classification: "permanent", error: "fixed failure" })).status).toBe("failed");
    expect((await repo.getExecution("owner", claim.executionId))?.state).toBe("failed"); repo.close();
  });

  it("retains an exact live lease when heartbeat would not extend it and reports cancellation", async () => {
    const { repo, claim, clock } = await claimed(); clock.now = 15;
    expect(await repo.heartbeat({ jobId: claim.jobId, attemptId: claim.attemptId, leaseToken: claim.leaseToken, leaseDurationMs: 1 })).toEqual({ status: "retained", leaseExpiresAt: 20, desiredState: "running", cancelRequested: false });
    expect(await repo.heartbeat({ jobId: claim.jobId, attemptId: claim.attemptId, leaseToken: claim.leaseToken, leaseDurationMs: 20 })).toEqual({ status: "extended", leaseExpiresAt: 35, desiredState: "running", cancelRequested: false });
    expect((await repo.heartbeat({ jobId: claim.jobId, attemptId: claim.attemptId, leaseToken: "0".repeat(64), leaseDurationMs: 20 })).status).toBe("lost");
    const db = new Database((repo as unknown as { db: Database.Database }).db.name);
    db.prepare("UPDATE durable_executions SET desired_state = 'cancelled' WHERE id = ?").run(claim.executionId); db.close();
    clock.now = 20;
    expect(await repo.heartbeat({ jobId: claim.jobId, attemptId: claim.attemptId, leaseToken: claim.leaseToken, leaseDurationMs: 20 })).toMatchObject({ status: "extended", desiredState: "cancelled", cancelRequested: true });
    clock.now = 21; expect((await repo.completeAttempt({ jobId: claim.jobId, attemptId: claim.attemptId, leaseToken: claim.leaseToken, output: {} })).status).toBe("lost"); repo.close();
  });

  it("cannot backdate or forward-date a stale worker past the trusted lease clock", async () => {
    const { repo, path, claim, clock } = await claimed(); clock.now = 21;
    const identity = { jobId: claim.jobId, attemptId: claim.attemptId, leaseToken: claim.leaseToken };
    expect((await repo.heartbeat({ ...identity, leaseDurationMs: 100, now: 11 } as never)).status).toBe("lost");
    expect((await repo.appendLeasedEvent({ ...identity, expectedSequence: 4, event: { schemaVersion: 1, type: "node.started", at: 11, payload: { nodeId: "node" } } } as never)).status).toBe("lost");
    expect((await repo.completeAttempt({ ...identity, now: 11, output: {} } as never)).status).toBe("lost");
    expect((await repo.failAttempt({ ...identity, now: 11, classification: "transient", error: "late" } as never)).status).toBe("lost");
    expect(await repo.recoverExpiredLeases({ limit: 10, now: -1 } as never)).toEqual({ status: "recovered", recovered: 1, retried: 1, deadLettered: 0 });
    const db = new Database(path); expect(db.prepare("SELECT updated_at FROM execution_jobs").get()).toEqual({ updated_at: 21 }); db.close(); repo.close();
  });

  it("recovers each candidate in its own immediate transaction and releases the writer lock between leases", async () => {
    const setup = task3Fixture(); roots.push(setup.root);
    await setup.repo.createExecution(createInput(1)); await setup.repo.createExecution(createInput(2));
    await setup.repo.claimNextJob({ workerId: "w1", leaseDurationMs: 10 }); await setup.repo.claimNextJob({ workerId: "w2", leaseDurationMs: 10 });
    setup.clock.now = 21;
    const internal = (setup.repo as unknown as { db: Database.Database }).db;
    const originalTransaction = internal.transaction.bind(internal); const writer = new Database(setup.path); let immediateCount = 0; let interleaved = false;
    Object.defineProperty(internal, "transaction", { configurable: true, value: (fn: () => void) => {
      const transaction = originalTransaction(fn); const immediate = transaction.immediate.bind(transaction);
      const wrapped = (() => transaction()) as typeof transaction;
      Object.defineProperty(wrapped, "immediate", { value: () => {
        const value = immediate(); immediateCount += 1;
        if (immediateCount === 1) { writer.prepare("UPDATE execution_jobs SET priority = priority + 1 WHERE id = 'job-1'").run(); interleaved = true; }
        return value;
      } }); return wrapped;
    } });
    expect(await setup.repo.recoverExpiredLeases({ limit: 10 })).toEqual({ status: "recovered", recovered: 2, retried: 2, deadLettered: 0 });
    expect(immediateCount).toBe(2); expect(interleaved).toBe(true);
    Object.defineProperty(internal, "transaction", { configurable: true, value: originalTransaction }); writer.close(); setup.repo.close();
  });

  it("recovers a lease with a complete history beyond one public event page", async () => {
    const { repo, path, clock } = await claimed(); await seedLargeLeasedHistory(repo, path); clock.now = 2_000;
    expect(await repo.recoverExpiredLeases({ limit: 1 })).toEqual({ status: "recovered", recovered: 1, retried: 1, deadLettered: 0 });
    expect((await repo.getExecution("owner", "execution-1"))?.sequence).toBe(1_007);
    repo.close();
  });

  it("recovers a crashed lease once and dead-letters exactly once at exhaustion", async () => {
    const { repo, path, claim, clock } = await claimed(1); clock.now = 21;
    expect(await repo.recoverExpiredLeases({ limit: 10 })).toEqual({ status: "recovered", recovered: 1, retried: 0, deadLettered: 1 });
    clock.now = 30; expect(await repo.recoverExpiredLeases({ limit: 10 })).toEqual({ status: "recovered", recovered: 0, retried: 0, deadLettered: 0 });
    expect((await repo.heartbeat({ jobId: claim.jobId, attemptId: claim.attemptId, leaseToken: claim.leaseToken, leaseDurationMs: 10 })).status).toBe("lost");
    const db = new Database(path);
    expect(db.prepare("SELECT state, dead_lettered_at FROM execution_jobs").get()).toEqual({ state: "dead", dead_lettered_at: 21 });
    expect(db.prepare("SELECT count(*) AS count FROM execution_events WHERE type = 'execution.dead_lettered'").get()).toEqual({ count: 1 });
    db.close(); repo.close();
  });
});
