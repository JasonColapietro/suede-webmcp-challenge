import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type {
  FlowCallableInterface,
  FlowGraphV2,
  SubflowReference,
} from "@/lib/flow/types";
import {
  derivePinnedFlowDependencies,
  rejectCallerFlowDependencies,
} from "@/lib/projects/subflow-dependencies";
import { CreateFlowVersionRequestSchema } from "@/lib/projects/request-schema";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import type { FlowVersionRecord } from "@/lib/projects/types";
import { VersionService } from "@/lib/projects/version-service";
import { FlowVersionMutationError } from "@/lib/projects/version-mutation-error";
import { mergeServerDerivedFlowDependencies } from "@/lib/projects/subflow-dependencies";

const OWNER = "owner-pins";

function callable(): FlowCallableInterface {
  return {
    inputs: [],
    outputs: [{
      id: "answer",
      label: "Answer",
      schema: { type: "string" },
      required: true,
      cardinality: "one",
      source: { nodeId: "input", portId: "value" },
    }],
  };
}

function graph(id: string, interfaceValue: FlowCallableInterface | undefined = undefined): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id,
    name: id,
    nodes: [{
      id: "input",
      type: "input",
      params: {},
      bindings: {},
      position: { x: 0, y: 0 },
    }],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
    ...(interfaceValue === undefined ? {} : { callableInterface: interfaceValue }),
  };
}

function pinned(
  flowId: string,
  version: FlowVersionRecord,
  interfaceValue = callable(),
): SubflowReference {
  return {
    kind: "pinned",
    flowId,
    versionId: version.id,
    interface: interfaceValue,
    interfaceHash: hashCallableInterface(interfaceValue),
    contentHash: version.semanticHash,
  };
}

function parentGraph(id: string, references: readonly SubflowReference[]): FlowGraphV2 {
  return {
    ...graph(id),
    nodes: references.map((reference, index) => ({
      id: `child-${index}`,
      type: "subflow" as const,
      params: { reference } as never,
      bindings: {},
      position: { x: index * 200, y: 0 },
    })),
  };
}

function seed(db: Database.Database, id: string, value: FlowGraphV2, ownerId = OWNER): void {
  db.prepare(
    "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, ownerId, value.name, JSON.stringify(value), 1);
}

function fixture(): { db: Database.Database; repo: SqliteProjectRepo; service: VersionService } {
  const db = new Database(":memory:");
  const repo = new SqliteProjectRepo(db);
  return { db, repo, service: new VersionService(repo) };
}

function requireVersion(value: FlowVersionRecord | null): FlowVersionRecord {
  if (value === null) throw new Error("Expected flow version");
  return value;
}

describe("server-derived pinned-flow dependencies", () => {
  it("rejects every caller-supplied flow pin at request and pure boundaries", () => {
    const dependency = {
      kind: "flow" as const,
      resourceId: "child",
      version: "version",
      contentHash: "a".repeat(64),
    };

    expect(CreateFlowVersionRequestSchema.safeParse({ dependencies: [dependency] }).success)
      .toBe(false);
    expect(() => rejectCallerFlowDependencies([dependency])).toThrow(/flow.*server|caller.*flow/i);
  });

  it("derives, deduplicates, and canonically sorts direct pinned references", () => {
    const interfaceValue = callable();
    const reference = {
      kind: "pinned" as const,
      flowId: "child-z",
      versionId: "version-z",
      interface: interfaceValue,
      interfaceHash: hashCallableInterface(interfaceValue),
      contentHash: "b".repeat(64),
    };
    const other = { ...reference, flowId: "child-a", versionId: "version-a", contentHash: "a".repeat(64) };

    const base = parentGraph("parent", [reference, other, reference]);
    const mixed: FlowGraphV2 = {
      ...base,
      nodes: base.nodes.map((node, index) => index === 2 ? { ...node, type: "loop" } : node),
    };
    expect(derivePinnedFlowDependencies(mixed))
      .toEqual([
        { kind: "flow", resourceId: "child-a", version: "version-a", contentHash: "a".repeat(64) },
        { kind: "flow", resourceId: "child-z", version: "version-z", contentHash: "b".repeat(64) },
      ]);
  });

  it("refuses a combined caller and derived dependency set above the shared ceiling", () => {
    const interfaceValue = callable();
    const reference: SubflowReference = {
      kind: "pinned",
      flowId: "child",
      versionId: "version",
      interface: interfaceValue,
      interfaceHash: hashCallableInterface(interfaceValue),
      contentHash: "a".repeat(64),
    };
    const caller = Array.from({ length: 1_000 }, (_, index) => ({
      kind: "skill" as const,
      resourceId: `skill-${index}`,
      version: "1",
    }));

    expect(() => mergeServerDerivedFlowDependencies(parentGraph("parent", [reference]), caller))
      .toThrow(/too many|1,?000|ceiling/i);
    expect(() => mergeServerDerivedFlowDependencies(graph("plain"), [
      { kind: "skill", resourceId: "duplicate", version: "1" },
      { kind: "skill", resourceId: "duplicate", version: "2" },
    ])).toThrow(/duplicate/i);
  });

  it("persists verified derived flow pins with caller non-flow pins", async () => {
    const { db, service } = fixture();
    const interfaceValue = callable();
    seed(db, "child", graph("child", interfaceValue));
    seed(db, "parent", graph("parent"));
    const childVersion = requireVersion(await service.createFlowVersion({
      flowId: "child",
      ownerId: OWNER,
    }));

    const parentVersion = requireVersion(await service.createFlowCheckpoint({
      flowId: "parent",
      ownerId: OWNER,
      graph: parentGraph("parent-next", [
        pinned("child", childVersion),
        pinned("child", childVersion),
      ]),
      dependencies: [{ kind: "skill", resourceId: "mail", version: "2" }],
    }));

    expect(parentVersion.dependencies.map(({ kind, resourceId, version, contentHash }) => ({
      kind, resourceId, version, ...(contentHash === undefined ? {} : { contentHash }),
    }))).toEqual([
      {
        kind: "flow",
        resourceId: "child",
        version: childVersion.id,
        contentHash: childVersion.semanticHash,
      },
      { kind: "skill", resourceId: "mail", version: "2" },
    ]);
  });

  it("rolls back an exact checkpoint that names two versions of one child", async () => {
    const { db, service } = fixture();
    const interfaceValue = callable();
    seed(db, "child", graph("child", interfaceValue));
    seed(db, "parent", graph("parent"));
    const first = requireVersion(await service.createFlowVersion({
      flowId: "child", ownerId: OWNER, label: "one",
    }));
    const second = requireVersion(await service.createFlowVersion({
      flowId: "child", ownerId: OWNER, label: "two",
    }));
    const before = db.prepare("SELECT name, graph, updated_at FROM flows WHERE id = 'parent'").get();

    await expect(service.createFlowCheckpoint({
      flowId: "parent",
      ownerId: OWNER,
      graph: parentGraph("parent-next", [pinned("child", first), pinned("child", second)]),
    })).rejects.toThrow(/multiple|version|dependency|flow/i);

    expect(db.prepare("SELECT name, graph, updated_at FROM flows WHERE id = 'parent'").get())
      .toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions WHERE flow_id = 'parent'").get())
      .toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM dependency_pins dp
       JOIN flow_versions fv ON fv.id = dp.flow_version_id WHERE fv.flow_id = 'parent'`,
    ).get()).toEqual({ count: 0 });
  });

  it("rejects direct service and repository caller flow pins without writing", async () => {
    const { db, repo, service } = fixture();
    seed(db, "parent", graph("parent"));
    const dependencies = [{ kind: "flow" as const, resourceId: "forged", version: "forged" }];

    await expect(service.createFlowVersion({ flowId: "parent", ownerId: OWNER, dependencies }))
      .rejects.toThrow(/flow.*server|caller.*flow/i);
    await expect(repo.createFlowVersion({ flowId: "parent", ownerId: OWNER, dependencies }))
      .rejects.toThrow(/flow.*server|caller.*flow/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM dependency_pins").get()).toEqual({ count: 0 });
  });

  it.each(["subflow", "loop"] as const)(
    "refuses typed drafts through service and direct repository %s paths",
    async (nodeType) => {
      const { db, repo, service } = fixture();
      const interfaceValue = callable();
      seed(db, "child", graph("child", interfaceValue));
      const draft: SubflowReference = {
        kind: "draft",
        flowId: "child",
        interface: interfaceValue,
        interfaceHash: hashCallableInterface(interfaceValue),
      };
      const base = parentGraph("parent", [draft]);
      const candidate: FlowGraphV2 = {
        ...base,
        nodes: base.nodes.map((node, index) => index === 0 ? { ...node, type: nodeType } : node),
      };
      seed(db, "parent", candidate);
      seed(db, "checkpoint", graph("checkpoint"));

      await expect(service.createFlowVersion({ flowId: "parent", ownerId: OWNER }))
        .rejects.toBeInstanceOf(FlowVersionMutationError);
      await expect(repo.createFlowVersion({ flowId: "parent", ownerId: OWNER, dependencies: [] }))
        .rejects.toBeInstanceOf(FlowVersionMutationError);
      await expect(service.createFlowCheckpoint({
        flowId: "checkpoint", ownerId: OWNER, graph: candidate,
      })).rejects.toBeInstanceOf(FlowVersionMutationError);
      await expect(repo.createFlowCheckpoint({
        flowId: "checkpoint", ownerId: OWNER, graph: candidate, dependencies: [],
      })).rejects.toBeInstanceOf(FlowVersionMutationError);
      expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM dependency_pins").get()).toEqual({ count: 0 });
    },
  );

  it("rolls back a checkpoint when caller plus derived pins exceed the combined ceiling", async () => {
    const { db, service } = fixture();
    const interfaceValue = callable();
    seed(db, "child", graph("child", interfaceValue));
    seed(db, "parent", graph("parent"));
    const childVersion = requireVersion(await service.createFlowVersion({
      flowId: "child", ownerId: OWNER,
    }));
    const before = db.prepare("SELECT name, graph, updated_at FROM flows WHERE id = 'parent'").get();
    const dependencies = Array.from({ length: 1_000 }, (_, index) => ({
      kind: "skill" as const,
      resourceId: `skill-${index}`,
      version: "1",
    }));

    await expect(service.createFlowCheckpoint({
      flowId: "parent",
      ownerId: OWNER,
      graph: parentGraph("parent-next", [pinned("child", childVersion)]),
      dependencies,
    })).rejects.toThrow(/too many/i);

    expect(db.prepare("SELECT name, graph, updated_at FROM flows WHERE id = 'parent'").get())
      .toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions WHERE flow_id = 'parent'").get())
      .toEqual({ count: 0 });
  });

  it("refuses a child version whose stored semantic receipt or dependency pins were tampered", async () => {
    const { db, service } = fixture();
    const interfaceValue = callable();
    seed(db, "child", graph("child", interfaceValue));
    seed(db, "parent", graph("parent"));
    const childVersion = requireVersion(await service.createFlowVersion({
      flowId: "child",
      ownerId: OWNER,
      dependencies: [{ kind: "skill", resourceId: "skill", version: "1" }],
    }));
    const candidate = parentGraph("parent", [pinned("child", childVersion)]);

    db.prepare("UPDATE flow_versions SET semantic_hash = ? WHERE id = ?")
      .run("f".repeat(64), childVersion.id);
    await expect(service.createFlowCheckpoint({ flowId: "parent", ownerId: OWNER, graph: candidate }))
      .rejects.toBeInstanceOf(FlowVersionMutationError);
    db.prepare("UPDATE flow_versions SET semantic_hash = ? WHERE id = ?")
      .run(childVersion.semanticHash, childVersion.id);
    db.prepare("UPDATE dependency_pins SET version = 'tampered' WHERE flow_version_id = ?")
      .run(childVersion.id);
    db.prepare("UPDATE flows SET graph = ? WHERE id = 'parent'").run(JSON.stringify(candidate));
    await expect(service.createFlowVersion({ flowId: "parent", ownerId: OWNER }))
      .rejects.toBeInstanceOf(FlowVersionMutationError);

    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions WHERE flow_id = 'parent'").get())
      .toEqual({ count: 0 });
  });

  it("rolls back graph, pins, and impact-receipt consumption when a derived pin insert fails", async () => {
    const { db, service } = fixture();
    const originalInterface = callable();
    const revisedInterface: FlowCallableInterface = { inputs: [], outputs: [] };
    seed(db, "grandchild", graph("grandchild", originalInterface));
    seed(db, "child", graph("child", originalInterface));
    const grandchildVersion = requireVersion(await service.createFlowVersion({
      flowId: "grandchild", ownerId: OWNER,
    }));
    const draft: SubflowReference = {
      kind: "draft",
      flowId: "child",
      interface: originalInterface,
      interfaceHash: hashCallableInterface(originalInterface),
    };
    seed(db, "dependent", parentGraph("dependent", [draft]));
    const proposed: FlowGraphV2 = {
      ...graph("child-next", revisedInterface),
      nodes: [
        ...graph("child-next", revisedInterface).nodes,
        ...parentGraph("wrapper", [pinned("grandchild", grandchildVersion)]).nodes,
      ],
    };
    const before = db.prepare("SELECT name, graph, updated_at FROM flows WHERE id = 'child'").get();

    let receipt = "";
    try {
      await service.createFlowCheckpoint({ flowId: "child", ownerId: OWNER, graph: proposed });
    } catch (error) {
      expect(error).toBeInstanceOf(FlowVersionMutationError);
      const result = (error as FlowVersionMutationError).result;
      if (result.status === "impact-required") receipt = result.receipt;
    }
    expect(receipt).not.toBe("");
    db.exec(`CREATE TRIGGER fail_derived_flow_pin BEFORE INSERT ON dependency_pins
      WHEN NEW.kind = 'flow' BEGIN SELECT RAISE(ABORT, 'forced derived pin failure'); END`);

    await expect(service.createFlowCheckpoint({
      flowId: "child", ownerId: OWNER, graph: proposed, impactReceipt: receipt,
    })).rejects.toThrow("forced derived pin failure");

    expect(db.prepare("SELECT name, graph, updated_at FROM flows WHERE id = 'child'").get())
      .toEqual(before);
    expect(db.prepare("SELECT consumed_at FROM subflow_impact_receipts").get())
      .toEqual({ consumed_at: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions WHERE flow_id = 'child'").get())
      .toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM dependency_pins dp
       JOIN flow_versions fv ON fv.id = dp.flow_version_id WHERE fv.flow_id = 'child'`,
    ).get()).toEqual({ count: 0 });
  });
});
