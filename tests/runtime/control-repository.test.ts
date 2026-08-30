import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDurableRuntimeRepository } from "@/lib/runtime/sqlite-runtime-repo";
import { task4bFixture } from "./task4b-fixture";
import { TEST_KEY } from "./task3-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("owner-scoped durable repository controls", () => {
  it("parks, idempotently repeats, resumes, and re-enables a ready job atomically", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    expect((await setup.repository.controlExecution("owner", "execution", "resume")).status).toBe("conflict");
    const paused = await setup.repository.controlExecution("owner", "execution", "pause");
    expect(paused.status).toBe("applied");
    const sequence = paused.status === "applied" ? paused.execution.sequence : 0;
    const repeated = await setup.repository.controlExecution("owner", "execution", "pause");
    expect(repeated.status).toBe("idempotent");
    if (repeated.status === "idempotent") expect(repeated.execution.sequence).toBe(sequence);
    expect(await setup.repository.claimNextJob({ workerId: "blocked", leaseDurationMs: 10 })).toEqual({ status: "no-job" });
    const resumed = await setup.repository.controlExecution("owner", "execution", "resume");
    expect(resumed.status).toBe("applied");
    expect((await setup.repository.controlExecution("owner", "execution", "resume")).status).toBe("idempotent");
    expect((await setup.repository.claimNextJob({ workerId: "worker", leaseDurationMs: 10 })).status).toBe("claimed");
    const db = new Database(setup.path);
    expect(db.prepare("SELECT type FROM execution_events WHERE type LIKE 'control.%' OR type LIKE 'execution.pause%' OR type LIKE 'execution.resume%' ORDER BY seq").all())
      .toEqual([{ type: "control.requested" }, { type: "execution.paused" }, { type: "control.requested" }, { type: "execution.resumed" }]);
    db.close(); setup.repository.close();
  });

  it("cancels a ready job with zero attempts/retries/dead letters and repeats without an event bump", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    const cancelled = await setup.repository.controlExecution("owner", "execution", "cancel");
    expect(cancelled.status).toBe("applied");
    const sequence = cancelled.status === "applied" ? cancelled.execution.sequence : 0;
    const repeat = await setup.repository.controlExecution("owner", "execution", "cancel");
    expect(repeat.status).toBe("idempotent");
    if (repeat.status === "idempotent") expect(repeat.execution.sequence).toBe(sequence);
    expect(await setup.repository.claimNextJob({ workerId: "worker", leaseDurationMs: 10 })).toEqual({ status: "no-job" });
    const db = new Database(setup.path);
    expect(db.prepare("SELECT state,attempt_count,dead_lettered_at,last_error FROM execution_jobs").get()).toEqual({ state: "cancelled", attempt_count: 0, dead_lettered_at: null, last_error: null });
    expect(db.prepare("SELECT count(*) AS count FROM execution_attempts").get()).toEqual({ count: 0 });
    db.close(); setup.repository.close();
  });

  it("keeps leased control cooperative and owner-private", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    const claim = await setup.repository.claimNextJob({ workerId: "worker", leaseDurationMs: 100 });
    if (claim.status !== "claimed") throw new Error("claim expected");
    expect(await setup.repository.controlExecution("foreign", "execution", "pause")).toEqual({ status: "not-found" });
    expect((await setup.repository.controlExecution("owner", "execution", "pause")).status).toBe("applied");
    const db = new Database(setup.path);
    expect(db.prepare("SELECT state FROM execution_jobs").get()).toEqual({ state: "leased" });
    expect(db.prepare("SELECT type FROM execution_events ORDER BY seq DESC LIMIT 1").get()).toEqual({ type: "control.requested" });
    db.close(); setup.repository.close();
  });

  it("serializes identical and competing controls across independent connections", async () => {
    const setup = await task4bFixture(); roots.push(setup.root);
    const other = new SqliteDurableRuntimeRepository(setup.path, { idempotencyHashKey: TEST_KEY, clock: () => setup.clock.now });
    const same = await Promise.all([
      setup.repository.controlExecution("owner", "execution", "pause"),
      other.controlExecution("owner", "execution", "pause"),
    ]);
    expect(same.map((entry) => entry.status).sort()).toEqual(["applied", "idempotent"]);
    const competing = await Promise.all([
      setup.repository.controlExecution("owner", "execution", "cancel"),
      other.controlExecution("owner", "execution", "resume"),
    ]);
    expect(competing.some((entry) => entry.status === "applied")).toBe(true);
    expect((await setup.repository.getExecution("owner", "execution"))?.state).toMatch(/queued|cancelled/);
    other.close(); setup.repository.close();
  });
});
