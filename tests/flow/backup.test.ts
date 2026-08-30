import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import type { FlowGraph } from "@/lib/flow/types";
import {
  createFlowBackup,
  FLOW_BACKUP_FORMAT,
  FlowBackupRestoreConflictError,
  parseFlowBackupArchive,
  restoreFlowBackup,
} from "@/lib/flow/backup";

const OWNER = "owner-backup-primary";
const OTHER_OWNER = "owner-backup-other";
const CHILD_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "22222222-2222-4222-8222-222222222222";
const temporaryDirectories: string[] = [];

function repository(): SqliteRepo {
  const directory = mkdtempSync(join(tmpdir(), "agent-studio-flow-backup-"));
  temporaryDirectories.push(directory);
  return new SqliteRepo(join(directory, "studio.db"));
}

function childGraph(): FlowGraph {
  return {
    id: "child-graph",
    name: "Child flow",
    nodes: [{ id: "output", type: "output", params: {}, position: { x: 0, y: 0 } }],
    edges: [],
  };
}

function parentGraph(): FlowGraph {
  return {
    id: "parent-graph",
    name: "Parent flow",
    nodes: [{
      id: "child",
      type: "subflow",
      params: { flowId: CHILD_ID },
      position: { x: 0, y: 0 },
    }],
    edges: [],
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("owner-scoped flow backup and restore", () => {
  it("restores lost flows with their row ids and cross-flow references intact", async () => {
    const repo = repository();
    await repo.saveFlow({ id: CHILD_ID, ownerId: OWNER, name: "Child flow", graph: childGraph() });
    await repo.saveFlow({ id: PARENT_ID, ownerId: OWNER, name: "Parent flow", graph: parentGraph() });

    const backup = await createFlowBackup(OWNER, repo, Date.UTC(2026, 6, 21));
    expect(backup).toMatchObject({
      format: FLOW_BACKUP_FORMAT,
      version: 1,
      createdAt: "2026-07-21T00:00:00.000Z",
    });
    expect(JSON.stringify(backup)).not.toContain(OWNER);
    expect(new Set(backup.flows.map((flow) => flow.id))).toEqual(new Set([CHILD_ID, PARENT_ID]));

    expect(await repo.deleteFlow(PARENT_ID, OWNER)).toBe(true);
    expect(await repo.deleteFlow(CHILD_ID, OWNER)).toBe(true);
    expect(await repo.listFlows(OWNER)).toEqual([]);

    const parentFirstBackup = {
      ...backup,
      flows: [
        backup.flows.find((flow) => flow.id === PARENT_ID)!,
        backup.flows.find((flow) => flow.id === CHILD_ID)!,
      ],
    };
    const result = await restoreFlowBackup(
      OWNER,
      JSON.parse(JSON.stringify(parentFirstBackup)),
      repo,
    );
    expect(result).toEqual({ restored: 2, skipped: 0, flowIds: [CHILD_ID, PARENT_ID] });
    expect(await repo.getOwnedFlow(CHILD_ID, OWNER)).toMatchObject({ graph: childGraph() });
    expect(await repo.getOwnedFlow(PARENT_ID, OWNER)).toMatchObject({ graph: parentGraph() });
    expect(await repo.getOwnedFlow(PARENT_ID, OTHER_OWNER)).toBeNull();

    await expect(restoreFlowBackup(OWNER, backup, repo)).resolves.toEqual({
      restored: 0,
      skipped: 2,
      flowIds: [],
    });
  });

  it("cannot overwrite another owner's rows with a copied backup", async () => {
    const repo = repository();
    await repo.saveFlow({ id: CHILD_ID, ownerId: OWNER, name: "Child flow", graph: childGraph() });
    const backup = await createFlowBackup(OWNER, repo);

    await expect(restoreFlowBackup(OTHER_OWNER, backup, repo))
      .rejects.toBeInstanceOf(FlowBackupRestoreConflictError);
    expect(await repo.listFlows(OTHER_OWNER)).toEqual([]);
    expect(await repo.getOwnedFlow(CHILD_ID, OWNER)).toMatchObject({ name: "Child flow" });
  });

  it("rejects duplicate ids and malformed archives before writing", () => {
    const duplicate = {
      format: FLOW_BACKUP_FORMAT,
      version: 1,
      createdAt: "2026-07-21T00:00:00.000Z",
      flows: [
        { id: CHILD_ID, name: "Child flow", graph: childGraph(), updatedAt: 1 },
        { id: CHILD_ID, name: "Again", graph: childGraph(), updatedAt: 2 },
      ],
    };
    expect(() => parseFlowBackupArchive(duplicate)).toThrow("Invalid flow backup");
  });
});
