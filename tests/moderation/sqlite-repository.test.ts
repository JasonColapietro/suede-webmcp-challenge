import { describe, expect, it } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";

describe("moderation SQLite repository", () => {
  it("persists a reviewable identifier-only report and audit update", async () => {
    const repo = new SqliteRepo(":memory:");
    const created = await repo.createModerationReport({
      reporterOwnerId: "reporter-1",
      subjectOwnerId: "owner-1",
      subjectType: "run_output",
      flowId: "flow-1",
      runId: "run-1",
      nodeId: "node-1",
      reason: "other_unsafe_content",
    });

    expect(created.status).toBe("open");
    expect(created).not.toHaveProperty("output");
    expect(created).not.toHaveProperty("prompt");
    expect(created).not.toHaveProperty("credentials");

    const queue = await repo.listModerationReports({ limit: 10 });
    expect(queue).toEqual([created]);

    const updated = await repo.updateModerationReport(created.id, {
      status: "resolved",
      reviewerNotes: "Reviewed against the authoritative run record.",
      reviewedBy: "reviewer@example.com",
    });
    expect(updated).toMatchObject({
      id: created.id,
      status: "resolved",
      reviewedBy: "reviewer@example.com",
      reviewerNotes: "Reviewed against the authoritative run record.",
    });
    expect(updated?.reviewedAt).toBeTruthy();
    expect(await repo.listModerationReports({ status: "open", limit: 10 })).toEqual([]);
    expect(await repo.listModerationReports({ status: "resolved", limit: 10 }))
      .toEqual([updated]);
  });

  it("has no columns capable of duplicating generated payloads or secrets", () => {
    const repo = new SqliteRepo(":memory:");
    const db = (repo as unknown as { db: import("better-sqlite3").Database }).db;
    const columns = (db.prepare("PRAGMA table_info(moderation_reports)").all() as Array<{
      name: string;
    }>).map((column) => column.name);

    expect(columns).not.toEqual(expect.arrayContaining([
      "output",
      "prompt",
      "payload",
      "credentials",
      "secret",
    ]));
  });

  it("enforces subject shape and identifier bounds at the database boundary", () => {
    const repo = new SqliteRepo(":memory:");
    const db = (repo as unknown as { db: import("better-sqlite3").Database }).db;
    const insert = db.prepare(`INSERT INTO moderation_reports (
      id, reporter_owner_id, subject_owner_id, subject_type,
      flow_id, run_id, node_id, agent_id, reason,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`);

    expect(() => insert.run(
      "report-1",
      "reporter-1",
      "owner-1",
      "run_output",
      "flow-1",
      null,
      null,
      null,
      "other_unsafe_content",
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:00:00.000Z",
    )).toThrow();
    expect(() => insert.run(
      "r".repeat(257),
      "reporter-1",
      "owner-1",
      "agent",
      "flow-1",
      null,
      null,
      "agent-1",
      "other_unsafe_content",
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:00:00.000Z",
    )).toThrow();
  });
});
