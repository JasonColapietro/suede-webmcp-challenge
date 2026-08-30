import { describe, expect, it } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import type { FlowGraph } from "@/lib/flow/types";
import { createModerationReport } from "@/lib/moderation/report-service";

const sampleGraph: FlowGraph = {
  id: "graph-1",
  name: "Sample",
  nodes: [{ id: "input", type: "input", params: {}, position: { x: 0, y: 0 } }],
  edges: [],
};

describe("createModerationReport", () => {
  it("resolves an owned run-output subject server-side", async () => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({ ownerId: "owner-1", name: "Sample", graph: sampleGraph });
    const run = await repo.createRun({ flowId: flow.id, trigger: "manual" });

    const result = await createModerationReport(repo, "owner-1", {
      subjectType: "run_output",
      flowId: flow.id,
      runId: run.id,
      nodeId: "input",
      reason: "other_unsafe_content",
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.report).toMatchObject({
      reporterOwnerId: "owner-1",
      subjectOwnerId: "owner-1",
      flowId: flow.id,
      runId: run.id,
      nodeId: "input",
      status: "open",
    });
  });

  it("does not let a reporter attach a report to another owner's flow", async () => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({ ownerId: "owner-1", name: "Sample", graph: sampleGraph });

    await expect(createModerationReport(repo, "owner-2", {
      subjectType: "run_output",
      flowId: flow.id,
      runId: "run-1",
      reason: "privacy_or_personal_data",
    })).resolves.toEqual({ status: "not-found" });
    expect(await repo.listModerationReports({ limit: 10 })).toEqual([]);
  });

  it("accepts reports only for live public agents and resolves their owner", async () => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({ ownerId: "publisher-1", name: "Sample", graph: sampleGraph });
    const draft = await repo.createAgent({
      flowId: flow.id,
      slug: "draft-agent",
      status: "draft",
      priceUsdc: 0,
    });
    expect((await createModerationReport(repo, "reporter-1", {
      subjectType: "agent",
      agentId: draft.id,
      reason: "deceptive_or_misleading",
    })).status).toBe("not-found");

    const live = await repo.createAgent({
      flowId: flow.id,
      slug: "live-agent",
      status: "live",
      priceUsdc: 0,
    });
    const result = await createModerationReport(repo, "reporter-1", {
      subjectType: "agent",
      agentId: live.id,
      reason: "deceptive_or_misleading",
    });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.report).toMatchObject({
      reporterOwnerId: "reporter-1",
      subjectOwnerId: "publisher-1",
      agentId: live.id,
      flowId: flow.id,
    });
  });
});
