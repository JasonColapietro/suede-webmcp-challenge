import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDurableRuntimeRepository } from "@/lib/runtime/sqlite-runtime-repo";
import { createInput, task3Fixture, TEST_KEY } from "./task3-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("durable SQLite job claim", () => {
  it("reads the trusted clock only after entering its immediate transaction", async () => {
    const setup = task3Fixture(); roots.push(setup.root); await setup.repo.createExecution(createInput(1)); setup.repo.close();
    const observations: boolean[] = []; const guarded: SqliteDurableRuntimeRepository = new SqliteDurableRuntimeRepository(setup.path, { idempotencyHashKey: TEST_KEY, clock: () => {
      observations.push((guarded as unknown as { db: Database.Database }).db.inTransaction); return 10;
    } });
    expect((await guarded.claimNextJob({ workerId: "worker", leaseDurationMs: 10 })).status).toBe("claimed");
    expect(observations).toEqual([true]); guarded.close();
  });

  it("claims by exact priority, availability, creation, and ID order and excludes future jobs", async () => {
    const setup = task3Fixture(); roots.push(setup.root);
    await setup.repo.createExecution(createInput(1, { priority: 2, availableAt: 10, createdAt: 1 }));
    await setup.repo.createExecution(createInput(2, { priority: 9, availableAt: 30, createdAt: 2 }));
    await setup.repo.createExecution(createInput(3, { priority: 9, availableAt: 10, createdAt: 3 }));
    await setup.repo.createExecution(createInput(4, { priority: 9, availableAt: 10, createdAt: 3 }));
    setup.clock.now = 20;
    const first = await setup.repo.claimNextJob({ workerId: "worker", leaseDurationMs: 50 });
    expect(first.status).toBe("claimed");
    if (first.status === "claimed") expect(first.claim.jobId).toBe("job-3");
    const second = await setup.repo.claimNextJob({ workerId: "worker", leaseDurationMs: 50 });
    if (second.status === "claimed") expect(second.claim.jobId).toBe("job-4");
    setup.repo.close();
  });

  it("uses independent connections for one winner and atomically creates attempt plus claim/start events", async () => {
    const setup = task3Fixture(); roots.push(setup.root); await setup.repo.createExecution(createInput(1));
    const other = new SqliteDurableRuntimeRepository(setup.path, { idempotencyHashKey: TEST_KEY, clock: () => setup.clock.now });
    const [left, right] = await Promise.all([
      setup.repo.claimNextJob({ workerId: "left", leaseDurationMs: 100 }),
      other.claimNextJob({ workerId: "right", leaseDurationMs: 100 }),
    ]);
    expect([left.status, right.status].sort()).toEqual(["claimed", "no-job"]);
    const winner = left.status === "claimed" ? left.claim : right.status === "claimed" ? right.claim : null;
    expect(winner).not.toBeNull();
    expect(Object.isFrozen(winner)).toBe(true);
    expect(Object.isFrozen(winner?.frozenDefinition)).toBe(true);
    const db = new Database(setup.path);
    expect(db.prepare("SELECT attempt_count, state FROM execution_jobs").get()).toEqual({ attempt_count: 1, state: "leased" });
    expect(db.prepare("SELECT attempt_number, state FROM execution_attempts").get()).toEqual({ attempt_number: 1, state: "leased" });
    expect(db.prepare("SELECT seq, type FROM execution_events ORDER BY seq").all()).toEqual([
      { seq: 1, type: "execution.created" }, { seq: 2, type: "job.enqueued" },
      { seq: 3, type: "job.claimed" }, { seq: 4, type: "attempt.started" },
    ]);
    db.close(); other.close(); setup.repo.close();
  });

  it("generates unique opaque fencing tokens and refuses hostile or unsafe claim bounds", async () => {
    const setup = task3Fixture(); roots.push(setup.root);
    await setup.repo.createExecution(createInput(1)); await setup.repo.createExecution(createInput(2));
    const first = await setup.repo.claimNextJob({ workerId: "worker", leaseDurationMs: 100 });
    const second = await setup.repo.claimNextJob({ workerId: "worker", leaseDurationMs: 100 });
    expect(first.status).toBe("claimed"); expect(second.status).toBe("claimed");
    if (first.status === "claimed" && second.status === "claimed") expect(first.claim.leaseToken).not.toBe(second.claim.leaseToken);
    expect((await setup.repo.claimNextJob({ workerId: "", leaseDurationMs: 100 })).status).toBe("refused");
    setup.clock.now = Number.MAX_SAFE_INTEGER;
    expect((await setup.repo.claimNextJob({ workerId: "w", leaseDurationMs: 1 })).status).toBe("refused");
    setup.repo.close();
  });
});
