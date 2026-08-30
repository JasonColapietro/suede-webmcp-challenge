import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/db/supabase-server-client";
import { mutationValueWithinBudget } from "@/lib/flow/flow-mutation-service";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import { API_OPERATION_LIVE_UNAVAILABLE, graphContainsApiOperation } from "@/lib/connectors/operation-closure";
import { hashFlowGraph } from "./hash";
import { PERSONAL_CONTEXT_DEFAULTS } from "./personal-context";
import type {
  CreateFlowCheckpointRepositoryInput,
  CreateFlowVersionRepositoryInput,
  DeployVersionRepositoryInput,
  DeployVersionRepositoryResult,
  GetActiveDeploymentRepositoryInput,
  GetFlowVersionRepositoryInput,
  ListActiveDeploymentsForFlowsRepositoryInput,
  ListDeploymentsRepositoryInput,
  ListFlowVersionsRepositoryInput,
  ListWorkbookTabsRepositoryInput,
  ProjectRepo,
  RenameWorkbookTabRepositoryInput,
  ReorderWorkbookTabsRepositoryInput,
  RetireDeploymentRepositoryInput,
  RestoreActiveDeploymentRepositoryInput,
} from "./repo";
import type {
  DependencyPin,
  DependencyPinInput,
  DeploymentRecord,
  EnvironmentKind,
  EnvironmentRecord,
  FlowProjectBinding,
  FlowVersionRecord,
  FlowVersionSummary,
  OrganizationRecord,
  PersonalContext,
  ProjectRecord,
  WorkbookFlowTab,
  WorkbookRecord,
  WorkspaceRecord,
} from "./types";
import { FLOW_SCHEMA_VERSION, isFlowLifecycle } from "./types";
import {
  compareDependencyContent,
  normalizeDependencyPins,
  normalizeVersionCreationInput,
} from "./version-input";
import { FlowVersionMutationError } from "./version-mutation-error";
import { SupabaseResourceRepository } from "@/lib/resources/supabase-repository";
import {
  assertPinnedResourceDependenciesCurrent,
  createOwnerScopedResourcePackResolver,
  derivePinnedResourceDependencies,
  rejectCallerResourceDependencies,
  type OwnerScopedResourcePackResolver,
} from "./resource-dependencies";

type Row = Record<string, unknown>;

function timeMs(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error("Invalid database timestamp");
  return parsed;
}

function optionalTimeMs(value: unknown): number | null {
  return value === null || value === undefined ? null : timeMs(value);
}

function requireRow(value: Row | null | undefined, label: string): Row {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function isDuplicate(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

function throwVersionRpcError(error: { code?: string; message: string }): never {
  if (error.code === "40001" || isDuplicate(error)) {
    throw new FlowVersionMutationError({ status: "conflict" });
  }
  throw new Error(error.message);
}

/**
 * The temporary Supabase adapter does not yet have the bounded closure and
 * dependency-pin derivation used by the SQLite version path. Refuse reusable
 * flow references here instead of creating an incomplete immutable manifest.
 */
function hasUnsupportedVersionReference(graph: SupportedFlowGraph): boolean {
  return graph.nodes.some((node) => node.type === "subflow" || node.type === "loop");
}

function organizationRecord(row: Row): OrganizationRecord {
  return {
    id: String(row.id),
    personalOwnerId: String(row.personal_owner_id),
    name: String(row.name),
    kind: row.kind === "team" ? "team" : "personal",
    createdAt: timeMs(row.created_at),
  };
}

function workspaceRecord(row: Row): WorkspaceRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    slug: String(row.slug),
    createdAt: timeMs(row.created_at),
  };
}

function projectRecord(row: Row): ProjectRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    slug: String(row.slug),
    createdAt: timeMs(row.created_at),
    updatedAt: timeMs(row.updated_at),
  };
}

function workbookRecord(row: Row): WorkbookRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    slug: String(row.slug),
    position: Number(row.position),
    createdAt: timeMs(row.created_at),
  };
}

function environmentRecord(row: Row): EnvironmentRecord {
  const kind = row.kind;
  if (kind !== "draft" && kind !== "test" && kind !== "live") {
    throw new Error("Invalid environment kind");
  }
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    slug: String(row.slug),
    kind,
    createdAt: timeMs(row.created_at),
  };
}

function bindingRecord(row: Row): FlowProjectBinding {
  return {
    flowId: String(row.flow_id),
    projectId: String(row.project_id),
    workbookId: String(row.workbook_id),
    createdAt: timeMs(row.created_at),
  };
}

function tabRecord(row: Row): WorkbookFlowTab {
  return {
    id: String(row.id),
    workbookId: String(row.workbook_id),
    flowId: String(row.flow_id),
    title: String(row.title),
    position: Number(row.position),
    createdAt: timeMs(row.created_at),
    updatedAt: timeMs(row.updated_at),
  };
}

function dependencyRecord(row: Row): DependencyPin {
  return {
    id: String(row.id),
    flowVersionId: String(row.flow_version_id),
    kind: row.kind as DependencyPin["kind"],
    resourceId: String(row.resource_id),
    version: String(row.version),
    ...(row.content_hash === null || row.content_hash === undefined
      ? {}
      : { contentHash: String(row.content_hash) }),
    createdAt: timeMs(row.created_at),
  };
}

function parseGraph(value: unknown): SupportedFlowGraph {
  if (!mutationValueWithinBudget(value)) throw new Error("Invalid persisted flow graph");
  const parsed = parseSupportedFlowGraph(value);
  return parseSupportedFlowGraph(JSON.parse(JSON.stringify(parsed)) as unknown);
}

function versionRecord(row: Row, dependencies: readonly DependencyPin[]): FlowVersionRecord {
  return {
    id: String(row.id),
    flowId: String(row.flow_id),
    versionNumber: Number(row.version_number),
    schemaVersion: Number(row.schema_version),
    ...(row.label === null || row.label === undefined ? {} : { label: String(row.label) }),
    ...(row.description === null || row.description === undefined
      ? {}
      : { description: String(row.description) }),
    graph: parseGraph(row.graph),
    semanticHash: String(row.semantic_hash),
    fullHash: String(row.full_hash),
    createdBy: String(row.created_by),
    createdAt: timeMs(row.created_at),
    dependencies: [...dependencies].sort(compareDependencyContent),
  };
}

function deploymentRecord(row: Row): DeploymentRecord | null {
  const status = row.status;
  if (typeof status !== "string" || !isFlowLifecycle(status)) return null;
  const retiredAt = optionalTimeMs(row.retired_at);
  if ((status === "retired") !== (retiredAt !== null)) return null;
  return {
    id: String(row.id),
    flowId: String(row.flow_id),
    flowVersionId: String(row.flow_version_id),
    environmentId: String(row.environment_id),
    status,
    createdAt: timeMs(row.created_at),
    ...(retiredAt === null ? {} : { retiredAt }),
  };
}

function dependenciesEqual(
  expected: readonly DependencyPinInput[],
  actual: readonly DependencyPin[],
): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((candidate, index) => {
    const pin = actual[index];
    return pin !== undefined && candidate.kind === pin.kind &&
      candidate.resourceId === pin.resourceId && candidate.version === pin.version &&
      (candidate.contentHash ?? null) === (pin.contentHash ?? null);
  });
}

export class SupabaseProjectRepo implements ProjectRepo {
  private readonly db: SupabaseClient;
  private readonly injectedResourceResolver?: OwnerScopedResourcePackResolver;

  constructor(
    client: SupabaseClient = createServerSupabaseClient(),
    options: { readonly resolveResourcePack?: OwnerScopedResourcePackResolver } = {},
  ) {
    this.db = client;
    this.injectedResourceResolver = options.resolveResourcePack;
  }

  private resourceResolver(ownerId: string): OwnerScopedResourcePackResolver {
    return this.injectedResourceResolver ?? createOwnerScopedResourcePackResolver(
      ownerId,
      new SupabaseResourceRepository(this.db),
    );
  }

  private async insertIgnoringDuplicate(table: string, row: Row): Promise<void> {
    const { error } = await this.db.from(table).insert(row);
    if (error && !isDuplicate(error)) throw new Error(error.message);
  }

  private async organizationForOwner(ownerId: string): Promise<OrganizationRecord | null> {
    const { data, error } = await this.db.from("organizations").select().eq(
      "personal_owner_id",
      ownerId,
    ).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? organizationRecord(data as Row) : null;
  }

  private async workspaceForOwner(ownerId: string): Promise<WorkspaceRecord | null> {
    const organization = await this.organizationForOwner(ownerId);
    if (!organization) return null;
    const { data, error } = await this.db.from("workspaces").select()
      .eq("organization_id", organization.id)
      .eq("slug", PERSONAL_CONTEXT_DEFAULTS.workspaceSlug)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? workspaceRecord(data as Row) : null;
  }

  async ownsFlow(flowId: string, ownerId: string): Promise<boolean> {
    const { data, error } = await this.db.from("flows").select("id")
      .eq("id", flowId).eq("owner_id", ownerId).maybeSingle();
    if (error) throw new Error(error.message);
    return Boolean(data);
  }

  async ensurePersonalContext(ownerId: string): Promise<PersonalContext> {
    if (ownerId.trim().length === 0) throw new TypeError("ownerId is required");
    let organization = await this.organizationForOwner(ownerId);
    if (!organization) {
      await this.insertIgnoringDuplicate("organizations", {
        id: randomUUID(), personal_owner_id: ownerId,
        name: PERSONAL_CONTEXT_DEFAULTS.organizationName, kind: "personal",
      });
      const { data, error } = await this.db.from("organizations").select()
        .eq("personal_owner_id", ownerId).single();
      if (error) throw new Error(error.message);
      organization = organizationRecord(requireRow(data as Row, "organization"));
    }

    let workspace = await this.workspaceForOwner(ownerId);
    if (!workspace) {
      await this.insertIgnoringDuplicate("workspaces", {
        id: randomUUID(), organization_id: organization.id,
        name: PERSONAL_CONTEXT_DEFAULTS.workspaceName,
        slug: PERSONAL_CONTEXT_DEFAULTS.workspaceSlug,
      });
      const { data, error } = await this.db.from("workspaces").select()
        .eq("organization_id", organization.id)
        .eq("slug", PERSONAL_CONTEXT_DEFAULTS.workspaceSlug).single();
      if (error) throw new Error(error.message);
      workspace = workspaceRecord(requireRow(data as Row, "workspace"));
    }

    let project = (await this.listProjects(ownerId)).find(
      (candidate) => candidate.workspaceId === workspace.id &&
        candidate.slug === PERSONAL_CONTEXT_DEFAULTS.projectSlug,
    ) ?? null;
    if (!project) {
      await this.insertIgnoringDuplicate("projects", {
        id: randomUUID(), workspace_id: workspace.id,
        name: PERSONAL_CONTEXT_DEFAULTS.projectName,
        slug: PERSONAL_CONTEXT_DEFAULTS.projectSlug,
      });
      const { data, error } = await this.db.from("projects").select()
        .eq("workspace_id", workspace.id)
        .eq("slug", PERSONAL_CONTEXT_DEFAULTS.projectSlug).single();
      if (error) throw new Error(error.message);
      project = projectRecord(requireRow(data as Row, "project"));
    }

    let workbook = (await this.listWorkbooks(project.id, ownerId)).find(
      (candidate) => candidate.slug === PERSONAL_CONTEXT_DEFAULTS.workbookSlug,
    ) ?? null;
    if (!workbook) {
      await this.insertIgnoringDuplicate("workbooks", {
        id: randomUUID(), project_id: project.id,
        name: PERSONAL_CONTEXT_DEFAULTS.workbookName,
        slug: PERSONAL_CONTEXT_DEFAULTS.workbookSlug, position: 0,
      });
      const { data, error } = await this.db.from("workbooks").select()
        .eq("project_id", project.id)
        .eq("slug", PERSONAL_CONTEXT_DEFAULTS.workbookSlug).single();
      if (error) throw new Error(error.message);
      workbook = workbookRecord(requireRow(data as Row, "workbook"));
    }

    for (const environment of PERSONAL_CONTEXT_DEFAULTS.environments) {
      await this.insertIgnoringDuplicate("environments", {
        id: randomUUID(), project_id: project.id, name: environment.name,
        slug: environment.slug, kind: environment.kind,
      });
    }
    return {
      organization, workspace, project, workbook,
      environments: await this.listEnvironments(project.id, ownerId),
    };
  }

  async getProject(projectId: string, ownerId: string): Promise<ProjectRecord | null> {
    const workspace = await this.workspaceForOwner(ownerId);
    if (!workspace) return null;
    const { data, error } = await this.db.from("projects").select()
      .eq("id", projectId).eq("workspace_id", workspace.id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? projectRecord(data as Row) : null;
  }

  async listProjects(ownerId: string): Promise<ProjectRecord[]> {
    const workspace = await this.workspaceForOwner(ownerId);
    if (!workspace) return [];
    const { data, error } = await this.db.from("projects").select()
      .eq("workspace_id", workspace.id).order("created_at").order("id");
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => projectRecord(row as Row));
  }

  async getWorkbook(workbookId: string, ownerId: string): Promise<WorkbookRecord | null> {
    const { data, error } = await this.db.from("workbooks").select()
      .eq("id", workbookId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const record = workbookRecord(data as Row);
    return await this.getProject(record.projectId, ownerId) ? record : null;
  }

  async listWorkbooks(projectId: string, ownerId: string): Promise<WorkbookRecord[]> {
    if (!await this.getProject(projectId, ownerId)) return [];
    const { data, error } = await this.db.from("workbooks").select()
      .eq("project_id", projectId).order("position").order("created_at").order("id");
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => workbookRecord(row as Row));
  }

  async getEnvironment(environmentId: string, ownerId: string): Promise<EnvironmentRecord | null> {
    const { data, error } = await this.db.from("environments").select()
      .eq("id", environmentId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const record = environmentRecord(data as Row);
    return await this.getProject(record.projectId, ownerId) ? record : null;
  }

  async listEnvironments(projectId: string, ownerId: string): Promise<EnvironmentRecord[]> {
    if (!await this.getProject(projectId, ownerId)) return [];
    const { data, error } = await this.db.from("environments").select()
      .eq("project_id", projectId).order("created_at").order("id");
    if (error) throw new Error(error.message);
    const order: Record<EnvironmentKind, number> = { draft: 0, test: 1, live: 2 };
    return (data ?? []).map((row) => environmentRecord(row as Row))
      .sort((left, right) => order[left.kind] - order[right.kind] || left.id.localeCompare(right.id));
  }

  async bindFlow(flowId: string, context: PersonalContext): Promise<FlowProjectBinding | null> {
    const ownerId = context.organization.personalOwnerId;
    const { data, error } = await this.db.rpc("agent_studio_bind_flow", {
      p_flow_id: flowId,
      p_owner_id: ownerId,
      p_organization_id: context.organization.id,
      p_workspace_id: context.workspace.id,
      p_project_id: context.project.id,
      p_workbook_id: context.workbook.id,
    });
    if (error) throw new Error(error.message);
    return data ? bindingRecord(data as Row) : null;
  }

  async getFlowContext(flowId: string, ownerId: string) {
    if (!await this.ownsFlow(flowId, ownerId)) return null;
    const { data, error } = await this.db.from("flow_project_bindings").select()
      .eq("flow_id", flowId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const binding = bindingRecord(data as Row);
    const project = await this.getProject(binding.projectId, ownerId);
    const workbook = await this.getWorkbook(binding.workbookId, ownerId);
    const workspace = await this.workspaceForOwner(ownerId);
    const organization = await this.organizationForOwner(ownerId);
    if (!project || !workbook || !workspace || !organization) return null;
    return {
      binding, organization, workspace, project, workbook,
      environments: await this.listEnvironments(project.id, ownerId),
    };
  }

  async listWorkbookTabs(input: ListWorkbookTabsRepositoryInput): Promise<WorkbookFlowTab[] | null> {
    if (!await this.getWorkbook(input.workbookId, input.ownerId)) return null;
    const { data, error } = await this.db.from("workbook_flow_tabs").select()
      .eq("workbook_id", input.workbookId).order("position").order("id");
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => tabRecord(row as Row));
  }

  async renameWorkbookTab(input: RenameWorkbookTabRepositoryInput): Promise<WorkbookFlowTab | null> {
    const title = input.title.trim();
    if (title.length < 1 || title.length > 200) {
      throw new TypeError("Workbook tab title must contain 1 to 200 characters");
    }
    if (!await this.getWorkbook(input.workbookId, input.ownerId)) return null;
    const { data, error } = await this.db.from("workbook_flow_tabs")
      .update({ title, updated_at: new Date().toISOString() })
      .eq("id", input.tabId).eq("workbook_id", input.workbookId).select().maybeSingle();
    if (error) throw new Error(error.message);
    return data ? tabRecord(data as Row) : null;
  }

  async reorderWorkbookTabs(input: ReorderWorkbookTabsRepositoryInput): Promise<WorkbookFlowTab[] | null> {
    const { data, error } = await this.db.rpc("agent_studio_reorder_workbook_tabs", {
      p_workbook_id: input.workbookId,
      p_owner_id: input.ownerId,
      p_tab_ids: [...input.tabIds],
    });
    if (error) throw new Error(error.message);
    return data === null ? null : (data as Row[]).map(tabRecord);
  }

  private async dependencies(versionId: string): Promise<DependencyPin[]> {
    const { data, error } = await this.db.from("dependency_pins").select()
      .eq("flow_version_id", versionId).order("kind").order("resource_id").order("id");
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => dependencyRecord(row as Row)).sort(compareDependencyContent);
  }

  private async createVersionFromGraph(
    input: CreateFlowVersionRepositoryInput,
    graph: SupportedFlowGraph,
    dedupe: "semantic" | "exact",
    checkpoint = false,
  ): Promise<FlowVersionRecord> {
    await assertPinnedResourceDependenciesCurrent(
      graph,
      input.dependencies,
      this.resourceResolver(input.ownerId),
    );
    const semanticHash = hashFlowGraph(graph, { semantic: true }, input.dependencies);
    const fullHash = hashFlowGraph(graph, { semantic: false }, input.dependencies);
    if (input.label === undefined) {
      const column = dedupe === "exact" ? "full_hash" : "semantic_hash";
      const value = dedupe === "exact" ? fullHash : semanticHash;
      const { data, error } = await this.db.from("flow_versions").select()
        .eq("flow_id", input.flowId).eq(column, value)
        .order("version_number", { ascending: false }).order("id");
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        const pins = await this.dependencies(String(row.id));
        if (dependenciesEqual(input.dependencies, pins) &&
          (dedupe === "semantic" || String(row.full_hash) === fullHash)) {
          await assertPinnedResourceDependenciesCurrent(
            graph,
            input.dependencies,
            this.resourceResolver(input.ownerId),
          );
          return versionRecord(row as Row, pins);
        }
      }
    }
    const id = randomUUID();
    await assertPinnedResourceDependenciesCurrent(
      graph,
      input.dependencies,
      this.resourceResolver(input.ownerId),
    );
    const { data, error } = await this.db.rpc("agent_studio_create_flow_version", {
      p_flow_id: input.flowId,
      p_owner_id: input.ownerId,
      p_version_id: id,
      p_schema_version: "schemaVersion" in graph && graph.schemaVersion === 2
        ? 2
        : FLOW_SCHEMA_VERSION,
      p_label: input.label ?? null,
      p_description: input.description ?? null,
      p_graph: graph,
      p_flow_name: graph.name,
      p_semantic_hash: semanticHash,
      p_full_hash: fullHash,
      p_dependencies: input.dependencies.map((pin) => ({
        kind: pin.kind,
        resource_id: pin.resourceId,
        version: pin.version,
        content_hash: pin.contentHash ?? null,
      })),
      p_checkpoint: checkpoint,
    });
    if (error) throwVersionRpcError(error);
    const row = requireRow(data as Row, "flow version");
    const persistedId = String(row.id);
    const persistedDependencies = await this.dependencies(persistedId);
    await assertPinnedResourceDependenciesCurrent(
      graph,
      persistedDependencies,
      this.resourceResolver(input.ownerId),
    );
    return versionRecord(row, persistedDependencies);
  }

  async createFlowVersion(input: CreateFlowVersionRepositoryInput): Promise<FlowVersionRecord | null> {
    rejectCallerResourceDependencies(input.dependencies);
    const normalized = normalizeVersionCreationInput(input);
    const { data, error } = await this.db.from("flows").select("graph")
      .eq("id", normalized.flowId).eq("owner_id", normalized.ownerId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const graph = parseGraph(data.graph);
    if (hasUnsupportedVersionReference(graph)) {
      throw new FlowVersionMutationError({ status: "invalid-reference" });
    }
    const dependencies = normalizeDependencyPins([
      ...normalized.dependencies,
      ...await derivePinnedResourceDependencies(graph, this.resourceResolver(normalized.ownerId)),
    ]);
    return this.createVersionFromGraph({ ...normalized, dependencies }, graph, "semantic");
  }

  async createFlowCheckpoint(input: CreateFlowCheckpointRepositoryInput): Promise<FlowVersionRecord | null> {
    rejectCallerResourceDependencies(input.dependencies);
    if (!await this.ownsFlow(input.flowId, input.ownerId)) return null;
    if (input.impactReceipt !== undefined || !mutationValueWithinBudget(input.graph)) {
      throw new FlowVersionMutationError({ status: "invalid-reference" });
    }
    const graph = parseGraph(input.graph);
    if (hasUnsupportedVersionReference(graph)) {
      throw new FlowVersionMutationError({ status: "invalid-reference" });
    }
    const normalized = normalizeVersionCreationInput(input);
    const dependencies = normalizeDependencyPins([
      ...normalized.dependencies,
      ...await derivePinnedResourceDependencies(graph, this.resourceResolver(normalized.ownerId)),
    ]);
    return this.createVersionFromGraph(
      { ...normalized, dependencies },
      graph,
      "exact",
      true,
    );
  }

  async getFlowVersion(input: GetFlowVersionRepositoryInput): Promise<FlowVersionRecord | null> {
    if (!await this.ownsFlow(input.flowId, input.ownerId)) return null;
    const { data, error } = await this.db.from("flow_versions").select()
      .eq("id", input.versionId).eq("flow_id", input.flowId).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? versionRecord(data as Row, await this.dependencies(input.versionId)) : null;
  }

  async listFlowVersions(input: ListFlowVersionsRepositoryInput): Promise<FlowVersionSummary[]> {
    if (!await this.ownsFlow(input.flowId, input.ownerId)) return [];
    const { data, error } = await this.db.from("flow_versions").select()
      .eq("flow_id", input.flowId).order("version_number", { ascending: false }).order("id");
    if (error) throw new Error(error.message);
    return Promise.all((data ?? []).map(async (row): Promise<FlowVersionSummary> => ({
      id: String(row.id), flowId: String(row.flow_id), versionNumber: Number(row.version_number),
      schemaVersion: Number(row.schema_version),
      ...(row.label === null ? {} : { label: String(row.label) }),
      ...(row.description === null ? {} : { description: String(row.description) }),
      semanticHash: String(row.semantic_hash), fullHash: String(row.full_hash),
      createdBy: String(row.created_by), createdAt: timeMs(row.created_at),
      dependencyCount: (await this.dependencies(String(row.id))).length,
    })));
  }

  async getActiveDeployment(input: GetActiveDeploymentRepositoryInput): Promise<DeploymentRecord | null> {
    if (!await this.ownsFlow(input.flowId, input.ownerId)) return null;
    const { data, error } = await this.db.from("deployments").select()
      .eq("flow_id", input.flowId).eq("status", input.environmentKind)
      .is("retired_at", null).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const environment = await this.getEnvironment(String(data.environment_id), input.ownerId);
    return environment?.kind === input.environmentKind ? deploymentRecord(data as Row) : null;
  }

  async listActiveDeploymentsForFlows(
    input: ListActiveDeploymentsForFlowsRepositoryInput,
  ): Promise<DeploymentRecord[]> {
    const ownerByFlow = new Map(input.flows.map(({ flowId, ownerId }) => [flowId, ownerId]));
    const flowIds = [...ownerByFlow.keys()];
    if (flowIds.length === 0) return [];

    // Embed the owning flow so authorization and active deployment state are
    // checked in one PostgREST read. Throwing on an uncertain relation makes
    // buildCatalog use its exact per-agent fallback instead of treating an
    // unreadable active row as permission to expose a mutable Draft.
    const { data, error } = await this.db
      .from("deployments")
      .select("*, flow:flows!inner(owner_id)")
      .in("flow_id", flowIds)
      .eq("status", input.environmentKind)
      .is("retired_at", null);
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => {
      const flow = row.flow;
      if (flow === null || typeof flow !== "object" || Array.isArray(flow)) {
        throw new Error("Invalid active deployment flow relation");
      }
      const flowId = String(row.flow_id);
      if (ownerByFlow.get(flowId) !== String(Reflect.get(flow, "owner_id"))) {
        throw new Error("Active deployment ownership changed during catalog read");
      }
      const deployment = deploymentRecord(row as Row);
      if (!deployment) throw new Error("Invalid active deployment row");
      return deployment;
    });
  }

  async listDeployments(input: ListDeploymentsRepositoryInput): Promise<DeploymentRecord[]> {
    if (!await this.ownsFlow(input.flowId, input.ownerId)) return [];
    const { data, error } = await this.db.from("deployments").select()
      .eq("flow_id", input.flowId).order("created_at", { ascending: false }).order("id", { ascending: false });
    if (error) throw new Error(error.message);
    const out: DeploymentRecord[] = [];
    for (const row of data ?? []) {
      const environment = await this.getEnvironment(String(row.environment_id), input.ownerId);
      const hydrated = environment ? deploymentRecord(row as Row) : null;
      if (hydrated) out.push(hydrated);
    }
    return out;
  }

  async deployVersion(input: DeployVersionRepositoryInput): Promise<DeployVersionRepositoryResult> {
    const version = await this.getFlowVersion({
      flowId: input.flowId, versionId: input.versionId, ownerId: input.ownerId,
    });
    if (!version) return { status: "not-found" };
    if (graphContainsApiOperation(version.graph)) return { status: API_OPERATION_LIVE_UNAVAILABLE };
    const { data, error } = await this.db.rpc("agent_studio_deploy_version", {
      p_flow_id: input.flowId,
      p_version_id: input.versionId,
      p_version_semantic_hash: input.versionSemanticHash,
      p_version_full_hash: input.versionFullHash,
      p_environment_id: input.environmentId,
      p_environment_kind: input.environmentKind,
      p_expected_active_deployment_id: input.expectedActiveDeploymentId,
      p_source_test_deployment_id: input.sourceTestDeploymentId,
      p_confirmation: input.confirmation,
      p_owner_id: input.ownerId,
    });
    if (error) throw new Error(error.message);
    const result = data as { status?: unknown; deployment?: Row } | null;
    const status = result?.status;
    if (status === "not-found" || status === "conflict" || status === "invalid-request") {
      return { status };
    }
    if (status !== "deployed" || !result?.deployment) return { status: "conflict" };
    const deployment = deploymentRecord(result.deployment);
    return deployment ? { status: "deployed", deployment } : { status: "conflict" };
  }

  async retireDeployment(input: RetireDeploymentRepositoryInput): Promise<DeploymentRecord | null> {
    const { data, error } = await this.db.from("deployments").select()
      .eq("id", input.deploymentId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || !await this.ownsFlow(String(data.flow_id), input.ownerId)) return null;
    const existing = deploymentRecord(data as Row);
    if (!existing || existing.status === "retired") return existing;
    const retiredAt = new Date().toISOString();
    const { data: updated, error: updateError } = await this.db.from("deployments")
      .update({ status: "retired", retired_at: retiredAt }).eq("id", input.deploymentId)
      .is("retired_at", null).select().maybeSingle();
    if (updateError) throw new Error(updateError.message);
    if (updated) return deploymentRecord(updated as Row);

    // A concurrent retirement can win between the initial read and our
    // compare-and-set update. Re-read the same owned deployment so retries are
    // idempotent and return the winning retired record.
    const { data: winner, error: winnerError } = await this.db.from("deployments")
      .select().eq("id", input.deploymentId).maybeSingle();
    if (winnerError) throw new Error(winnerError.message);
    if (!winner || String(winner.flow_id) !== existing.flowId) return null;
    const retired = deploymentRecord(winner as Row);
    return retired?.status === "retired" ? retired : null;
  }

  async restoreActiveDeployment(
    input: RestoreActiveDeploymentRepositoryInput,
  ): Promise<DeploymentRecord | null> {
    const { data, error } = await this.db.rpc("agent_studio_restore_active_deployment", {
      p_deployment_id: input.deploymentId,
      p_expected_active_deployment_id: input.expectedActiveDeploymentId,
      p_owner_id: input.ownerId,
    });
    if (error) throw new Error(error.message);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return deploymentRecord(data as Row);
  }
}
