import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlowGraphV2 } from "@/lib/flow/types";
import { SupabaseProjectRepo } from "@/lib/projects/supabase-project-repo";
import type { PersonalContext } from "@/lib/projects/types";
import { FlowVersionMutationError } from "@/lib/projects/version-mutation-error";

const createdAt = "2026-07-16T12:00:00.000Z";

type QueryResult = { readonly data: unknown; readonly error: unknown };

function query(result: QueryResult): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "update", "order"] as const) {
    value[method] = vi.fn(() => value);
  }
  value.maybeSingle = vi.fn(async () => result);
  value.then = (
    resolve: (result: QueryResult) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return value;
}

function graphWithReference(type: "subflow" | "loop"): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: `${type}-graph`,
    name: `${type} graph`,
    nodes: [{
      id: "child",
      type,
      params: { flowId: "child-flow" },
      bindings: {},
      position: { x: 0, y: 0 },
    }],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
  };
}

function deploymentRow(status: "test" | "retired", retiredAt: string | null) {
  return {
    id: "deployment-1",
    flow_id: "flow-1",
    flow_version_id: "version-1",
    environment_id: "environment-1",
    status,
    created_at: createdAt,
    retired_at: retiredAt,
  };
}

function personalContext(): PersonalContext {
  return {
    organization: {
      id: "10000000-0000-4000-8000-000000000001",
      personalOwnerId: "owner-1",
      name: "Personal",
      kind: "personal",
      createdAt: Date.parse(createdAt),
    },
    workspace: {
      id: "20000000-0000-4000-8000-000000000002",
      organizationId: "10000000-0000-4000-8000-000000000001",
      name: "Studio",
      slug: "studio",
      createdAt: Date.parse(createdAt),
    },
    project: {
      id: "30000000-0000-4000-8000-000000000003",
      workspaceId: "20000000-0000-4000-8000-000000000002",
      name: "My project",
      slug: "my-project",
      createdAt: Date.parse(createdAt),
      updatedAt: Date.parse(createdAt),
    },
    workbook: {
      id: "40000000-0000-4000-8000-000000000004",
      projectId: "30000000-0000-4000-8000-000000000003",
      name: "Main",
      slug: "main",
      position: 0,
      createdAt: Date.parse(createdAt),
    },
    environments: [],
  };
}

describe("SupabaseProjectRepo transactional RPC boundary", () => {
  it("binds a flow and creates its workbook tab through one database RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        flow_id: "50000000-0000-4000-8000-000000000005",
        project_id: "30000000-0000-4000-8000-000000000003",
        workbook_id: "40000000-0000-4000-8000-000000000004",
        created_at: createdAt,
      },
      error: null,
    });
    const repo = new SupabaseProjectRepo({ rpc } as unknown as SupabaseClient);
    const context = personalContext();

    await expect(repo.bindFlow("50000000-0000-4000-8000-000000000005", context))
      .resolves.toMatchObject({
        flowId: "50000000-0000-4000-8000-000000000005",
        projectId: context.project.id,
        workbookId: context.workbook.id,
      });
    expect(rpc).toHaveBeenCalledWith("agent_studio_bind_flow", {
      p_flow_id: "50000000-0000-4000-8000-000000000005",
      p_owner_id: "owner-1",
      p_organization_id: context.organization.id,
      p_workspace_id: context.workspace.id,
      p_project_id: context.project.id,
      p_workbook_id: context.workbook.id,
    });
  });

  it("reorders the complete tab set through one database RPC", async () => {
    const first = "60000000-0000-4000-8000-000000000006";
    const second = "70000000-0000-4000-8000-000000000007";
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { id: second, workbook_id: personalContext().workbook.id, flow_id: "80000000-0000-4000-8000-000000000008", title: "Second", position: 0, created_at: createdAt, updated_at: createdAt },
        { id: first, workbook_id: personalContext().workbook.id, flow_id: "90000000-0000-4000-8000-000000000009", title: "First", position: 1, created_at: createdAt, updated_at: createdAt },
      ],
      error: null,
    });
    const repo = new SupabaseProjectRepo({ rpc } as unknown as SupabaseClient);

    await expect(repo.reorderWorkbookTabs({
      workbookId: personalContext().workbook.id,
      ownerId: "owner-1",
      tabIds: [second, first],
    })).resolves.toMatchObject([{ id: second, position: 0 }, { id: first, position: 1 }]);
    expect(rpc).toHaveBeenCalledWith("agent_studio_reorder_workbook_tabs", {
      p_workbook_id: personalContext().workbook.id,
      p_owner_id: "owner-1",
      p_tab_ids: [second, first],
    });
  });

  it.each([
    ["version", "subflow"],
    ["version", "loop"],
    ["checkpoint", "subflow"],
    ["checkpoint", "loop"],
  ] as const)("fails closed for %s creation containing a %s reference", async (operation, nodeType) => {
    const graph = graphWithReference(nodeType);
    const rpc = vi.fn();
    const from = vi.fn(() => query({
      data: operation === "version" ? { graph } : { id: "flow-1" },
      error: null,
    }));
    const repo = new SupabaseProjectRepo({ from, rpc } as unknown as SupabaseClient);
    const promise = operation === "version"
      ? repo.createFlowVersion({ flowId: "flow-1", ownerId: "owner-1", dependencies: [] })
      : repo.createFlowCheckpoint({
          flowId: "flow-1", ownerId: "owner-1", dependencies: [], graph,
        });
    const error = await promise.then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(FlowVersionMutationError);
    expect(error).toMatchObject({ result: { status: "invalid-reference" } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["40001", "23505"])("maps version RPC error %s to a mutation conflict", async (code) => {
    const graph: FlowGraphV2 = {
      schemaVersion: 2,
      id: "plain-graph",
      name: "Plain graph",
      nodes: [], edges: [], variables: [], groups: [], annotations: [],
    };
    const from = vi.fn(() => query({ data: { graph }, error: null }));
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code, message: "version race" },
    }));
    const repo = new SupabaseProjectRepo({ from, rpc } as unknown as SupabaseClient);
    const error = await repo.createFlowVersion({
      flowId: "flow-1",
      ownerId: "owner-1",
      label: "Force RPC",
      dependencies: [],
    }).then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(FlowVersionMutationError);
    expect(error).toMatchObject({ result: { status: "conflict" } });
  });

  it("returns the winning retired deployment after a compare-and-set race", async () => {
    const retiredAt = "2026-07-16T12:01:00.000Z";
    const from = vi.fn()
      .mockReturnValueOnce(query({ data: deploymentRow("test", null), error: null }))
      .mockReturnValueOnce(query({ data: { id: "flow-1" }, error: null }))
      .mockReturnValueOnce(query({ data: null, error: null }))
      .mockReturnValueOnce(query({ data: deploymentRow("retired", retiredAt), error: null }));
    const repo = new SupabaseProjectRepo({ from } as unknown as SupabaseClient);

    await expect(repo.retireDeployment({ deploymentId: "deployment-1", ownerId: "owner-1" }))
      .resolves.toMatchObject({
        id: "deployment-1",
        flowId: "flow-1",
        status: "retired",
        retiredAt: Date.parse(retiredAt),
      });
    expect(from).toHaveBeenNthCalledWith(4, "deployments");
  });

  it("restores an exact prior deployment through one owner-scoped CAS RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: deploymentRow("test", null),
      error: null,
    });
    const repo = new SupabaseProjectRepo({ rpc } as unknown as SupabaseClient);

    await expect(repo.restoreActiveDeployment({
      deploymentId: "deployment-1",
      expectedActiveDeploymentId: "deployment-2",
      ownerId: "owner-1",
    })).resolves.toMatchObject({ id: "deployment-1", status: "test" });
    expect(rpc).toHaveBeenCalledWith("agent_studio_restore_active_deployment", {
      p_deployment_id: "deployment-1",
      p_expected_active_deployment_id: "deployment-2",
      p_owner_id: "owner-1",
    });
  });

  it("keeps bind, reorder, version creation, and deployment behind transactional RPCs", () => {
    const source = readFileSync(
      new URL("../../src/lib/projects/supabase-project-repo.ts", import.meta.url),
      "utf8",
    );
    for (const rpcName of [
      "agent_studio_bind_flow",
      "agent_studio_reorder_workbook_tabs",
      "agent_studio_create_flow_version",
      "agent_studio_deploy_version",
      "agent_studio_restore_active_deployment",
    ]) {
      expect(source).toContain(`this.db.rpc(\"${rpcName}\"`);
    }
    expect(source).not.toContain('.from("flow_project_bindings").insert');
    expect(source).not.toContain('.from("flow_versions").insert');
    expect(source).not.toContain('.from("deployments").insert');
  });
});
