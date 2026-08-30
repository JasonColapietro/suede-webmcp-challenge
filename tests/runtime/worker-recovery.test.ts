import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { inputNode } from "@/lib/flow/nodes/input";
import { executeDurableAttempt, InjectedWorkerCrash, sanitizeDurableLog, type CrashSeam } from "@/lib/runtime/execute-attempt";
import { runWorkerTick } from "@/lib/runtime/worker";
import { task4bFixture } from "./task4b-fixture";
import type { DurableRuntimeRepository, LeasedTransitionResult } from "@/lib/runtime/repository";

const roots: string[] = [];
const ORIGINAL_INPUT_EXECUTOR = inputNode.executor;
afterEach(() => { inputNode.executor = ORIGINAL_INPUT_EXECUTOR; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("durable worker crash and control recovery", () => {
  it("truncates multibyte logs on a valid UTF-8 byte boundary", () => {
    const value = sanitizeDurableLog("💥".repeat(10_000));
    expect(Buffer.byteLength(value, "utf8")).toBe(16 * 1024);
    expect(value.endsWith("�")).toBe(false);
  });
  for (const seam of ["afterClaim", "afterLeasedEvent", "beforeFinalization"] as const satisfies readonly CrashSeam[]) {
    it(`lets ${seam} escape without failing or releasing the live lease`, async () => {
      const setup = await task4bFixture(); roots.push(setup.root);
      await expect(runWorkerTick({ repository: setup.repository, workerId: "worker", leaseDurationMs: 10, heartbeatIntervalMs: 2, crashAt: seam }))
        .rejects.toBeInstanceOf(InjectedWorkerCrash);
      const db = new Database(setup.path);
      expect(db.prepare("SELECT state,lease_token_hash IS NOT NULL AS fenced FROM execution_jobs").get()).toEqual({ state: "leased", fenced: 1 });
      expect(db.prepare("SELECT state,finished_at FROM execution_attempts").get()).toEqual({ state: "leased", finished_at: null });
      expect((db.prepare("SELECT count(*) AS n FROM execution_events WHERE type IN ('execution.failed','attempt.retry_scheduled','execution.dead_lettered')").get() as { n: number }).n).toBe(0);
      db.close(); setup.repository.close();
    });
  }

  it("recovers an expired crash once and fences the stale attempt", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    const claimed = await setup.repository.claimNextJob({ workerId: "old", leaseDurationMs: 10 });
    if (claimed.status !== "claimed") throw new Error("claim expected");
    await expect(executeDurableAttempt({ repository: setup.repository, claim: claimed.claim, signal: new AbortController().signal, crashAt: "afterLeasedEvent" })).rejects.toBeInstanceOf(InjectedWorkerCrash);
    setup.clock.now = 111;
    expect(await setup.repository.recoverExpiredLeases({ limit: 10 })).toEqual({ status: "recovered", recovered: 1, retried: 1, deadLettered: 0 });
    expect(await setup.repository.recoverExpiredLeases({ limit: 10 })).toEqual({ status: "recovered", recovered: 0, retried: 0, deadLettered: 0 });
    expect((await setup.repository.completeAttempt({ jobId: claimed.claim.jobId, attemptId: claimed.claim.attemptId, leaseToken: claimed.claim.leaseToken, output: {} })).status).toBe("lost");
    const db = new Database(setup.path); const available = (db.prepare("SELECT available_at FROM execution_jobs").get() as { available_at: number }).available_at; db.close();
    setup.clock.now = available;
    expect(await runWorkerTick({ repository: setup.repository, workerId: "new", leaseDurationMs: 100, heartbeatIntervalMs: 10 })).toEqual({ status: "completed", executionId: "execution" });
    setup.repository.close();
  });

  it("runs bounded expired-lease recovery before attempting a new claim", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    expect((await setup.repository.claimNextJob({ workerId: "old", leaseDurationMs: 10 })).status).toBe("claimed");
    setup.clock.now = 111;
    expect(await runWorkerTick({ repository: setup.repository, workerId: "new", leaseDurationMs: 100, heartbeatIntervalMs: 10, recoveryLimit: 1 })).toEqual({ status: "idle" });
    const db = new Database(setup.path);
    expect(db.prepare("SELECT state FROM execution_jobs").get()).toEqual({ state: "retry" });
    expect(db.prepare("SELECT state FROM execution_attempts").get()).toEqual({ state: "lost" });
    db.close(); setup.repository.close();
  });

  for (const action of ["pause", "cancel"] as const) {
    it(`does not claim a ready job with a pre-claim ${action} request`, async () => {
      const setup = await task4bFixture(); roots.push(setup.root);
      expect((await setup.repository.controlExecution("owner", "execution", action)).status).toBe("applied");
      expect(await runWorkerTick({ repository: setup.repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 10 })).toEqual({ status: "idle" });
      const db = new Database(setup.path);
      expect(db.prepare("SELECT attempt_count,state FROM execution_jobs").get()).toEqual({ attempt_count: 0, state: action === "pause" ? "retry" : "cancelled" });
      expect(db.prepare("SELECT state FROM durable_executions").get()).toEqual({ state: action === "pause" ? "paused" : "cancelled" });
      expect(db.prepare("SELECT type FROM execution_events ORDER BY seq DESC LIMIT 2").all()).toEqual([{ type: action === "pause" ? "execution.paused" : "execution.cancelled" }, { type: "control.requested" }]);
      db.close(); setup.repository.close();
    });

    it(`recovers an expired ${action} request without retry/dead-letter fiction`, async () => {
      const setup = await task4bFixture(); roots.push(setup.root);
      const claim = await setup.repository.claimNextJob({ workerId: "worker", leaseDurationMs: 10 });
      if (claim.status !== "claimed") throw new Error("claim expected");
      setup.clock.now = 101; expect((await setup.repository.controlExecution("owner", "execution", action)).status).toBe("applied"); setup.clock.now = 111;
      expect(await setup.repository.recoverExpiredLeases({ limit: 10 })).toEqual({ status: "recovered", recovered: 1, retried: 0, deadLettered: 0 });
      const db = new Database(setup.path);
      expect(db.prepare("SELECT state FROM durable_executions").get()).toEqual({ state: action === "pause" ? "paused" : "cancelled" });
      expect(db.prepare("SELECT state FROM execution_attempts").get()).toEqual({ state: action === "pause" ? "lost" : "cancelled" });
      expect((db.prepare("SELECT count(*) AS n FROM execution_events WHERE type IN ('attempt.retry_scheduled','execution.dead_lettered')").get() as { n: number }).n).toBe(0);
      db.close(); setup.repository.close();
    });
  }

  it("enforces a due deadline through the injected clock and retry classification", async () => {
    const setup = await task4bFixture({ deadlineAt: 100 }); roots.push(setup.root);
    expect(await runWorkerTick({ repository: setup.repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 10, now: () => 100 }))
      .toEqual({ status: "retry-scheduled", executionId: "execution" });
    const db = new Database(setup.path);
    expect(db.prepare("SELECT type FROM execution_events ORDER BY seq DESC LIMIT 1").get()).toEqual({ type: "attempt.retry_scheduled" });
    db.close(); setup.repository.close();
  });

  it("retains the lease on graceful shutdown and never closes over an active heartbeat", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const repository = new Proxy(setup.repository, { get(target, key) {
      if (key === "appendLeasedEvent") return async (value: any) => {
        const result = await target.appendLeasedEvent(value);
        if (value.event.type === "node.started") { entered(); await gate; }
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } }) as DurableRuntimeRepository;
    const controller = new AbortController();
    const tick = runWorkerTick({ repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 5, signal: controller.signal });
    await started; controller.abort(new Error("shutdown")); release();
    expect(await tick).toEqual({ status: "stopped", executionId: "execution" });
    const db = new Database(setup.path);
    expect(db.prepare("SELECT state,lease_token_hash IS NOT NULL AS fenced FROM execution_jobs").get()).toEqual({ state: "leased", fenced: 1 });
    db.close(); setup.repository.close();
  });

  for (const status of ["conflict", "lost", "refused"] as const) {
    it(`stops without finalization when leased append returns ${status}`, async () => {
      const setup = await task4bFixture(); roots.push(setup.root);
      const claim = await setup.repository.claimNextJob({ workerId: "worker", leaseDurationMs: 100 });
      if (claim.status !== "claimed") throw new Error("claim expected");
      const repository = new Proxy(setup.repository, { get(target, key) {
        if (key === "appendLeasedEvent") return async (): Promise<LeasedTransitionResult> => ({ status });
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } }) as DurableRuntimeRepository;
      expect(await executeDurableAttempt({ repository, claim: claim.claim, signal: new AbortController().signal })).toEqual({ status: "lost" });
      const db = new Database(setup.path); expect(db.prepare("SELECT state FROM execution_jobs").get()).toEqual({ state: "leased" }); db.close();
      setup.repository.close();
    });
  }

  it("classifies safe-node failure transient and bounded-output violation as policy", async () => {
    for (const policy of [false, true]) {
      const graph = policy ? undefined : { id: "root", name: "root", nodes: [{ id: "transform", type: "transform" as const, params: { expression: "secret_value(" }, position: { x: 0, y: 0 } }], edges: [] };
      const setup = await task4bFixture({ graph, ...(policy ? { triggerInput: { a: "x".repeat(50 * 1024), b: "x".repeat(50 * 1024), c: "x".repeat(50 * 1024) } } : {}) }); roots.push(setup.root);
      const classifications: string[] = [];
      const repository = new Proxy(setup.repository, { get(target, key) {
        if (key === "failAttempt") return async (value: any) => { classifications.push(value.classification); return target.failAttempt(value); };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } }) as DurableRuntimeRepository;
      const result = await runWorkerTick({ repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 10 });
      expect(classifications).toEqual([policy ? "policy" : "transient"]);
      expect(result.status).toBe(policy ? "failed" : "retry-scheduled");
      setup.repository.close();
    }
  });

  it("bounds hostile executor errors before event persistence", async () => {
    const secret = "sk_live_DO_NOT_PERSIST";
    const graph = { id: "root", name: "root", nodes: [{ id: "transform", type: "transform" as const, params: { expression: `${secret}(` }, position: { x: 0, y: 0 } }], edges: [] };
    const setup = await task4bFixture({ graph }); roots.push(setup.root);
    expect((await runWorkerTick({ repository: setup.repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 10 })).status).toBe("retry-scheduled");
    const db = new Database(setup.path);
    const payload = JSON.parse((db.prepare("SELECT payload_json FROM execution_events WHERE type='node.failed'").get() as { payload_json: string }).payload_json);
    expect(Buffer.byteLength(payload.error, "utf8")).toBeLessThanOrEqual(8_192);
    expect(JSON.stringify(db.prepare("SELECT payload_json FROM execution_events").all())).not.toContain(secret);
    db.close(); setup.repository.close();
  });

  it("fails stable policy before dispatch when an admitted executor identity drifts", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    let calls = 0;
    inputNode.executor = async () => { calls += 1; return { ok: true, outputs: {}, costUsdc: 0 }; };
    const originalFetch = globalThis.fetch; let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("network must not run"); }) as typeof fetch;
    try {
      expect((await runWorkerTick({ repository: setup.repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 10 })).status).toBe("failed");
    } finally { globalThis.fetch = originalFetch; }
    expect(calls).toBe(0); expect(fetchCalls).toBe(0);
    const db = new Database(setup.path);
    expect(db.prepare("SELECT type,payload_json FROM execution_events ORDER BY seq DESC LIMIT 1").get()).toEqual({ type: "execution.failed", payload_json: '{"costMicroUsdc":0,"error":"durable_policy_refused","tokens":0}' });
    expect(db.prepare("SELECT count(*) AS count FROM execution_events WHERE type LIKE 'node.%'").get()).toEqual({ count: 0 });
    db.close(); setup.repository.close();
  });

  for (const action of ["pause", "cancel"] as const) {
    it(`cooperatively ${action}s during a running node without a stale finalization`, async () => {
      const setup = await task4bFixture(); roots.push(setup.root);
      let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
      const repository = new Proxy(setup.repository, { get(target, key) {
        if (key === "appendLeasedEvent") return async (value: any) => {
          const result = await target.appendLeasedEvent(value);
          if (value.event.type === "node.started") { entered(); await gate; }
          return result;
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } }) as DurableRuntimeRepository;
      const tick = runWorkerTick({ repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 5 });
      await started; setup.clock.now = 101; expect((await setup.repository.controlExecution("owner", "execution", action)).status).toBe("applied");
      release();
      expect((await tick).status).toBe(action === "pause" ? "paused" : "cancelled");
      const db = new Database(setup.path);
      expect(db.prepare("SELECT state FROM durable_executions").get()).toEqual({ state: action === "pause" ? "paused" : "cancelled" });
      expect((db.prepare("SELECT count(*) AS n FROM execution_events WHERE type IN ('execution.succeeded','execution.failed','attempt.retry_scheduled')").get() as { n: number }).n).toBe(0);
      db.close(); setup.repository.close();
    });
  }

  it("waits an in-flight heartbeat before returning and performs no post-return writes", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    let secondStarted!: () => void; const second = new Promise<void>((resolve) => { secondStarted = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const repository = new Proxy(setup.repository, { get(target, key) {
      if (key === "heartbeat") return async (value: any) => {
        calls += 1; if (calls === 2) { secondStarted(); await gate; } return target.heartbeat(value);
      };
      if (key === "appendLeasedEvent") return async (value: any) => { const result = await target.appendLeasedEvent(value); if (value.event.type === "node.started") await second; return result; };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } }) as DurableRuntimeRepository;
    let settled = false;
    const tick = runWorkerTick({ repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 2 }).finally(() => { settled = true; });
    await second; await new Promise((resolve) => setTimeout(resolve, 5)); expect(settled).toBe(false);
    release(); expect((await tick).status).toBe("completed");
    const atReturn = calls; await new Promise((resolve) => setTimeout(resolve, 8)); expect(calls).toBe(atReturn);
    setup.repository.close();
  });

  it("aborts a node when a deadline becomes due during execution", async () => {
    const setup = await task4bFixture({ deadlineAt: 120 }); roots.push(setup.root);
    const repository = new Proxy(setup.repository, { get(target, key) {
      if (key === "appendLeasedEvent") return async (value: any) => { const result = await target.appendLeasedEvent(value); if (value.event.type === "node.started") await new Promise((resolve) => setTimeout(resolve, 30)); return result; };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } }) as DurableRuntimeRepository;
    const base = Date.now();
    expect((await runWorkerTick({ repository, workerId: "worker", leaseDurationMs: 100, heartbeatIntervalMs: 5, now: () => 100 + (Date.now() - base) })).status).toBe("retry-scheduled");
    setup.repository.close();
  });
});
