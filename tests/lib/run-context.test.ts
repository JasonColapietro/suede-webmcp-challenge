/**
 * Regression: a Subflow node could reference ANY flow UUID and execute it,
 * regardless of who owned it — loadSubflow performed no owner check. Fix:
 * buildRunContext takes the parent run's owner and loadSubflow refuses to
 * return a flow whose ownerId doesn't match.
 */
import { describe, it, expect } from "vitest";
import { buildRunContext } from "@/lib/run-context";
import { getRepo } from "@/lib/db/repo";
import { RunLogger } from "@/lib/log";
import type { FlowGraph, FlowGraphV2 } from "@/lib/flow/types";
import { getProjectRepo } from "@/lib/projects/provider";
import { VersionService } from "@/lib/projects/version-service";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import Database from "better-sqlite3";

const graph = (id: string): FlowGraph => ({
  id,
  name: `Flow ${id}`,
  nodes: [{ id: "i", type: "input", params: {}, position: { x: 0, y: 0 } }],
  edges: [],
});

describe("buildRunContext().resolveSubflow", () => {
  it("does not hydrate a malformed foreign graph and gives it the private not-found result", async () => {
    const sqlitePath = process.env.SQLITE_PATH;
    expect(sqlitePath).toBeTruthy();
    const repo = await getRepo();
    const malformedId = `malformed-foreign-${Date.now()}`;
    const db = new Database(sqlitePath!);
    db.prepare(
      "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(malformedId, "victim-owner", "Malformed", '{"schemaVersion":2,"broken":true}', Date.now());
    db.close();

    const ctx = buildRunContext({ runId: "attacker", logger: new RunLogger(), ownerId: "attacker-owner" });
    await expect(ctx.loadSubflow(malformedId)).rejects.toThrow(`Subflow ${malformedId} not found`);
    await expect(ctx.resolveSubflow({
      kind: "draft", flowId: malformedId, interface: { inputs: [], outputs: [] },
      interfaceHash: hashCallableInterface({ inputs: [], outputs: [] }),
    })).rejects.toThrow(`Subflow ${malformedId} not found`);
    await expect(ctx.loadSubflow("missing-private-row")).rejects.toThrow("Subflow missing-private-row not found");

    // Sanity: if ownership is correct, malformed persisted data is not hidden.
    const victim = buildRunContext({ runId: "victim", logger: new RunLogger(), ownerId: "victim-owner" });
    await expect(victim.loadSubflow(malformedId)).rejects.toThrow(/invalid_type|Required|contract/i);
    expect(await repo.getFlow(malformedId).catch(() => null)).toBeNull();
  });
  it("resolves an owner-scoped immutable pinned version after the draft changes", async () => {
    const repo = await getRepo();
    const ownerId = `owner-pinned-${Date.now()}`;
    const callableInterface = { inputs: [], outputs: [] } as const;
    const pinnedGraph: FlowGraphV2 = {
      schemaVersion: 2, id: "pinned-original", name: "Original", nodes: [], edges: [],
      variables: [], groups: [], annotations: [], callableInterface,
    };
    const original = await repo.saveFlow({ ownerId, name: "Original", graph: pinnedGraph });
    const versions = new VersionService(await getProjectRepo());
    const version = await versions.createFlowVersion({ flowId: original.id, ownerId });
    expect(version).not.toBeNull();
    await repo.saveFlow({ id: original.id, ownerId, name: "Changed", graph: graph("pinned-changed") });
    const ctx = buildRunContext({ runId: "test", logger: new RunLogger(), ownerId });
    const resolved = await ctx.resolveSubflow!({
      kind: "pinned", flowId: original.id, versionId: version!.id,
      interface: callableInterface,
      interfaceHash: hashCallableInterface(callableInterface), contentHash: version!.semanticHash,
    });
    expect(resolved.graph.id).toBe("pinned-original");
    expect(resolved.versionId).toBe(version!.id);
  });

  it("seeds an immutable root ancestry only when rootFlowId is explicit", () => {
    const root = buildRunContext({ runId: "root", logger: new RunLogger(), ownerId: "owner", rootFlowId: "row-root" });
    const gateway = buildRunContext({ runId: "gateway", logger: new RunLogger(), ownerId: null });
    expect(root.flowAncestry).toEqual(["row-root"]);
    expect(gateway.flowAncestry).toEqual([]);
  });

  it("refuses typed draft resolution for a foreign owner and for stale interface receipts", async () => {
    const repo = await getRepo();
    const callableInterface = { inputs: [], outputs: [] } as const;
    const child: FlowGraphV2 = {
      schemaVersion: 2, id: "typed-draft", name: "Typed", nodes: [], edges: [],
      variables: [], groups: [], annotations: [], callableInterface,
    };
    const saved = await repo.saveFlow({ ownerId: "victim-owner", name: "Typed", graph: child });
    const foreign = buildRunContext({ runId: "foreign", logger: new RunLogger(), ownerId: "attacker-owner" });
    await expect(foreign.resolveSubflow({
      kind: "draft", flowId: saved.id, interface: callableInterface,
      interfaceHash: hashCallableInterface(callableInterface),
    })).rejects.toThrow(`Subflow ${saved.id} not found`);

    const owner = buildRunContext({ runId: "owner", logger: new RunLogger(), ownerId: "victim-owner" });
    await expect(owner.resolveSubflow({
      kind: "draft", flowId: saved.id,
      interface: { inputs: [{ id: "stale", label: "Stale", schema: {}, required: false, cardinality: "one", target: { kind: "trigger", path: "/stale" } }], outputs: [] },
      interfaceHash: hashCallableInterface({ inputs: [{ id: "stale", label: "Stale", schema: {}, required: false, cardinality: "one", target: { kind: "trigger", path: "/stale" } }], outputs: [] }),
    })).rejects.toThrow(/interface hash mismatch/i);
  });

  it("keeps pinned versions owner-scoped, never falls back to draft, and verifies both receipts", async () => {
    const repo = await getRepo();
    const ownerId = `pinned-victim-${Date.now()}`;
    const callableInterface = { inputs: [], outputs: [] } as const;
    const graphV2: FlowGraphV2 = {
      schemaVersion: 2, id: "pinned-private", name: "Pinned", nodes: [], edges: [],
      variables: [], groups: [], annotations: [], callableInterface,
    };
    const saved = await repo.saveFlow({ ownerId, name: "Pinned", graph: graphV2 });
    const version = await new VersionService(await getProjectRepo()).createFlowVersion({ flowId: saved.id, ownerId });
    expect(version).not.toBeNull();
    const base = {
      kind: "pinned" as const, flowId: saved.id, versionId: version!.id,
      interface: callableInterface, interfaceHash: hashCallableInterface(callableInterface),
      contentHash: version!.semanticHash,
    };

    const attacker = buildRunContext({ runId: "attacker", logger: new RunLogger(), ownerId: "other-owner" });
    await expect(attacker.resolveSubflow(base)).rejects.toThrow(`Subflow ${saved.id} not found`);

    const owner = buildRunContext({ runId: "owner", logger: new RunLogger(), ownerId });
    await expect(owner.resolveSubflow({ ...base, versionId: "missing-version" }))
      .rejects.toThrow(`Subflow ${saved.id} not found`);
    await expect(owner.resolveSubflow({ ...base, contentHash: "f".repeat(64) }))
      .rejects.toThrow(/content hash mismatch/i);

    const staleInterface = {
      inputs: [{ id: "stale", label: "Stale", schema: {}, required: false, cardinality: "one" as const, target: { kind: "trigger" as const, path: "/stale" } }], outputs: [],
    };
    await expect(owner.resolveSubflow({
      ...base, interface: staleInterface, interfaceHash: hashCallableInterface(staleInterface),
    })).rejects.toThrow(/interface hash mismatch/i);
  });
});

describe("buildRunContext().loadSubflow — owner check", () => {
  it("loads a subflow owned by the same owner as the parent run", async () => {
    const repo = await getRepo();
    const owner = `owner-rc-${Date.now()}-a`;
    const sub = await repo.saveFlow({ ownerId: owner, name: "Mine", graph: graph("rc-mine") });

    const ctx = buildRunContext({ runId: "test-run", logger: new RunLogger(), ownerId: owner });
    const loaded = await ctx.loadSubflow(sub.id);
    expect(loaded.id).toBe("rc-mine");
  });

  it("refuses to load a subflow owned by a different owner", async () => {
    const repo = await getRepo();
    const victim = `owner-rc-${Date.now()}-victim`;
    const attacker = `owner-rc-${Date.now()}-attacker`;
    const theirs = await repo.saveFlow({ ownerId: victim, name: "Theirs", graph: graph("rc-theirs") });

    const ctx = buildRunContext({ runId: "test-run", logger: new RunLogger(), ownerId: attacker });
    await expect(ctx.loadSubflow(theirs.id)).rejects.toThrow(`Subflow ${theirs.id} not found`);
  });

  it("refuses every subflow load when the run has no owner", async () => {
    const repo = await getRepo();
    const owner = `owner-rc-${Date.now()}-b`;
    const flow = await repo.saveFlow({ ownerId: owner, name: "Orphaned", graph: graph("rc-orphan") });

    const ctx = buildRunContext({ runId: "test-run", logger: new RunLogger(), ownerId: null });
    await expect(ctx.loadSubflow(flow.id)).rejects.toThrow(`Subflow ${flow.id} not found`);
  });

  it("gives the same not-found error for a missing flow as for a wrong owner", async () => {
    const ctx = buildRunContext({ runId: "test-run", logger: new RunLogger(), ownerId: "owner-rc-nope" });
    await expect(ctx.loadSubflow("does-not-exist")).rejects.toThrow("Subflow does-not-exist not found");
  });
});
