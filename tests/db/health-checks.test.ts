/**
 * Tests for the health surface: the health_checks ledger (recordHealthCheck /
 * getHealthUptime), the launched-agent run aggregate (getRunOutcomeStats), the
 * datastore ping, and the pure status/availability rules in src/lib/health.ts.
 *
 * The design contract these lock in:
 * - Availability is computed live from recorded counts, never a stored value.
 * - A percentage is withheld until a window has enough samples.
 * - Run stats are scoped to launched agents (agent_id IS NOT NULL) — editor
 *   previews are excluded — and reported as throughput, not a success rate.
 */
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { availabilityPct, deriveHealthStatus } from "@/lib/health";

function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

function rawDb(repo: SqliteRepo): Database.Database {
  return (repo as unknown as { db: Database.Database }).db;
}

const okProbe = { ok: true, latencyMs: 5 };
const downProbe = { ok: false, latencyMs: 5 };

describe("deriveHealthStatus", () => {
  it("is ok only when every dependency is ok", () => {
    expect(deriveHealthStatus(okProbe, okProbe, okProbe)).toBe("ok");
  });

  it("is down when the core datastore is down, regardless of the others", () => {
    expect(deriveHealthStatus(downProbe, okProbe, okProbe)).toBe("down");
    expect(deriveHealthStatus(downProbe, downProbe, downProbe)).toBe("down");
  });

  it("is degraded when a non-core dependency is down but the datastore is up", () => {
    expect(deriveHealthStatus(okProbe, downProbe, okProbe)).toBe("degraded");
    expect(deriveHealthStatus(okProbe, okProbe, downProbe)).toBe("degraded");
  });
});

describe("availabilityPct", () => {
  it("withholds a percentage below the sample threshold", () => {
    expect(availabilityPct(5, 0, 120)).toBeNull();
    expect(availabilityPct(0, 0, 1)).toBeNull();
  });

  it("computes the not-down share, rounded to one decimal, once the threshold is met", () => {
    expect(availabilityPct(1000, 1, 120)).toBe(99.9);
    expect(availabilityPct(200, 0, 120)).toBe(100);
    expect(availabilityPct(4, 1, 1)).toBe(75);
  });
});

describe("SqliteRepo health checks", () => {
  it("pings without throwing", async () => {
    const repo = makeRepo();
    await expect(repo.ping()).resolves.toBeUndefined();
  });

  it("records checks and reads back window counts, bounds, and average latencies", async () => {
    const repo = makeRepo();
    await repo.recordHealthCheck({
      status: "ok",
      dbOk: true,
      dbLatencyMs: 10,
      gatewayOk: true,
      gatewayLatencyMs: 20,
      facilitatorOk: true,
      facilitatorLatencyMs: 30,
    });
    await repo.recordHealthCheck({
      status: "ok",
      dbOk: true,
      dbLatencyMs: 30,
      gatewayOk: true,
      gatewayLatencyMs: 40,
      facilitatorOk: true,
      facilitatorLatencyMs: 50,
    });
    await repo.recordHealthCheck({
      status: "degraded",
      dbOk: true,
      dbLatencyMs: 20,
      gatewayOk: false,
      gatewayLatencyMs: 60,
      facilitatorOk: true,
      facilitatorLatencyMs: 70,
    });
    await repo.recordHealthCheck({
      status: "down",
      dbOk: false,
      dbLatencyMs: 40,
      gatewayOk: true,
      gatewayLatencyMs: 80,
      facilitatorOk: true,
      facilitatorLatencyMs: 90,
    });

    const stats = await repo.getHealthUptime(0);
    expect(stats.total).toBe(4);
    expect(stats.ok).toBe(2);
    expect(stats.degraded).toBe(1);
    expect(stats.down).toBe(1);
    expect(stats.firstAt).toBeTruthy();
    expect(stats.lastAt).toBeTruthy();
    expect(stats.avgDbLatencyMs).toBe(25); // (10+30+20+40)/4
    expect(stats.avgGatewayLatencyMs).toBe(50); // (20+40+60+80)/4
    expect(stats.avgFacilitatorLatencyMs).toBe(60); // (30+50+70+90)/4

    // Availability = not-down share, computed from these live counts.
    expect(availabilityPct(stats.total, stats.down, 1)).toBe(75);
  });

  it("excludes checks recorded before the window bound", async () => {
    const repo = makeRepo();
    await repo.recordHealthCheck({
      status: "ok",
      dbOk: true,
      dbLatencyMs: 1,
      gatewayOk: true,
      gatewayLatencyMs: 1,
      facilitatorOk: true,
      facilitatorLatencyMs: 1,
    });
    // A future window bound excludes the just-recorded check.
    const stats = await repo.getHealthUptime(Date.now() + 60_000);
    expect(stats.total).toBe(0);
    expect(stats.firstAt).toBeNull();
  });

  it("returns zeroed stats when the health_checks table is absent (dark-deploy safe)", async () => {
    const repo = makeRepo();
    rawDb(repo).exec("DROP TABLE health_checks");
    // recordHealthCheck swallows the write; getHealthUptime returns zeros.
    await expect(
      repo.recordHealthCheck({
        status: "ok",
        dbOk: true,
        dbLatencyMs: 1,
        gatewayOk: true,
        gatewayLatencyMs: 1,
        facilitatorOk: true,
        facilitatorLatencyMs: 1,
      }),
    ).resolves.toBeUndefined();
    const stats = await repo.getHealthUptime(0);
    expect(stats.total).toBe(0);
    expect(stats.down).toBe(0);
  });
});

describe("SqliteRepo getRunOutcomeStats", () => {
  it("aggregates launched-agent runs only, with median completed duration and distinct agents", async () => {
    const repo = makeRepo();
    const flow = await repo.saveFlow({
      ownerId: "owner-1",
      name: "Outcome Flow",
      graph: { id: "g-outcome", name: "test", nodes: [], edges: [] },
    });
    const now = Date.now();
    const insert = rawDb(repo).prepare(
      `INSERT INTO runs (id, flow_id, agent_id, trigger, status, total_cost_usdc, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    // Launched-agent runs (agent_id set): 3 done, 1 error, 1 running.
    insert.run("r-a", flow.id, "agent-1", "agent", "done", now - 1000, now - 900); // dur 100
    insert.run("r-b", flow.id, "agent-1", "agent", "done", now - 1000, now - 800); // dur 200
    insert.run("r-c", flow.id, "agent-2", "agent", "done", now - 1000, now - 700); // dur 300
    insert.run("r-d", flow.id, "agent-2", "agent", "error", now - 1000, now - 500); // dur 500
    insert.run("r-e", flow.id, "agent-1", "agent", "running", now - 100, null); // no duration
    // Editor-preview run (agent_id NULL) — must be excluded entirely.
    insert.run("r-f", flow.id, null, "manual", "done", now - 1000, now - 600);

    const stats = await repo.getRunOutcomeStats(now - 5000);
    expect(stats.total).toBe(5);
    expect(stats.done).toBe(3);
    expect(stats.error).toBe(1);
    expect(stats.running).toBe(1);
    expect(stats.agentsLive).toBe(2);
    // Durations of finished launched runs: [100, 200, 300, 500] -> median 250.
    expect(stats.medianDurationMs).toBe(250);
  });

  it("returns a null median and zero counts when no launched runs fall in the window", async () => {
    const repo = makeRepo();
    const stats = await repo.getRunOutcomeStats(Date.now());
    expect(stats.total).toBe(0);
    expect(stats.medianDurationMs).toBeNull();
    expect(stats.agentsLive).toBe(0);
  });
});
