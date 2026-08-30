import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FlowGraph, FlowGraphV2, SupportedFlowGraph } from "@/lib/flow/types";
import { FlowSaveCoordinator } from "@/lib/flow/save-queue";
import type {
  FlowVersionRecord,
  FlowVersionSummary,
  PersonalContext,
} from "@/lib/projects/types";

async function loadUiModel() {
  try {
    return await import("@/lib/projects/ui-model");
  } catch {
    return null;
  }
}

function context(): PersonalContext {
  return {
    organization: {
      id: "organization",
      personalOwnerId: "owner",
      name: "Personal",
      kind: "personal",
      createdAt: 1,
    },
    workspace: {
      id: "workspace",
      organizationId: "organization",
      name: "Personal",
      slug: "personal",
      createdAt: 1,
    },
    project: {
      id: "project",
      workspaceId: "workspace",
      name: "My Project",
      slug: "my-project",
      createdAt: 1,
      updatedAt: 1,
    },
    workbook: {
      id: "workbook",
      projectId: "project",
      name: "Main",
      slug: "main",
      position: 0,
      createdAt: 1,
    },
    environments: [],
  };
}

function summary(versionNumber: number): FlowVersionSummary {
  return {
    id: `version-${versionNumber}`,
    flowId: "row-authoritative",
    versionNumber,
    schemaVersion: 1,
    semanticHash: `semantic-${versionNumber}`,
    fullHash: `full-${versionNumber}`,
    createdBy: "owner",
    createdAt: versionNumber,
    dependencyCount: versionNumber,
  };
}

function version(overrides: Partial<FlowVersionRecord> = {}): FlowVersionRecord {
  return {
    id: "version-2",
    flowId: "row-authoritative",
    versionNumber: 2,
    schemaVersion: 1,
    graph: {
      id: "graph-not-the-row-id",
      name: "Checkpoint",
      nodes: [],
      edges: [],
    },
    semanticHash: "semantic-hash",
    fullHash: "full-hash",
    createdBy: "owner",
    createdAt: 2,
    dependencies: [],
    ...overrides,
  };
}

describe("project and version UI view models", () => {
  it("exposes the client-safe UI model surface", async () => {
    expect(await loadUiModel()).not.toBeNull();
  });

  it("formats compact personal context with exact version plurals", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    expect(ui.formatProjectContext(context(), 0)).toBe("My Project / Main · 0 versions");
    expect(ui.formatProjectContext(context(), 1)).toBe("My Project / Main · 1 version");
    expect(ui.formatProjectContext(context(), 3)).toBe("My Project / Main · 3 versions");
  });

  it("models restrained project context loading, ready, and error announcements", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    expect(
      ui.projectContextView({ context: null, versionCount: 0, loading: true, error: null }),
    ).toEqual({ text: "Loading project context…", busy: true });
    expect(
      ui.projectContextView({ context: context(), versionCount: 3, loading: false, error: null }),
    ).toEqual({ text: "My Project / Main · 3 versions", busy: false });
    expect(
      ui.projectContextView({
        context: null,
        versionCount: 0,
        loading: false,
        error: "Project metadata unavailable.",
      }),
    ).toEqual({ text: "Project metadata unavailable.", busy: false });
  });

  it("orders the immutable ledger by real version sequence", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const model = ui.versionPanelView(
      { status: "ready", versions: [summary(1), summary(3), summary(2)] },
      { readOnly: false, saving: false, canSave: true },
    );
    expect(model.items.map(({ versionNumber }) => versionNumber)).toEqual([3, 2, 1]);
    expect(model.countLabel).toBe("3 versions");
    expect(model.showSave).toBe(true);
    expect(model.saveDisabled).toBe(false);
  });

  it("covers loading, empty, error/retry, saving, and dedupe announcements", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    expect(
      ui.versionPanelView(
        { status: "loading" },
        { readOnly: false, saving: false, canSave: false },
      ),
    ).toMatchObject({ message: "Loading version history…", busy: true });
    expect(
      ui.versionPanelView(
        { status: "ready", versions: [] },
        { readOnly: false, saving: false, canSave: true },
      ),
    ).toMatchObject({ message: "No versions yet. Save this draft when you want a checkpoint." });
    expect(
      ui.versionPanelView(
        { status: "error", message: "Version history unavailable." },
        { readOnly: false, saving: false, canSave: true },
      ),
    ).toMatchObject({ message: "Version history unavailable.", canRetry: true });
    expect(
      ui.versionPanelView(
        { status: "ready", versions: [summary(2)] },
        { readOnly: false, saving: true, canSave: true },
      ),
    ).toMatchObject({ announcement: "Saving version…", saveDisabled: true });
    expect(ui.saveAnnouncement({ kind: "deduped", version: version() })).toBe(
      "Already saved as v2.",
    );
    expect(ui.saveAnnouncement({ kind: "created", version: version() })).toBe(
      "Saved version v2.",
    );
  });

  it("makes mobile history read-only and removes the save action", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    expect(
      ui.versionPanelView(
        { status: "ready", versions: [summary(1)] },
        { readOnly: true, saving: false, canSave: true },
      ),
    ).toMatchObject({ readOnly: true, showSave: false, saveDisabled: true });
  });

  it("derives honest Draft, Test, and Live receipts without treating Draft as a deployment", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const versions = [summary(7), summary(4)];
    const rail = ui.environmentRailView({
      versions,
      deployments: [
        { id: "dep-test", flowId: "flow-1", flowVersionId: versions[1]!.id, environmentId: "env-test", status: "test", createdAt: 1 },
      ],
      environments: [
        { id: "env-draft", projectId: "project", name: "Draft", slug: "draft", kind: "draft", createdAt: 1 },
        { id: "env-test", projectId: "project", name: "Test", slug: "test", kind: "test", createdAt: 1 },
        { id: "env-live", projectId: "project", name: "Live", slug: "live", kind: "live", createdAt: 1 },
      ],
    });
    expect(rail).toEqual([
      { kind: "draft", detail: "Mutable workspace" },
      { kind: "test", detail: "v4" },
      { kind: "live", detail: "Not promoted" },
    ]);
    expect(ui.environmentRailView({
      versions: [versions[0]!],
      deployments: [
        { id: "dep-test", flowId: "flow-1", flowVersionId: "version-missing", environmentId: "env-test", status: "test", createdAt: 1 },
      ],
      environments: [
        { id: "env-test", projectId: "project", name: "Test", slug: "test", kind: "test", createdAt: 1 },
      ],
    })[1]).toEqual({ kind: "test", detail: "Version unavailable" });
  });

  it("strictly parses bounded deployment history and rejects raw or extra server fields", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const deployment = { id: "dep", flowId: "flow", flowVersionId: "version", environmentId: "env", status: "test", createdAt: 1 };
    const target = { flowId: "flow", testEnvironmentId: "env", liveEnvironmentId: "env-live" };
    expect(ui.parseDeploymentsEnvelope({ deployments: [deployment] }, target)).toEqual([deployment]);
    expect(ui.parseDeploymentsEnvelope({ deployments: [{ ...deployment, secret: "raw" }] }, target)).toBeNull();
    expect(ui.parseDeploymentsEnvelope({ deployments: [{ ...deployment, retiredAt: 2 }] }, target)).toBeNull();
    expect(ui.parseDeploymentsEnvelope({ deployments: [{ ...deployment, status: "retired" }] }, target)).toBeNull();
    expect(ui.parseDeploymentsEnvelope({ deployments: [{ ...deployment, status: "draft" }] }, target)).toBeNull();
    expect(ui.parseDeploymentsEnvelope({ deployments: [{ ...deployment, flowId: "other" }] }, target)).toBeNull();
    expect(ui.parseDeploymentsEnvelope({ deployments: [{ ...deployment, environmentId: "env-live" }] }, target)).toBeNull();
    expect(ui.parseDeploymentsEnvelope({ deployments: [deployment, { ...deployment, id: "dep-2" }] }, target)).toBeNull();
    expect(ui.parseDeploymentsEnvelope({ deployments: Array.from({ length: 201 }, () => deployment) }, target)).toBeNull();
  });

  it("identity-binds both diff endpoints to the selected record and captured latest summary", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const selectedSummary = { ...summary(4), semanticHash: "a".repeat(64) };
    const latestSummary = { ...summary(7), semanticHash: "c".repeat(64) };
    const selectedRecord = version({
      id: selectedSummary.id,
      flowId: selectedSummary.flowId,
      versionNumber: selectedSummary.versionNumber,
      semanticHash: selectedSummary.semanticHash,
      fullHash: selectedSummary.fullHash,
    });
    const exactDiff = {
      from: { id: selectedSummary.id, versionNumber: 4, semanticHash: selectedSummary.semanticHash },
      to: { id: latestSummary.id, versionNumber: 7, semanticHash: latestSummary.semanticHash },
      semanticEqual: true, fullEqual: true, visualOnly: false, changedSections: [],
      counts: { added: 0, removed: 0, changed: 0 }, entries: [], truncated: false,
    };
    expect(ui.versionReviewEnvelopeMatches({ selectedRecord, selectedSummary, latestSummary, diff: exactDiff })).toBe(true);
    expect(ui.versionReviewEnvelopeMatches({
      selectedRecord: { ...selectedRecord, fullHash: "f".repeat(64) },
      selectedSummary,
      latestSummary,
      diff: exactDiff,
    })).toBe(false);
    for (const poisoned of [
      { ...exactDiff, from: { ...exactDiff.from, versionNumber: 9 } },
      { ...exactDiff, from: { ...exactDiff.from, semanticHash: "d".repeat(64) } },
      { ...exactDiff, to: { ...exactDiff.to, id: "version-other" } },
      { ...exactDiff, to: { ...exactDiff.to, versionNumber: 8 } },
      { ...exactDiff, to: { ...exactDiff.to, semanticHash: "e".repeat(64) } },
    ]) expect(ui.versionReviewEnvelopeMatches({ selectedRecord, selectedSummary, latestSummary, diff: poisoned })).toBe(false);
  });

  it("guards deferred flow/retry loads and releases mutation ownership only from the owning operation", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const slot = ui.createRequestSlot();
    const first = ui.claimLatestRequest(slot, "flow-a");
    let resolveFirst!: (value: string) => void;
    const firstFetch = new Promise<string>((resolve) => { resolveFirst = resolve; });
    const retry = ui.claimLatestRequest(slot, "flow-a");
    expect(first.controller.signal.aborted).toBe(true);
    const nextFlow = ui.claimLatestRequest(slot, "flow-b");
    expect(retry.controller.signal.aborted).toBe(true);
    resolveFirst("stale-a");
    expect(await firstFetch).toBe("stale-a");
    expect(ui.ownsRequest(slot, first, "flow-a")).toBe(false);
    expect(ui.ownsRequest(slot, nextFlow, "flow-b")).toBe(true);

    ui.cancelRequest(slot);
    const oldMutation = ui.claimExclusiveRequest(slot, "flow-b");
    expect(oldMutation).not.toBeNull();
    expect(ui.claimExclusiveRequest(slot, "flow-b")).toBeNull();
    ui.cancelRequest(slot);
    const replacement = ui.claimExclusiveRequest(slot, "flow-b");
    expect(replacement).not.toBeNull();
    expect(ui.releaseRequest(slot, oldMutation!)).toBe(false);
    expect(ui.ownsRequest(slot, replacement!, "flow-b")).toBe(true);
    expect(ui.releaseRequest(slot, replacement!)).toBe(true);
  });

  it("aborts dismissed review work, ignores stale deployment refreshes, and replaces the exact Live source", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const slot = ui.createRequestSlot();
    const dismissed = ui.claimLatestRequest(slot, "flow-live");
    ui.cancelRequest(slot);
    expect(dismissed.controller.signal.aborted).toBe(true);

    const staleRefresh = ui.claimLatestRequest(slot, "flow-live");
    let resolveStale!: () => void;
    const staleFetch = new Promise<void>((resolve) => { resolveStale = resolve; });
    const currentRefresh = ui.claimLatestRequest(slot, "flow-live");
    resolveStale();
    await staleFetch;
    expect(ui.ownsRequest(slot, staleRefresh, "flow-live")).toBe(false);
    expect(ui.ownsRequest(slot, currentRefresh, "flow-live")).toBe(true);

    const selected = version({
      id: "version-live",
      flowId: "flow-live",
      semanticHash: "a".repeat(64),
      fullHash: "b".repeat(64),
    });
    const liveEnvironment = { id: "env-live", projectId: "project", name: "Live", slug: "live", kind: "live" as const, createdAt: 1 };
    const source = { id: "test-a", flowId: "flow-live", flowVersionId: selected.id, environmentId: "env-test", status: "test" as const, createdAt: 1 };
    const first = ui.buildLivePromotionRequest({
      flowId: "flow-live", version: selected, liveEnvironment, activeLive: null, activeTest: source,
    });
    const replacement = ui.buildLivePromotionRequest({
      flowId: "flow-live", version: selected, liveEnvironment, activeLive: null,
      activeTest: { ...source, id: "test-b" },
    });
    expect(first?.sourceTestDeploymentId).toBe("test-a");
    expect(replacement?.sourceTestDeploymentId).toBe("test-b");
    expect(ui.buildLivePromotionRequest({
      flowId: "flow-live", version: selected, liveEnvironment, activeLive: null,
      activeTest: { ...source, flowVersionId: "version-other" },
    })).toBeNull();
  });

  it("abandons an old flow session by aborting mutation and refresh work before deferred side effects", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const mutationSlot = ui.createRequestSlot();
    const refreshSlot = ui.createRequestSlot();
    const mutation = ui.claimExclusiveRequest(mutationSlot, "flow-old")!;
    const refresh = ui.claimLatestRequest(refreshSlot, "flow-old");
    const reviewController = new AbortController();
    const generation = { current: 4 };
    const restoreGeneration = { current: 2 };
    let resolvePost!: () => void;
    const post = new Promise<void>((resolve) => { resolvePost = resolve; });
    const clientEffects: string[] = [];
    const completion = post.then(() => {
      if (ui.ownsRequest(mutationSlot, mutation, "flow-old")) clientEffects.push("old-flow-success");
    });

    ui.abandonVersionReviewSession({
      mutationSlot,
      refreshSlot,
      reviewController,
      reviewGeneration: generation,
      restoreGeneration,
    });
    expect(mutation.controller.signal.aborted).toBe(true);
    expect(refresh.controller.signal.aborted).toBe(true);
    expect(reviewController.signal.aborted).toBe(true);
    expect(generation.current).toBe(5);
    expect(restoreGeneration.current).toBe(3);
    resolvePost();
    await completion;
    expect(clientEffects).toEqual([]);
  });

  it("submits the exact supported graph to the authoritative row checkpoint", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const graph: FlowGraphV2 = {
      schemaVersion: 2,
      id: "graph-not-the-row-id",
      name: "Current graph",
      nodes: [],
      edges: [],
      variables: [{ id: "var-1", name: "Topic", scope: "run", schema: { type: "string" }, default: "music" }],
      groups: [],
      annotations: [],
    };
    const createCheckpoint = vi.fn(async (rowId: string, supplied: SupportedFlowGraph) => {
      expect(rowId).toBe("row-authoritative");
      expect(supplied).toBe(graph);
      return version({ flowId: rowId });
    });

    const result = await ui.saveVersionCheckpoint({
      rowId: "row-authoritative",
      graph,
      existingVersionIds: new Set<string>(),
      createCheckpoint,
    });

    expect(createCheckpoint).toHaveBeenCalledOnce();
    expect(result.kind).toBe("created");
  });

  it("propagates an atomic checkpoint failure", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const createCheckpoint = vi.fn(async () => {
      throw new Error("checkpoint failed");
    });
    await expect(
      ui.saveVersionCheckpoint({
        rowId: "row-authoritative",
        graph: {
          id: "graph-not-the-row-id",
          name: "Current graph",
          nodes: [],
          edges: [],
        },
        existingVersionIds: new Set<string>(),
        createCheckpoint,
      }),
    ).rejects.toThrow("checkpoint failed");
    expect(createCheckpoint).toHaveBeenCalledOnce();
  });

  it("recognizes dedupe without exposing deploy or launch behavior", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const result = await ui.saveVersionCheckpoint({
      rowId: "row-authoritative",
      graph: { id: "graph", name: "Graph", nodes: [], edges: [] },
      existingVersionIds: new Set(["version-2"]),
      createCheckpoint: async () => version(),
    });
    expect(result.kind).toBe("deduped");
    const source = readFileSync(join(process.cwd(), "src/lib/projects/ui-model.ts"), "utf8");
    const checkpointBoundary = source.slice(
      source.indexOf("export async function saveVersionCheckpoint"),
      source.indexOf("export async function saveBeforeWorkbookNavigation"),
    );
    expect(checkpointBoundary).not.toMatch(/deploy|launch|settle|provider/i);
  });

  it("keeps the requested checkpoint exact while real debounced saves coalesce", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    let releaseUpdate: (() => void) | undefined;
    const updateBlocked = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    let persisted: SupportedFlowGraph = { id: "initial", name: "Initial", nodes: [], edges: [] };
    const graphA: FlowGraph = { id: "a", name: "A", nodes: [], edges: [] };
    const graphB: FlowGraph = { id: "b", name: "B", nodes: [], edges: [] };
    const graphC: FlowGraph = { id: "c", name: "C", nodes: [], edges: [] };
    let firstUpdate = true;
    const coordinator = new FlowSaveCoordinator("row-authoritative", {
      create: async () => "row-authoritative",
      update: async (_rowId, graph) => {
        if (firstUpdate) {
          firstUpdate = false;
          await updateBlocked;
        }
        persisted = structuredClone(graph);
      },
    }, {}, 1);

    const savingA = coordinator.saveNow(graphA);
    await Promise.resolve();
    const createCheckpoint = vi.fn(async (_rowId: string, requested: SupportedFlowGraph) => {
      persisted = structuredClone(requested);
      return version({ graph: structuredClone(requested) });
    });
    const checkpoint = await ui.saveVersionCheckpoint({
      rowId: "row-authoritative",
      graph: graphB,
      existingVersionIds: new Set(),
      createCheckpoint,
    });
    const savingC = coordinator.saveNow(graphC);
    releaseUpdate?.();
    await Promise.all([savingA, savingC]);

    expect(createCheckpoint).toHaveBeenCalledWith("row-authoritative", graphB);
    expect(checkpoint.version.graph).toEqual(graphB);
    expect(persisted).toEqual(graphC);
    await coordinator.dispose();
  });

  it("builds deterministic immutable JSON and keeps draft code distinct", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const first = version({
      graph: {
        name: "Checkpoint",
        id: "graph-not-row",
        edges: [],
        nodes: [],
      },
    });
    const second = {
      ...first,
      graph: {
        nodes: [],
        edges: [],
        id: "graph-not-row",
        name: "Checkpoint",
      },
    } as FlowVersionRecord;
    expect(ui.buildVersionDownload(first)).toEqual(ui.buildVersionDownload(second));
    expect(ui.buildVersionDownload(first).filename).toBe("row-authoritative-v2.json");
    const secretSentinel = "owner-secret-download-sentinel";
    const securedDownload = ui.buildVersionDownload(
      version({ createdBy: secretSentinel }),
    );
    expect(securedDownload.content).toContain('"createdBy": "workspace-owner"');
    expect(securedDownload.content).not.toContain(secretSentinel);
    expect(ui.buildCodeVersionModel("const draft = true;", first)).toMatchObject({
      draftLabel: "Current draft",
      draftSource: "const draft = true;",
      latestLabel: "Latest saved version",
      latestVersionNumber: 2,
    });
    expect(ui.buildCodeVersionModel("const draft = true;", null)).toMatchObject({
      draftLabel: "Current draft",
      latestVersionNumber: null,
      emptyMessage: "No saved versions yet. Open Studio and save one.",
    });
  });

  it("disables delete with a visible reason only when immutable versions exist", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    expect(ui.deleteFlowControl(0)).toEqual({ disabled: false, reason: null });
    expect(ui.deleteFlowControl(2)).toEqual({
      disabled: true,
      reason: "Saved versions keep this flow immutable. Delete is unavailable.",
    });
  });

  it("parses only the client response envelopes needed by the UI", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    expect(ui.parsePersonalContextEnvelope({ context: context() })?.project.name).toBe(
      "My Project",
    );
    expect(ui.parseVersionSummariesEnvelope({ versions: [summary(2)] })?.[0]?.id).toBe(
      "version-2",
    );
    expect(ui.parseVersionRecordEnvelope({ version: version() })?.flowId).toBe(
      "row-authoritative",
    );
    expect(ui.parsePersonalContextEnvelope({ context: { project: null } })).toBeNull();
    expect(ui.parseVersionSummariesEnvelope({ versions: [{ versionNumber: "2" }] })).toBeNull();
    expect(ui.parseVersionRecordEnvelope({ version: { graph: null } })).toBeNull();
  });

  it("strictly accepts only the requested restore flow and version identity", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const expected = { flowId: "row-authoritative", versionId: "version-2" };
    expect(ui.parseVersionRestoreEnvelope({ version: version() }, expected)).toEqual(version());
    expect(ui.parseVersionRestoreEnvelope(
      { version: version({ flowId: "different-row" }) },
      expected,
    )).toBeNull();
    expect(ui.parseVersionRestoreEnvelope(
      { version: version({ id: "different-version" }) },
      expected,
    )).toBeNull();
    expect(ui.parseVersionRestoreEnvelope(
      { version: version({ graph: { ...version().graph, nodes: [{ id: "bad", type: "unknown", params: {}, position: { x: 0, y: 0 } }] } as unknown as SupportedFlowGraph }) },
      expected,
    )).toBeNull();
    expect(ui.parseVersionRestoreEnvelope(
      { version: version({ dependencies: [{ bad: true }] as unknown as FlowVersionRecord["dependencies"] }) },
      expected,
    )).toBeNull();
  });

  it("round-trips an exact resource dependency through restore parsing", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const resourceDependency = {
      id: "resource-pin",
      flowVersionId: "version-2",
      kind: "resource" as const,
      resourceId: "resource-1",
      version: "pack-1",
      contentHash: "a".repeat(64),
      createdAt: 2,
    };
    const input = version({ dependencies: [resourceDependency] });
    expect(ui.parseVersionRestoreEnvelope(
      { version: input },
      { flowId: input.flowId, versionId: input.id },
    )?.dependencies).toEqual([resourceDependency]);
  });

  it("fetches one encoded private version path and rejects invalid responses with fixed errors", async () => {
    const ui = await loadUiModel();
    expect(ui).not.toBeNull();
    if (!ui) return;
    const requested: string[] = [];
    const fetched = await ui.fetchVersionForRestore({
      flowId: "row/opaque",
      versionId: "version?2",
      fetcher: async (path: string) => {
        requested.push(path);
        return new Response(JSON.stringify({
          version: version({ id: "version?2", flowId: "row/opaque" }),
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    expect(requested).toEqual(["/api/v2/flows/row%2Fopaque/versions/version%3F2"]);
    expect(fetched.id).toBe("version?2");

    const secret = "secret-server-restore-error";
    await expect(ui.fetchVersionForRestore({
      flowId: "row-authoritative",
      versionId: "version-2",
      fetcher: async () => new Response(JSON.stringify({ error: secret }), { status: 500 }),
    })).rejects.toThrow("Version restore is unavailable.");
    try {
      await ui.fetchVersionForRestore({
        flowId: "row-authoritative",
        versionId: "version-2",
        fetcher: async () => new Response(JSON.stringify({ error: secret }), { status: 500 }),
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }

    const controller = new AbortController();
    let fetchAborted = false;
    const abandoned = ui.fetchVersionForRestore({
      flowId: "row-authoritative",
      versionId: "version-2",
      signal: controller.signal,
      fetcher: async (_path: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          fetchAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }),
    });
    controller.abort();
    await expect(abandoned).rejects.toThrow("Version restore is unavailable.");
    expect(fetchAborted).toBe(true);
  });
});
