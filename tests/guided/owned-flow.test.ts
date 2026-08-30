import { describe, expect, it } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import {
  EmptyGuidedFlowError,
  getGuidedFlowData,
  patchGuidedManifestOntoFlow,
  saveGuidedFlowManifest,
} from "@/lib/guided/flow";
import { flowToManifest } from "@/lib/manifest/from-flow";
import { manifestToFlow } from "@/lib/manifest/to-flow";
import type { AgentManifest } from "@/lib/manifest/schema";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

function manifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    manifestVersion: 1,
    name: "Owned employee",
    description: "Reviews one input and returns a bounded answer.",
    triggers: [{ kind: "paidCall", priceUsdc: 0.25 }],
    steps: [
      { id: "input", type: "input", config: {}, after: [] },
      { id: "answer", type: "llm", config: { prompt: "Review {{in}}" }, after: ["input"] },
      { id: "output", type: "output", config: {}, after: ["answer"] },
    ],
    meta: { createdBy: "guided" },
    ...overrides,
  };
}

describe("owned flow in Guided", () => {
  it("wires /start?flow to the owned loader and the same-row Guided client", () => {
    const pageSource = readFileSync("src/app/start/page.tsx", "utf8");
    const clientSource = readFileSync("src/app/start/guided-client.tsx", "utf8");
    expect(pageSource).toContain("getGuidedFlowData(flowParam, ownerId)");
    expect(pageSource).toContain("if (guidedFlow === null) notFound()");
    expect(pageSource).toContain("error instanceof EmptyGuidedFlowError");
    expect(pageSource).toContain('redirect("/start")');
    expect(pageSource).toContain('<ModeSwitch active="guided" flowId={guidedFlow?.flowId} />');
    expect(clientSource).toContain('action: "save"');
    expect(clientSource).toContain("flowId: initialFlow.flowId");
  });

  it("opens the owner row as the same manifest used by Studio and Code", async () => {
    const repo = new SqliteRepo(":memory:");
    const original = manifest();
    const flow = await repo.saveFlow({
      ownerId: "owner-guided",
      name: original.name,
      graph: manifestToFlow(original),
    });

    await expect(getGuidedFlowData(flow.id, "owner-guided", repo)).resolves.toEqual({
      flowId: flow.id,
      name: original.name,
      updatedAt: flow.updatedAt,
      manifest: original,
    });
  });

  it("refuses foreign and missing flow ids with the same private null result", async () => {
    const repo = new SqliteRepo(":memory:");
    const original = manifest();
    const flow = await repo.saveFlow({
      ownerId: "owner-guided",
      name: original.name,
      graph: manifestToFlow(original),
    });

    await expect(getGuidedFlowData(flow.id, "foreign-owner", repo)).resolves.toBeNull();
    await expect(getGuidedFlowData("missing-flow", "owner-guided", repo)).resolves.toBeNull();
  });

  it.each([
    {
      label: "empty",
      graph: { id: "empty-guided", name: "Empty Guided", nodes: [], edges: [] },
    },
    {
      label: "schedule-only",
      graph: {
        id: "schedule-only-guided",
        name: "Schedule-only Guided",
        nodes: [{
          id: "schedule",
          type: "schedule" as const,
          params: { cron: "0 9 * * *" },
          position: { x: 80, y: 120 },
        }],
        edges: [],
      },
    },
  ])("marks an owned $label V1 flow for bare Guided recovery", async ({ graph }) => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({
      ownerId: "owner-guided-empty",
      name: graph.name,
      graph,
    });

    await expect(getGuidedFlowData(flow.id, "owner-guided-empty", repo))
      .rejects.toBeInstanceOf(EmptyGuidedFlowError);
  });

  it("does not classify a malformed nonempty V1 graph as empty Guided recovery", async () => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({
      ownerId: "owner-guided-malformed",
      name: "Malformed schedule-only Guided",
      graph: {
        id: "malformed-schedule-only-guided",
        name: "Malformed schedule-only Guided",
        nodes: [{
          id: "schedule",
          type: "schedule",
          params: { cron: "not a cron" },
          position: { x: 80, y: 120 },
        }],
        edges: [],
      },
    });

    try {
      await getGuidedFlowData(flow.id, "owner-guided-malformed", repo);
      throw new Error("expected malformed graph to fail");
    } catch (error) {
      expect(error).not.toBeInstanceOf(EmptyGuidedFlowError);
      expect(String(error)).toContain("Invalid cron expression");
    }
  });

  it("saves Guided edits to the same flow row and keeps price and schedule exact", async () => {
    const repo = new SqliteRepo(":memory:");
    const original = manifest();
    const flow = await repo.saveFlow({
      ownerId: "owner-guided-save",
      name: original.name,
      graph: manifestToFlow(original),
    });
    const agent = await repo.createAgent({
      flowId: flow.id,
      slug: "owned-employee",
      status: "draft",
      priceUsdc: 0.25,
    });
    await repo.upsertSchedule({ agentId: agent.id, cron: "0 8 * * *", enabled: false });

    const updated = manifest({
      name: "Owned employee revised",
      triggers: [
        { kind: "paidCall", priceUsdc: 0.75 },
        { kind: "schedule", cron: "30 9 * * 1-5" },
      ],
    });
    const result = await saveGuidedFlowManifest(
      flow.id,
      "owner-guided-save",
      flow.updatedAt,
      updated,
      repo,
    );

    expect(result.status).toBe("saved");
    expect(await repo.listFlows("owner-guided-save")).toHaveLength(1);
    const reloaded = (await getGuidedFlowData(flow.id, "owner-guided-save", repo))?.manifest;
    expect(reloaded).toMatchObject({
      name: updated.name,
      description: updated.description,
      steps: updated.steps,
      meta: updated.meta,
    });
    expect(reloaded?.triggers).toHaveLength(2);
    expect(reloaded?.triggers).toEqual(expect.arrayContaining(updated.triggers));
    expect((await repo.getAgent(agent.id))?.priceUsdc).toBe(0.75);
    expect(await repo.listSchedulesByAgents([agent.id])).toEqual([
      expect.objectContaining({ cron: "30 9 * * 1-5", enabled: false }),
    ]);
  });

  it("refuses a foreign save without changing the owned row", async () => {
    const repo = new SqliteRepo(":memory:");
    const original = manifest();
    const flow = await repo.saveFlow({
      ownerId: "owner-guided-save",
      name: original.name,
      graph: manifestToFlow(original),
    });

    await expect(
      saveGuidedFlowManifest(
        flow.id,
        "foreign-owner",
        flow.updatedAt,
        manifest({ name: "Stolen" }),
        repo,
      ),
    ).resolves.toEqual({ status: "not-found" });
    expect((await repo.getOwnedFlow(flow.id, "owner-guided-save"))?.name).toBe(original.name);
  });

  it("round-trips a Studio graph without erasing identity, ports, layout, or unknown metadata", async () => {
    const repo = new SqliteRepo(":memory:");
    const original = manifest();
    const compiled = manifestToFlow(original);
    const studioGraph = {
      ...compiled,
      id: "studio-graph-identity",
      canvasRevision: "studio-canary",
      nodes: compiled.nodes.map((node, index) => ({
        ...node,
        position: { x: 101 + index * 73, y: 211 + index * 41 },
        selected: index === 1,
        studioMeta: { collapsed: index === 2 },
      })),
      edges: compiled.edges.map((edge, index) => ({
        ...edge,
        id: `studio-edge-${index}`,
        targetHandle: `studio-port-${index}`,
        selected: index === 0,
        studioMeta: { bend: index + 1 },
      })),
      meta: {
        ...compiled.meta,
        studioMeta: { zoom: 1.25, pane: "operations" },
      },
    };

    expect(patchGuidedManifestOntoFlow(studioGraph, flowToManifest(studioGraph)))
      .toEqual(studioGraph);

    const flow = await repo.saveFlow({
      ownerId: "owner-guided-lossless",
      name: original.name,
      graph: studioGraph,
    });
    const revised = manifest({
      description: "A founder-reviewed answer with exact Studio wiring.",
      triggers: [{ kind: "paidCall", priceUsdc: 0.55 }],
      steps: original.steps.map((step) => step.id === "answer"
        ? { ...step, config: { ...step.config, prompt: "Review carefully: {{in}}" } }
        : step),
    });

    const result = await saveGuidedFlowManifest(
      flow.id,
      "owner-guided-lossless",
      flow.updatedAt,
      revised,
      repo,
    );
    expect(result.status).toBe("saved");
    const persisted = await repo.getOwnedFlow(flow.id, "owner-guided-lossless");
    expect(persisted?.graph).toMatchObject({
      id: "studio-graph-identity",
      canvasRevision: "studio-canary",
      edges: studioGraph.edges,
      meta: {
        description: revised.description,
        studioMeta: { zoom: 1.25, pane: "operations" },
      },
    });
    expect(persisted?.graph.nodes.map((node) => ({
      position: node.position,
      selected: Reflect.get(node, "selected"),
      studioMeta: Reflect.get(node, "studioMeta"),
    }))).toEqual(studioGraph.nodes.map((node) => ({
      position: node.position,
      selected: node.selected,
      studioMeta: node.studioMeta,
    })));
    expect(persisted?.graph.nodes.find((node) => node.id === "answer")?.params)
      .toEqual({ prompt: "Review carefully: {{in}}" });
  });

  it("rejects a stale Guided save after Studio changes the same row", async () => {
    const repo = new SqliteRepo(":memory:");
    const original = manifest();
    const flow = await repo.saveFlow({
      ownerId: "owner-guided-stale",
      name: original.name,
      graph: manifestToFlow(original),
    });
    const opened = await getGuidedFlowData(flow.id, "owner-guided-stale", repo);
    expect(opened).not.toBeNull();

    const studioGraph = {
      ...flow.graph,
      meta: { ...flow.graph.meta, studioRevision: "newer-than-guided" },
    };
    const studioMutation = await repo.mutateFlow({
      id: flow.id,
      mustExist: true,
      expectedUpdatedAt: flow.updatedAt,
      ownerId: "owner-guided-stale",
      name: "Studio changed this",
      graph: studioGraph,
    });
    if (studioMutation.status !== "saved") throw new Error(`unexpected ${studioMutation.status}`);
    const studioSave = studioMutation.flow;
    expect(studioSave.updatedAt).toBeGreaterThan(flow.updatedAt);

    await expect(saveGuidedFlowManifest(
      flow.id,
      "owner-guided-stale",
      opened!.updatedAt,
      manifest({ name: "Stale Guided overwrite" }),
      repo,
    )).resolves.toEqual({ status: "conflict" });
    await expect(repo.getOwnedFlow(flow.id, "owner-guided-stale")).resolves.toMatchObject({
      name: "Studio changed this",
      graph: studioGraph,
      updatedAt: studioSave.updatedAt,
    });
  });

  it("does not let a stalled Guided save overwrite newer price or schedule sidecars", async () => {
    const repo = new SqliteRepo(":memory:");
    const original = manifest();
    const flow = await repo.saveFlow({
      ownerId: "owner-guided-sidecars",
      name: original.name,
      graph: manifestToFlow(original),
    });
    const agent = await repo.createAgent({
      flowId: flow.id,
      slug: "guided-sidecar-race",
      status: "draft",
      priceUsdc: 0.25,
    });
    await repo.upsertSchedule({ agentId: agent.id, cron: "0 8 * * *", enabled: true });

    const racedRepo = Object.create(repo) as SqliteRepo;
    racedRepo.mutateGuidedFlow = async (stalledInput) => {
      const newer = manifest({
        name: "Newer Studio revision",
        triggers: [
          { kind: "paidCall", priceUsdc: 9 },
          { kind: "schedule", cron: "15 12 * * *" },
        ],
      });
      const newerMutation = await repo.mutateGuidedFlow({
        ...stalledInput,
        name: newer.name,
        graph: manifestToFlow(newer),
        priceUsdc: 9,
        scheduleCron: "15 12 * * *",
      });
      if (newerMutation.status !== "saved") throw new Error(`unexpected ${newerMutation.status}`);
      return repo.mutateGuidedFlow(stalledInput);
    };

    const result = await saveGuidedFlowManifest(
      flow.id,
      "owner-guided-sidecars",
      flow.updatedAt,
      manifest({
        name: "Stalled Guided revision",
        triggers: [
          { kind: "paidCall", priceUsdc: 0.5 },
          { kind: "schedule", cron: "30 9 * * *" },
        ],
      }),
      racedRepo,
    );

    expect(result).toEqual({ status: "conflict" });
    expect((await repo.getFlow(flow.id))?.name).toBe("Newer Studio revision");
    expect((await repo.getAgent(agent.id))?.priceUsdc).toBe(9);
    expect(await repo.listSchedulesByAgents([agent.id])).toEqual([
      expect.objectContaining({ cron: "15 12 * * *", enabled: true }),
    ]);
  });

  it("rolls back graph, price, and schedule when any atomic Guided sidecar write fails", async () => {
    const repo = new SqliteRepo(":memory:");
    const db = Reflect.get(repo, "db") as Database.Database;
    const original = manifest();
    const flow = await repo.saveFlow({
      ownerId: "owner-guided-rollback",
      name: original.name,
      graph: manifestToFlow(original),
    });
    const agent = await repo.createAgent({
      flowId: flow.id,
      slug: "guided-rollback",
      status: "draft",
      priceUsdc: 0.25,
    });
    await repo.upsertSchedule({ agentId: agent.id, cron: "0 8 * * *", enabled: true });
    db.exec(`
      CREATE TRIGGER force_guided_schedule_failure
      BEFORE UPDATE OF cron ON schedules
      BEGIN
        SELECT RAISE(ABORT, 'forced schedule failure');
      END
    `);

    await expect(saveGuidedFlowManifest(
      flow.id,
      "owner-guided-rollback",
      flow.updatedAt,
      manifest({
        name: "Must roll back",
        triggers: [
          { kind: "paidCall", priceUsdc: 7 },
          { kind: "schedule", cron: "45 10 * * *" },
        ],
      }),
      repo,
    )).rejects.toThrow("forced schedule failure");

    expect(await repo.getFlow(flow.id)).toEqual(flow);
    expect((await repo.getAgent(agent.id))?.priceUsdc).toBe(0.25);
    expect(await repo.listSchedulesByAgents([agent.id])).toEqual([
      expect.objectContaining({ cron: "0 8 * * *", enabled: true }),
    ]);
  });
});
