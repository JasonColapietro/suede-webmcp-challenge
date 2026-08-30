import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { isFlowGraphV2 } from "@/lib/flow/graph-schema";
import { mutationValueWithinBudget } from "@/lib/flow/flow-mutation-service";
import type { FlowMutationResult } from "@/lib/flow/flow-mutation-service";
import { normalizeSubflowReference } from "@/lib/flow/subflow-reference";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { hashFlowGraph } from "./hash";
import { PERSONAL_CONTEXT_DEFAULTS } from "./personal-context";
import { FLOW_SCHEMA_VERSION } from "./types";
import { FlowVersionMutationError } from "./version-mutation-error";
import {
  rejectCallerFlowDependencies,
} from "./subflow-dependencies";
import {
  assertPinnedConnectorDependenciesCurrent,
  mergeServerDerivedDependencies,
  rejectCallerConnectorDependencies,
} from "./connector-dependencies";
import { createTransactionLocalOperationClosureReader } from "@/lib/connectors/sqlite-repository";
import {
  assertPinnedResourceDependenciesCurrentSync,
  createSqliteOwnerScopedResourcePackResolver,
  derivePinnedResourceDependenciesSync,
  rejectCallerResourceDependencies,
  type OwnerScopedResourcePackResolver,
} from "./resource-dependencies";
import {
  compareDependencyContent,
  normalizeDependencyPins,
  normalizeVersionCreationInput,
  requireVersionText,
} from "./version-input";
import type {
  CreateFlowCheckpointRepositoryInput,
  CreateFlowVersionRepositoryInput,
  DeployVersionRepositoryInput,
  FlowProjectContext,
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
  DependencyKind,
  DeploymentRecord,
  EnvironmentKind,
  EnvironmentRecord,
  FlowProjectBinding,
  FlowVersionRecord,
  FlowVersionSummary,
  OrganizationRecord,
  PersonalContext,
  ProjectRecord,
  WorkbookRecord,
  WorkbookFlowTab,
  WorkspaceRecord,
} from "./types";
import { API_OPERATION_LIVE_UNAVAILABLE, graphContainsApiOperation } from "@/lib/connectors/operation-closure";
import { inspectVersionClosure, inspectVersionClosureSync } from "./version-closure";
import {
  isEnvironmentKind,
  isFlowLifecycle,
  parseEnvironmentKind,
} from "./types";

interface OrganizationRow {
  id: string;
  personal_owner_id: string;
  name: string;
  kind: "personal" | "team";
  created_at: number;
}

interface WorkspaceRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  created_at: number;
}

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  created_at: number;
  updated_at: number;
}

interface WorkbookRow {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  position: number;
  created_at: number;
}

interface WorkbookFlowTabRow {
  id: string;
  workbook_id: string;
  flow_id: string;
  title: string;
  position: number;
  created_at: number;
  updated_at: number;
}

interface EnvironmentRow {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  kind: EnvironmentKind;
  created_at: number;
}

interface BindingRow {
  flow_id: string;
  project_id: string;
  workbook_id: string;
  created_at: number;
}

interface FlowVersionRow {
  id: string;
  flow_id: string;
  version_number: number;
  schema_version: number;
  label: string | null;
  description: string | null;
  graph: string;
  semantic_hash: string;
  full_hash: string;
  created_by: string;
  created_at: number;
}

interface FlowVersionSummaryRow extends FlowVersionRow {
  dependency_count: number;
}

interface DependencyPinRow {
  id: string;
  flow_version_id: string;
  kind: DependencyKind;
  resource_id: string;
  version: string;
  content_hash: string | null;
  created_at: number;
}

interface PersistedFlowRow {
  graph: string;
  name: string;
}

function refusesImmutableTypedDraft(graph: SupportedFlowGraph): boolean {
  if (!isFlowGraphV2(graph)) return false;
  for (const node of graph.nodes) {
    if (node.type !== "subflow" && node.type !== "loop") continue;
    try {
      const normalized = normalizeSubflowReference(node.params);
      if (normalized.kind === "typed" && normalized.reference.kind === "draft") return true;
    } catch {
      return true;
    }
  }
  return false;
}

function requireVersionableGraph(graph: SupportedFlowGraph): void {
  if (refusesImmutableTypedDraft(graph)) {
    throw new FlowVersionMutationError({ status: "invalid-reference" });
  }
}

function throwVersionMutation(result: Exclude<FlowMutationResult, { status: "saved" }>): never {
  if (result.status === "not-found") throw new Error("unreachable private not-found");
  throw new FlowVersionMutationError(result);
}

interface DeploymentRow {
  id: string;
  flow_id: string;
  flow_version_id: string;
  environment_id: string;
  status: string;
  created_at: number;
  retired_at: number | null;
}

interface DeploymentTargetRow {
  environment_project_id: string;
  environment_kind: string;
  semantic_hash: string;
  full_hash: string;
  workbook_project_id: string;
  graph: string;
}

const WAL_INITIALIZATION_TIMEOUT_MS = 5_000;
const WAL_RETRY_MAX_DELAY_MS = 100;
const walRetrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function isSqliteLockError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function enableWalWithBoundedRetry(db: Database.Database): void {
  const deadline = Date.now() + WAL_INITIALIZATION_TIMEOUT_MS;
  let retryDelay = 5;
  while (true) {
    try {
      const current = db.pragma("journal_mode", { simple: true }) as unknown;
      if (
        typeof current === "string" &&
        (current.toLowerCase() === "wal" || current.toLowerCase() === "memory")
      ) {
        return;
      }
      const configured = db.pragma("journal_mode = WAL", { simple: true }) as unknown;
      if (typeof configured === "string" && configured.toLowerCase() === "wal") return;
      throw new Error(`SQLite WAL initialization returned ${String(configured)}`);
    } catch (error) {
      if (!isSqliteLockError(error)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `SQLite WAL initialization timed out after ${WAL_INITIALIZATION_TIMEOUT_MS}ms`,
          { cause: error },
        );
      }
      Atomics.wait(walRetrySignal, 0, 0, Math.min(retryDelay, remaining));
      retryDelay = Math.min(retryDelay * 2, WAL_RETRY_MAX_DELAY_MS);
    }
  }
}

function requireRow<Row>(row: Row | undefined, resource: string): Row {
  if (!row) throw new Error(`Personal context invariant failed: missing ${resource}`);
  return row;
}

function organizationRecord(row: OrganizationRow): OrganizationRecord {
  return {
    id: row.id,
    personalOwnerId: row.personal_owner_id,
    name: row.name,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

function workspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
  };
}

function projectRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workbookRecord(row: WorkbookRow): WorkbookRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    slug: row.slug,
    position: row.position,
    createdAt: row.created_at,
  };
}

function workbookFlowTabRecord(row: WorkbookFlowTabRow): WorkbookFlowTab {
  return {
    id: row.id,
    workbookId: row.workbook_id,
    flowId: row.flow_id,
    title: row.title,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function environmentRecord(row: EnvironmentRow): EnvironmentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

function bindingRecord(row: BindingRow): FlowProjectBinding {
  return {
    flowId: row.flow_id,
    projectId: row.project_id,
    workbookId: row.workbook_id,
    createdAt: row.created_at,
  };
}

function deploymentRecord(row: DeploymentRow): DeploymentRecord | null {
  if (!isFlowLifecycle(row.status)) return null;
  if ((row.status === "retired") !== (row.retired_at !== null)) return null;
  return {
    id: row.id,
    flowId: row.flow_id,
    flowVersionId: row.flow_version_id,
    environmentId: row.environment_id,
    status: row.status,
    createdAt: row.created_at,
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
  };
}

function dependencyPinRecord(row: DependencyPinRow): DependencyPin {
  return {
    id: row.id,
    flowVersionId: row.flow_version_id,
    kind: row.kind,
    resourceId: row.resource_id,
    version: row.version,
    ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
    createdAt: row.created_at,
  };
}

function parsePersistedGraph(serialized: string): SupportedFlowGraph {
  if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) {
    throw new Error("Invalid persisted flow graph");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Invalid persisted flow graph");
  }
  try {
    if (!mutationValueWithinBudget(raw)) throw new Error("budget");
    parseSupportedFlowGraph(raw);
    const snapshot: unknown = JSON.parse(JSON.stringify(raw));
    parseSupportedFlowGraph(snapshot);
    return snapshot as SupportedFlowGraph;
  } catch {
    throw new Error("Invalid persisted flow graph");
  }
}

function dependencyInputsEqual(
  expected: readonly DependencyPinInput[],
  actual: readonly DependencyPin[],
): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((dependency, index) => {
    const pin = actual[index];
    return (
      dependency.kind === pin.kind &&
      dependency.resourceId === pin.resourceId &&
      dependency.version === pin.version &&
      (dependency.contentHash ?? null) === (pin.contentHash ?? null)
    );
  });
}

function flowVersionSummary(row: FlowVersionSummaryRow): FlowVersionSummary {
  return {
    id: row.id,
    flowId: row.flow_id,
    versionNumber: row.version_number,
    schemaVersion: row.schema_version,
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.description === null ? {} : { description: row.description }),
    semanticHash: row.semantic_hash,
    fullHash: row.full_hash,
    createdBy: row.created_by,
    createdAt: row.created_at,
    dependencyCount: row.dependency_count,
  };
}

export class SqliteProjectRepo implements ProjectRepo {
  private readonly db: Database.Database;
  private readonly injectedResourceResolver?: OwnerScopedResourcePackResolver;

  constructor(
    source: string | Database.Database = "studio.db",
    options: { readonly resolveResourcePack?: OwnerScopedResourcePackResolver } = {},
  ) {
    this.db = typeof source === "string" ? new Database(source) : source;
    this.injectedResourceResolver = options.resolveResourcePack;
    this.db.pragma("busy_timeout = 5000");
    if (typeof source === "string") enableWalWithBoundedRetry(this.db);
    runSqliteMigrations(this.db);
  }

  private resourceResolver(ownerId: string): OwnerScopedResourcePackResolver {
    return this.injectedResourceResolver ?? createSqliteOwnerScopedResourcePackResolver(this.db, ownerId);
  }

  async ownsFlow(flowId: string, ownerId: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 AS owned FROM flows WHERE id = ? AND owner_id = ?")
      .get(flowId, ownerId) as { owned: number } | undefined;
    return row?.owned === 1;
  }

  async ensurePersonalContext(ownerId: string): Promise<PersonalContext> {
    if (ownerId.trim().length === 0) throw new TypeError("ownerId is required");
    const ensure = this.db.transaction((personalOwnerId: string): PersonalContext => {
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO organizations (id, personal_owner_id, name, kind, created_at)
           VALUES (?, ?, ?, 'personal', ?)
           ON CONFLICT(personal_owner_id) DO NOTHING`,
        )
        .run(randomUUID(), personalOwnerId, PERSONAL_CONTEXT_DEFAULTS.organizationName, now);
      const organization = requireRow(
        this.db
          .prepare("SELECT * FROM organizations WHERE personal_owner_id = ?")
          .get(personalOwnerId) as OrganizationRow | undefined,
        "organization",
      );

      this.db
        .prepare(
          `INSERT INTO workspaces (id, organization_id, name, slug, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(organization_id, slug) DO NOTHING`,
        )
        .run(
          randomUUID(),
          organization.id,
          PERSONAL_CONTEXT_DEFAULTS.workspaceName,
          PERSONAL_CONTEXT_DEFAULTS.workspaceSlug,
          now,
        );
      const workspace = requireRow(
        this.db
          .prepare("SELECT * FROM workspaces WHERE organization_id = ? AND slug = ?")
          .get(organization.id, PERSONAL_CONTEXT_DEFAULTS.workspaceSlug) as WorkspaceRow | undefined,
        "workspace",
      );

      this.db
        .prepare(
          `INSERT INTO projects (id, workspace_id, name, slug, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, slug) DO NOTHING`,
        )
        .run(
          randomUUID(),
          workspace.id,
          PERSONAL_CONTEXT_DEFAULTS.projectName,
          PERSONAL_CONTEXT_DEFAULTS.projectSlug,
          now,
          now,
        );
      const project = requireRow(
        this.db
          .prepare("SELECT * FROM projects WHERE workspace_id = ? AND slug = ?")
          .get(workspace.id, PERSONAL_CONTEXT_DEFAULTS.projectSlug) as ProjectRow | undefined,
        "project",
      );

      this.db
        .prepare(
          `INSERT INTO workbooks (id, project_id, name, slug, position, created_at)
           VALUES (?, ?, ?, ?, 0, ?)
           ON CONFLICT(project_id, slug) DO NOTHING`,
        )
        .run(
          randomUUID(),
          project.id,
          PERSONAL_CONTEXT_DEFAULTS.workbookName,
          PERSONAL_CONTEXT_DEFAULTS.workbookSlug,
          now,
        );
      const workbook = requireRow(
        this.db
          .prepare("SELECT * FROM workbooks WHERE project_id = ? AND slug = ?")
          .get(project.id, PERSONAL_CONTEXT_DEFAULTS.workbookSlug) as WorkbookRow | undefined,
        "workbook",
      );

      for (const environment of PERSONAL_CONTEXT_DEFAULTS.environments) {
        this.db
          .prepare(
            `INSERT INTO environments (id, project_id, name, slug, kind, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id, slug) DO NOTHING`,
          )
          .run(randomUUID(), project.id, environment.name, environment.slug, environment.kind, now);
      }

      return {
        organization: organizationRecord(organization),
        workspace: workspaceRecord(workspace),
        project: projectRecord(project),
        workbook: workbookRecord(workbook),
        environments: this.listEnvironmentsSync(project.id, personalOwnerId),
      };
    });
    return ensure.immediate(ownerId);
  }

  async getProject(projectId: string, ownerId: string): Promise<ProjectRecord | null> {
    const row = this.db
      .prepare(
        `SELECT p.* FROM projects p
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organizations o ON o.id = w.organization_id
         WHERE p.id = ? AND o.personal_owner_id = ?`,
      )
      .get(projectId, ownerId) as ProjectRow | undefined;
    return row ? projectRecord(row) : null;
  }

  async listProjects(ownerId: string): Promise<ProjectRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM projects p
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organizations o ON o.id = w.organization_id
         WHERE o.personal_owner_id = ?
         ORDER BY p.created_at, p.id`,
      )
      .all(ownerId) as ProjectRow[];
    return rows.map(projectRecord);
  }

  async getWorkbook(workbookId: string, ownerId: string): Promise<WorkbookRecord | null> {
    const row = this.db
      .prepare(
        `SELECT wb.* FROM workbooks wb
         JOIN projects p ON p.id = wb.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organizations o ON o.id = w.organization_id
         WHERE wb.id = ? AND o.personal_owner_id = ?`,
      )
      .get(workbookId, ownerId) as WorkbookRow | undefined;
    return row ? workbookRecord(row) : null;
  }

  async listWorkbooks(projectId: string, ownerId: string): Promise<WorkbookRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT wb.* FROM workbooks wb
         JOIN projects p ON p.id = wb.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organizations o ON o.id = w.organization_id
         WHERE wb.project_id = ? AND o.personal_owner_id = ?
         ORDER BY wb.position, wb.created_at, wb.id`,
      )
      .all(projectId, ownerId) as WorkbookRow[];
    return rows.map(workbookRecord);
  }

  async getEnvironment(environmentId: string, ownerId: string): Promise<EnvironmentRecord | null> {
    const row = this.db
      .prepare(
        `SELECT e.* FROM environments e
         JOIN projects p ON p.id = e.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organizations o ON o.id = w.organization_id
         WHERE e.id = ? AND o.personal_owner_id = ?`,
      )
      .get(environmentId, ownerId) as EnvironmentRow | undefined;
    return row ? environmentRecord(row) : null;
  }

  async listEnvironments(projectId: string, ownerId: string): Promise<EnvironmentRecord[]> {
    return this.listEnvironmentsSync(projectId, ownerId);
  }

  async listWorkbookTabs(
    input: ListWorkbookTabsRepositoryInput,
  ): Promise<WorkbookFlowTab[] | null> {
    const list = this.db.transaction((): WorkbookFlowTab[] | null => {
      if (!this.ownsWorkbookSync(input.workbookId, input.ownerId)) return null;
      this.assertWorkbookTabInvariant(input.workbookId);
      return this.listWorkbookTabRowsSync(input.workbookId, input.ownerId).map(
        workbookFlowTabRecord,
      );
    });
    return list.immediate();
  }

  async renameWorkbookTab(
    input: RenameWorkbookTabRepositoryInput,
  ): Promise<WorkbookFlowTab | null> {
    const title = input.title.trim();
    if (title.length < 1 || title.length > 200) {
      throw new TypeError("Workbook tab title must contain 1 to 200 characters");
    }
    const rename = this.db.transaction((): WorkbookFlowTab | null => {
      if (!this.ownsWorkbookSync(input.workbookId, input.ownerId)) return null;
      const updatedAt = Date.now();
      const result = this.db
        .prepare(
          `UPDATE workbook_flow_tabs AS t
           SET title = ?, updated_at = ?
           WHERE t.id = ?
             AND t.workbook_id = ?
             AND EXISTS (
               SELECT 1
               FROM flows f
               JOIN flow_project_bindings b
                 ON b.flow_id = f.id
                AND b.workbook_id = t.workbook_id
               JOIN workbooks wb
                 ON wb.id = b.workbook_id
                AND wb.id = t.workbook_id
               JOIN projects p
                 ON p.id = b.project_id
                AND p.id = wb.project_id
               JOIN workspaces w ON w.id = p.workspace_id
               JOIN organizations o ON o.id = w.organization_id
               WHERE f.id = t.flow_id
                 AND f.owner_id = ?
                 AND o.personal_owner_id = ?
             )`,
        )
        .run(title, updatedAt, input.tabId, input.workbookId, input.ownerId, input.ownerId);
      if (result.changes !== 1) return null;
      this.assertWorkbookTabInvariant(input.workbookId);
      const row = this.listWorkbookTabRowsSync(input.workbookId, input.ownerId).find(
        (candidate) => candidate.id === input.tabId,
      );
      if (!row) throw new Error("Workbook tab changed during rename");
      return workbookFlowTabRecord(row);
    });
    return rename.immediate();
  }

  async reorderWorkbookTabs(
    input: ReorderWorkbookTabsRepositoryInput,
  ): Promise<WorkbookFlowTab[] | null> {
    const reorder = this.db.transaction((): WorkbookFlowTab[] | null => {
      if (!this.ownsWorkbookSync(input.workbookId, input.ownerId)) return null;
      this.assertWorkbookTabInvariant(input.workbookId);
      const current = this.listWorkbookTabRowsSync(input.workbookId, input.ownerId);
      const currentIds = current.map((tab) => tab.id).sort();
      const requestedIds = [...input.tabIds];
      const uniqueRequestedIds = new Set(requestedIds);
      if (
        uniqueRequestedIds.size !== requestedIds.length ||
        requestedIds.length !== currentIds.length ||
        [...uniqueRequestedIds].sort().some((id, index) => id !== currentIds[index])
      ) {
        return null;
      }

      const updatedAt = Date.now();
      const staged = this.db
        .prepare(
          `UPDATE workbook_flow_tabs AS t
           SET position = -(position + 1), updated_at = ?
           WHERE t.workbook_id = ?
             AND EXISTS (
               SELECT 1
               FROM flows f
               JOIN flow_project_bindings b
                 ON b.flow_id = f.id
                AND b.workbook_id = t.workbook_id
               JOIN workbooks wb
                 ON wb.id = b.workbook_id
                AND wb.id = t.workbook_id
               JOIN projects p
                 ON p.id = b.project_id
                AND p.id = wb.project_id
               JOIN workspaces w ON w.id = p.workspace_id
               JOIN organizations o ON o.id = w.organization_id
               WHERE f.id = t.flow_id
                 AND f.owner_id = ?
                 AND o.personal_owner_id = ?
             )`,
        )
        .run(updatedAt, input.workbookId, input.ownerId, input.ownerId);
      if (staged.changes !== current.length) {
        throw new Error("Workbook tab invariant failed during reorder staging");
      }

      const update = this.db.prepare(
        `UPDATE workbook_flow_tabs AS t
         SET position = ?, updated_at = ?
         WHERE t.id = ?
           AND t.workbook_id = ?
           AND EXISTS (
             SELECT 1
             FROM flows f
             JOIN flow_project_bindings b
               ON b.flow_id = f.id
              AND b.workbook_id = t.workbook_id
             JOIN workbooks wb
               ON wb.id = b.workbook_id
              AND wb.id = t.workbook_id
             JOIN projects p
               ON p.id = b.project_id
              AND p.id = wb.project_id
             JOIN workspaces w ON w.id = p.workspace_id
             JOIN organizations o ON o.id = w.organization_id
             WHERE f.id = t.flow_id
               AND f.owner_id = ?
               AND o.personal_owner_id = ?
           )`,
      );
      requestedIds.forEach((tabId, position) => {
        const result = update.run(
          position,
          updatedAt,
          tabId,
          input.workbookId,
          input.ownerId,
          input.ownerId,
        );
        if (result.changes !== 1) {
          throw new Error("Workbook tab invariant failed during reorder finalization");
        }
      });
      this.assertWorkbookTabInvariant(input.workbookId);
      return this.listWorkbookTabRowsSync(input.workbookId, input.ownerId).map(
        workbookFlowTabRecord,
      );
    });
    return reorder.immediate();
  }

  async bindFlow(
    flowId: string,
    context: PersonalContext,
  ): Promise<FlowProjectBinding | null> {
    const bind = this.db.transaction((): FlowProjectBinding | null => {
      const ownership = this.db
        .prepare(
          `SELECT f.owner_id AS flow_owner_id, f.name AS flow_name,
                  o.personal_owner_id AS context_owner_id
           FROM flows f
           JOIN organizations o ON o.id = ?
           JOIN workspaces w ON w.id = ? AND w.organization_id = o.id
           JOIN projects p ON p.id = ? AND p.workspace_id = w.id
           JOIN workbooks wb ON wb.id = ? AND wb.project_id = p.id
           WHERE f.id = ?`,
        )
        .get(
          context.organization.id,
          context.workspace.id,
          context.project.id,
          context.workbook.id,
          flowId,
        ) as
        | { flow_owner_id: string; flow_name: string; context_owner_id: string }
        | undefined;
      if (!ownership || ownership.flow_owner_id !== ownership.context_owner_id) return null;

      const existing = this.getBindingRow(flowId);
      if (existing) {
        if (
          existing.project_id !== context.project.id ||
          existing.workbook_id !== context.workbook.id
        ) {
          return null;
        }
        try {
          this.assertWorkbookTabInvariant(context.workbook.id);
        } catch {
          return null;
        }
        const tab = this.db
          .prepare(
            `SELECT t.id
             FROM workbook_flow_tabs t
             WHERE t.flow_id = ? AND t.workbook_id = ?`,
          )
          .get(flowId, context.workbook.id);
        return tab ? bindingRecord(existing) : null;
      }

      try {
        this.assertWorkbookTabInvariant(context.workbook.id);
      } catch {
        return null;
      }

      const createdAt = Date.now();
      this.db
        .prepare(
          `INSERT INTO flow_project_bindings (flow_id, project_id, workbook_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(flowId, context.project.id, context.workbook.id, createdAt);
      const nextPosition = (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(position), -1) + 1 AS position
             FROM workbook_flow_tabs WHERE workbook_id = ?`,
          )
          .get(context.workbook.id) as { position: number }
      ).position;
      const title =
        nextPosition === 0 ? "Main" : ownership.flow_name.trim() || `Flow ${nextPosition + 1}`;
      this.db
        .prepare(
          `INSERT INTO workbook_flow_tabs
            (id, workbook_id, flow_id, title, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          context.workbook.id,
          flowId,
          title,
          nextPosition,
          createdAt,
          createdAt,
        );
      this.assertWorkbookTabInvariant(context.workbook.id);
      return bindingRecord(requireRow(this.getBindingRow(flowId), "flow binding"));
    });
    return bind.immediate();
  }

  async getFlowContext(flowId: string, ownerId: string): Promise<FlowProjectContext | null> {
    const row = this.db
      .prepare(
        `SELECT
           b.flow_id AS b_flow_id, b.project_id AS b_project_id,
           b.workbook_id AS b_workbook_id, b.created_at AS b_created_at,
           o.id AS o_id, o.personal_owner_id AS o_owner_id, o.name AS o_name,
           o.kind AS o_kind, o.created_at AS o_created_at,
           w.id AS w_id, w.organization_id AS w_organization_id, w.name AS w_name,
           w.slug AS w_slug, w.created_at AS w_created_at,
           p.id AS p_id, p.workspace_id AS p_workspace_id, p.name AS p_name,
           p.slug AS p_slug, p.created_at AS p_created_at, p.updated_at AS p_updated_at,
           wb.id AS wb_id, wb.project_id AS wb_project_id, wb.name AS wb_name,
           wb.slug AS wb_slug, wb.position AS wb_position, wb.created_at AS wb_created_at
         FROM flow_project_bindings b
         JOIN flows f ON f.id = b.flow_id AND f.owner_id = ?
         JOIN projects p ON p.id = b.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organizations o ON o.id = w.organization_id AND o.personal_owner_id = ?
         JOIN workbooks wb ON wb.id = b.workbook_id AND wb.project_id = p.id
         WHERE b.flow_id = ?`,
      )
      .get(ownerId, ownerId, flowId) as
      | {
          b_flow_id: string;
          b_project_id: string;
          b_workbook_id: string;
          b_created_at: number;
          o_id: string;
          o_owner_id: string;
          o_name: string;
          o_kind: "personal" | "team";
          o_created_at: number;
          w_id: string;
          w_organization_id: string;
          w_name: string;
          w_slug: string;
          w_created_at: number;
          p_id: string;
          p_workspace_id: string;
          p_name: string;
          p_slug: string;
          p_created_at: number;
          p_updated_at: number;
          wb_id: string;
          wb_project_id: string;
          wb_name: string;
          wb_slug: string;
          wb_position: number;
          wb_created_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      binding: {
        flowId: row.b_flow_id,
        projectId: row.b_project_id,
        workbookId: row.b_workbook_id,
        createdAt: row.b_created_at,
      },
      organization: {
        id: row.o_id,
        personalOwnerId: row.o_owner_id,
        name: row.o_name,
        kind: row.o_kind,
        createdAt: row.o_created_at,
      },
      workspace: {
        id: row.w_id,
        organizationId: row.w_organization_id,
        name: row.w_name,
        slug: row.w_slug,
        createdAt: row.w_created_at,
      },
      project: {
        id: row.p_id,
        workspaceId: row.p_workspace_id,
        name: row.p_name,
        slug: row.p_slug,
        createdAt: row.p_created_at,
        updatedAt: row.p_updated_at,
      },
      workbook: {
        id: row.wb_id,
        projectId: row.wb_project_id,
        name: row.wb_name,
        slug: row.wb_slug,
        position: row.wb_position,
        createdAt: row.wb_created_at,
      },
      environments: this.listEnvironmentsSync(row.p_id, ownerId),
    };
  }

  async createFlowVersion(
    input: CreateFlowVersionRepositoryInput,
  ): Promise<FlowVersionRecord | null> {
    rejectCallerFlowDependencies(input.dependencies);
    rejectCallerConnectorDependencies(input.dependencies);
    rejectCallerResourceDependencies(input.dependencies);
    const normalizedInput = normalizeVersionCreationInput(input);
    const create = this.db.transaction((): FlowVersionRecord | FlowMutationResult | null => {
      const flow = this.db
        .prepare("SELECT name, graph FROM flows WHERE id = ? AND owner_id = ?")
        .get(normalizedInput.flowId, normalizedInput.ownerId) as PersistedFlowRow | undefined;
      if (!flow) return null;

      let snapshot: SupportedFlowGraph;
      try {
        snapshot = parsePersistedGraph(flow.graph);
      } catch {
        throw new FlowVersionMutationError({ status: "invalid-reference" });
      }
      requireVersionableGraph(snapshot);
      const validation = new SqliteRepo(this.db).mutateFlowInCurrentTransaction({
        id: normalizedInput.flowId,
        mustExist: true,
        validateOnly: true,
        ownerId: normalizedInput.ownerId,
        name: flow.name,
        graph: snapshot,
      });
      if (validation.status !== "saved") return validation;
      const snapshotJson = JSON.stringify(snapshot);
      return this.createFlowVersionFromSnapshot(
        {
          ...normalizedInput,
          dependencies: normalizeDependencyPins([
            ...mergeServerDerivedDependencies(
              snapshot,
              normalizedInput.ownerId,
              createTransactionLocalOperationClosureReader(this.db),
              normalizedInput.dependencies,
            ),
            ...derivePinnedResourceDependenciesSync(
              snapshot,
              this.resourceResolver(normalizedInput.ownerId),
            ),
          ]),
        },
        snapshot,
        snapshotJson,
        "semantic",
      );
    });
    const result = create.immediate();
    if (result === null || !("status" in result)) return result;
    const mutation = result as FlowMutationResult;
    if (mutation.status === "saved") throw new Error("Unexpected saved validation result");
    if (mutation.status === "not-found") {
      throw new FlowVersionMutationError({ status: "invalid-reference" });
    }
    throwVersionMutation(mutation);
  }

  async createFlowCheckpoint(
    input: CreateFlowCheckpointRepositoryInput,
  ): Promise<FlowVersionRecord | null> {
    rejectCallerFlowDependencies(input.dependencies);
    rejectCallerConnectorDependencies(input.dependencies);
    rejectCallerResourceDependencies(input.dependencies);
    if (!mutationValueWithinBudget(input.graph)) {
      throw new FlowVersionMutationError({ status: "invalid-reference" });
    }
    const parsed = parseSupportedFlowGraph(input.graph);
    const snapshotRaw: unknown = JSON.parse(JSON.stringify(parsed));
    const snapshot = parseSupportedFlowGraph(snapshotRaw);
    const snapshotJson = JSON.stringify(snapshotRaw);
    const normalizedInput = normalizeVersionCreationInput(input);
    requireVersionableGraph(snapshot);
    const create = this.db.transaction((): FlowVersionRecord | FlowMutationResult | null => {
      const owned = this.db.prepare(
        "SELECT 1 AS owned FROM flows WHERE id = ? AND owner_id = ?",
      ).get(normalizedInput.flowId, normalizedInput.ownerId) as { owned: number } | undefined;
      if (!owned) return null;
      requireVersionableGraph(snapshot);
      const mutation = new SqliteRepo(this.db).mutateFlowInCurrentTransaction({
        id: normalizedInput.flowId,
        mustExist: true,
        ownerId: normalizedInput.ownerId,
        name: snapshot.name,
        graph: snapshot,
        ...(input.impactReceipt === undefined ? {} : { impactReceipt: input.impactReceipt }),
      });
      if (mutation.status !== "saved") return mutation;
      return this.createFlowVersionFromSnapshot(
        {
          ...normalizedInput,
          dependencies: normalizeDependencyPins([
            ...mergeServerDerivedDependencies(
              snapshot,
              normalizedInput.ownerId,
              createTransactionLocalOperationClosureReader(this.db),
              normalizedInput.dependencies,
            ),
            ...derivePinnedResourceDependenciesSync(
              snapshot,
              this.resourceResolver(normalizedInput.ownerId),
            ),
          ]),
        },
        snapshot,
        snapshotJson,
        "exact",
      );
    });
    const result = create.immediate();
    if (result === null || !("status" in result)) return result;
    const mutation = result as FlowMutationResult;
    if (mutation.status === "saved") throw new Error("Unexpected saved checkpoint result");
    if (mutation.status === "not-found") {
      throw new FlowVersionMutationError({ status: "invalid-reference" });
    }
    throwVersionMutation(mutation);
  }

  private createFlowVersionFromSnapshot(
    input: CreateFlowVersionRepositoryInput,
    snapshot: SupportedFlowGraph,
    snapshotJson: string,
    dedupe: "semantic" | "exact",
  ): FlowVersionRecord {
    const dependencies = [...input.dependencies];
    const semanticHash = hashFlowGraph(snapshot, { semantic: true }, dependencies);
    const fullHash = hashFlowGraph(snapshot, { semantic: false }, dependencies);

    if (input.label === undefined) {
      const hashColumn = dedupe === "exact" ? "full_hash" : "semantic_hash";
      const hashValue = dedupe === "exact" ? fullHash : semanticHash;
      const candidates = this.db
        .prepare(
          `SELECT * FROM flow_versions
           WHERE flow_id = ? AND ${hashColumn} = ?
           ORDER BY version_number DESC, id`,
        )
        .all(input.flowId, hashValue) as FlowVersionRow[];
      for (const candidate of candidates) {
        const pins = this.listDependencyPinsSync(candidate.id);
        if (
          dependencyInputsEqual(dependencies, pins) &&
          (dedupe === "semantic" || candidate.graph === snapshotJson)
        ) {
          assertPinnedConnectorDependenciesCurrent(
            snapshot,
            input.ownerId,
            createTransactionLocalOperationClosureReader(this.db),
            dependencies,
          );
          assertPinnedResourceDependenciesCurrentSync(
            snapshot,
            dependencies,
            this.resourceResolver(input.ownerId),
          );
          return this.flowVersionRecord(candidate, pins);
        }
      }
    }

    const maximum = this.db
      .prepare(
        "SELECT COALESCE(MAX(version_number), 0) AS value FROM flow_versions WHERE flow_id = ?",
      )
      .get(input.flowId) as { value: number };
    const versionId = randomUUID();
    const versionNumber = maximum.value + 1;
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO flow_versions
          (id, flow_id, version_number, schema_version, label, description, graph,
           semantic_hash, full_hash, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        input.flowId,
        versionNumber,
        "schemaVersion" in snapshot && snapshot.schemaVersion === 2
          ? 2
          : FLOW_SCHEMA_VERSION,
        input.label ?? null,
        input.description ?? null,
        snapshotJson,
        semanticHash,
        fullHash,
        input.ownerId,
        createdAt,
      );
    const insertPin = this.db.prepare(
      `INSERT INTO dependency_pins
        (id, flow_version_id, kind, resource_id, version, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const dependency of dependencies) {
      insertPin.run(
        randomUUID(),
        versionId,
        dependency.kind,
        dependency.resourceId,
        dependency.version,
        dependency.contentHash ?? null,
        createdAt,
      );
    }
    assertPinnedConnectorDependenciesCurrent(
      snapshot,
      input.ownerId,
      createTransactionLocalOperationClosureReader(this.db),
      dependencies,
    );
    const row = requireRow(
      this.db.prepare("SELECT * FROM flow_versions WHERE id = ?").get(versionId) as
        | FlowVersionRow
        | undefined,
      "flow version",
    );
    const persistedPins = this.listDependencyPinsSync(versionId);
    assertPinnedResourceDependenciesCurrentSync(
      snapshot,
      persistedPins,
      this.resourceResolver(input.ownerId),
    );
    return this.flowVersionRecord(row, persistedPins);
  }

  async getFlowVersion(
    input: GetFlowVersionRepositoryInput,
  ): Promise<FlowVersionRecord | null> {
    const row = this.db
      .prepare(
        `SELECT v.* FROM flow_versions v
         JOIN flows f ON f.id = v.flow_id AND f.owner_id = ?
         WHERE v.flow_id = ? AND v.id = ?`,
      )
      .get(input.ownerId, input.flowId, input.versionId) as FlowVersionRow | undefined;
    return row ? this.flowVersionRecord(row, this.listDependencyPinsSync(row.id)) : null;
  }

  async listFlowVersions(
    input: ListFlowVersionsRepositoryInput,
  ): Promise<FlowVersionSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT v.*,
           (SELECT COUNT(*) FROM dependency_pins dp WHERE dp.flow_version_id = v.id)
             AS dependency_count
         FROM flow_versions v
         JOIN flows f ON f.id = v.flow_id AND f.owner_id = ?
         WHERE v.flow_id = ?
         ORDER BY v.version_number DESC, v.id`,
      )
      .all(input.ownerId, input.flowId) as FlowVersionSummaryRow[];
    return rows.map(flowVersionSummary);
  }

  async deployVersion(
    input: DeployVersionRepositoryInput,
  ): Promise<import("./repo").DeployVersionRepositoryResult> {
    const normalized = {
      flowId: requireVersionText(input.flowId, "flowId"),
      versionId: requireVersionText(input.versionId, "versionId"),
      versionSemanticHash: requireVersionText(input.versionSemanticHash, "versionSemanticHash"),
      versionFullHash: requireVersionText(input.versionFullHash, "versionFullHash"),
      environmentId: requireVersionText(input.environmentId, "environmentId"),
      environmentKind: input.environmentKind,
      expectedActiveDeploymentId: input.expectedActiveDeploymentId,
      sourceTestDeploymentId: input.sourceTestDeploymentId,
      confirmation: input.confirmation,
      ownerId: requireVersionText(input.ownerId, "ownerId"),
    };
    const rootVersion = await this.getFlowVersion({
      flowId: normalized.flowId,
      versionId: normalized.versionId,
      ownerId: normalized.ownerId,
    });
    const closureInspection = rootVersion ? await inspectVersionClosure({
      root: rootVersion,
      ownerId: normalized.ownerId,
      repo: this,
    }) : null;
    if (closureInspection === "api-operation") return { status: API_OPERATION_LIVE_UNAVAILABLE };
    if (closureInspection === "invalid") return { status: "invalid-request" };
    const deploy = this.db.transaction((): import("./repo").DeployVersionRepositoryResult => {
      const target = this.db
        .prepare(
          `SELECT
             e.project_id AS environment_project_id,
             e.kind AS environment_kind,
             fv.semantic_hash,
             fv.full_hash,
             fv.graph,
             wb.project_id AS workbook_project_id
           FROM flows f
           JOIN flow_versions fv ON fv.id = ? AND fv.flow_id = f.id
           JOIN environments e ON e.id = ?
           JOIN flow_project_bindings b
             ON b.flow_id = f.id AND b.project_id = e.project_id
           JOIN workbooks wb ON wb.id = b.workbook_id AND wb.project_id = b.project_id
           JOIN projects p ON p.id = e.project_id
           JOIN workspaces w ON w.id = p.workspace_id
           JOIN organizations o ON o.id = w.organization_id
           WHERE f.id = ? AND f.owner_id = ? AND o.personal_owner_id = ?`,
        )
        .get(
          normalized.versionId,
          normalized.environmentId,
          normalized.flowId,
          normalized.ownerId,
          normalized.ownerId,
        ) as DeploymentTargetRow | undefined;
      if (!target || !isEnvironmentKind(target.environment_kind)) return { status: "not-found" };
      const loadVersion = (flowId: string, versionId: string): FlowVersionRecord | null => {
        const row = this.db.prepare(
          `SELECT fv.* FROM flow_versions fv
           JOIN flows f ON f.id = fv.flow_id AND f.owner_id = ?
           WHERE fv.flow_id = ? AND fv.id = ?`,
        ).get(normalized.ownerId, flowId, versionId) as FlowVersionRow | undefined;
        return row ? this.flowVersionRecord(row, this.listDependencyPinsSync(row.id)) : null;
      };
      const transactionalRoot = loadVersion(normalized.flowId, normalized.versionId);
      if (!transactionalRoot) return { status: "not-found" };
      const transactionalClosure = inspectVersionClosureSync({
        root: transactionalRoot,
        load: loadVersion,
      });
      if (transactionalClosure === "api-operation") {
        return { status: API_OPERATION_LIVE_UNAVAILABLE };
      }
      if (transactionalClosure === "invalid") return { status: "invalid-request" };
      try {
        const graph = parseSupportedFlowGraph(JSON.parse(target.graph) as unknown);
        if (graphContainsApiOperation(graph)) return { status: API_OPERATION_LIVE_UNAVAILABLE };
      } catch {
        return { status: "invalid-request" };
      }
      if (target.environment_kind !== normalized.environmentKind) {
        return { status: "invalid-request" };
      }
      if (
        target.semantic_hash !== normalized.versionSemanticHash ||
        target.full_hash !== normalized.versionFullHash
      ) {
        return { status: "conflict" };
      }

      const current = this.db
        .prepare(
          `SELECT * FROM deployments
           WHERE flow_id = ? AND environment_id = ? AND retired_at IS NULL`,
        )
        .get(normalized.flowId, normalized.environmentId) as DeploymentRow | undefined;
      const hydratedCurrent = current ? deploymentRecord(current) : null;
      if (
        current &&
        (!hydratedCurrent || hydratedCurrent.status !== target.environment_kind)
      ) {
        return { status: "conflict" };
      }
      if (target.workbook_project_id !== target.environment_project_id) {
        return { status: "not-found" };
      }
      if ((current?.id ?? null) !== normalized.expectedActiveDeploymentId) {
        return { status: "conflict" };
      }

      if (normalized.environmentKind === "test") {
        if (normalized.sourceTestDeploymentId !== null || normalized.confirmation !== "PROMOTE TEST") {
          return { status: "invalid-request" };
        }
      } else {
        if (normalized.sourceTestDeploymentId === null || normalized.confirmation !== "PROMOTE LIVE") {
          return { status: "invalid-request" };
        }
        const source = this.db.prepare(
          `SELECT d.id FROM deployments d
           JOIN environments e
             ON e.id = d.environment_id AND e.kind = 'test' AND e.project_id = ?
           WHERE d.id = ? AND d.flow_id = ? AND d.flow_version_id = ?
             AND d.status = 'test' AND d.retired_at IS NULL`,
        ).get(
          target.environment_project_id,
          normalized.sourceTestDeploymentId,
          normalized.flowId,
          normalized.versionId,
        ) as { id: string } | undefined;
        if (!source) return { status: "conflict" };
      }

      if (current && hydratedCurrent && current.flow_version_id === normalized.versionId) {
        return { status: "deployed", deployment: hydratedCurrent };
      }

      const createdAt = Date.now();
      if (current) {
        const result = this.db
          .prepare(
            `UPDATE deployments
             SET status = 'retired', retired_at = ?
             WHERE id = ? AND retired_at IS NULL`,
          )
          .run(createdAt, current.id);
        if (result.changes !== 1) throw new Error("Active deployment changed during promotion");
      }

      const deploymentId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO deployments
            (id, flow_id, flow_version_id, environment_id, status, created_at, retired_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          deploymentId,
          normalized.flowId,
          normalized.versionId,
          normalized.environmentId,
          target.environment_kind,
          createdAt,
        );
      const inserted = requireRow(
        this.db.prepare("SELECT * FROM deployments WHERE id = ?").get(deploymentId) as
          | DeploymentRow
          | undefined,
        "deployment",
      );
      return {
        status: "deployed",
        deployment: requireRow(deploymentRecord(inserted) ?? undefined, "valid deployment"),
      };
    });
    return deploy.immediate();
  }

  async getActiveDeployment(
    input: GetActiveDeploymentRepositoryInput,
  ): Promise<DeploymentRecord | null> {
    const normalized = {
      flowId: requireVersionText(input.flowId, "flowId"),
      environmentKind: parseEnvironmentKind(input.environmentKind),
      ownerId: requireVersionText(input.ownerId, "ownerId"),
    };
    const row = this.db
      .prepare(
        `SELECT d.* FROM deployments d
         JOIN flows f ON f.id = d.flow_id AND f.owner_id = ?
         JOIN flow_versions fv ON fv.id = d.flow_version_id AND fv.flow_id = f.id
         JOIN environments e
           ON e.id = d.environment_id AND e.kind = ? AND d.status = e.kind
         JOIN flow_project_bindings b
           ON b.flow_id = f.id AND b.project_id = e.project_id
         JOIN workbooks wb ON wb.id = b.workbook_id AND wb.project_id = b.project_id
         JOIN projects p ON p.id = b.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organizations o ON o.id = w.organization_id AND o.personal_owner_id = ?
         WHERE d.flow_id = ? AND d.retired_at IS NULL`,
      )
      .get(
        normalized.ownerId,
        normalized.environmentKind,
        normalized.ownerId,
        normalized.flowId,
      ) as
      | DeploymentRow
      | undefined;
    return row ? deploymentRecord(row) : null;
  }

  async listActiveDeploymentsForFlows(
    input: ListActiveDeploymentsForFlowsRepositoryInput,
  ): Promise<DeploymentRecord[]> {
    const ownerByFlow = new Map(input.flows.map(({ flowId, ownerId }) => [flowId, ownerId]));
    const flowIds = [...ownerByFlow.keys()];
    if (flowIds.length === 0) return [];
    const placeholders = flowIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT d.*, f.owner_id AS flow_owner_id
         FROM deployments d
         JOIN flows f ON f.id = d.flow_id
         WHERE d.flow_id IN (${placeholders})
           AND d.status = ?
           AND d.retired_at IS NULL`,
      )
      .all(...flowIds, input.environmentKind) as Array<
        DeploymentRow & { flow_owner_id: string }
      >;
    return rows.flatMap((row) => {
      if (ownerByFlow.get(row.flow_id) !== row.flow_owner_id) return [];
      const deployment = deploymentRecord(row);
      return deployment ? [deployment] : [];
    });
  }

  async listDeployments(
    input: ListDeploymentsRepositoryInput,
  ): Promise<DeploymentRecord[]> {
    const normalized = {
      flowId: requireVersionText(input.flowId, "flowId"),
      ownerId: requireVersionText(input.ownerId, "ownerId"),
    };
    const rows = this.db
      .prepare(
        `SELECT d.* FROM deployments d
         JOIN flows f ON f.id = d.flow_id AND f.owner_id = ?
         JOIN flow_versions fv ON fv.id = d.flow_version_id AND fv.flow_id = f.id
         JOIN environments e
           ON e.id = d.environment_id AND e.kind IN ('draft', 'test', 'live')
         JOIN flow_project_bindings b
           ON b.flow_id = f.id AND b.project_id = e.project_id
         JOIN workbooks wb ON wb.id = b.workbook_id AND wb.project_id = b.project_id
         JOIN projects p ON p.id = b.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organizations o ON o.id = w.organization_id AND o.personal_owner_id = ?
         WHERE d.flow_id = ?
           AND (
             (d.retired_at IS NULL AND d.status = e.kind)
             OR (d.retired_at IS NOT NULL AND d.status = 'retired')
           )
         ORDER BY d.created_at DESC, d.id DESC`,
      )
      .all(normalized.ownerId, normalized.ownerId, normalized.flowId) as DeploymentRow[];
    return rows.flatMap((row) => {
      const hydrated = deploymentRecord(row);
      return hydrated ? [hydrated] : [];
    });
  }

  async retireDeployment(
    input: RetireDeploymentRepositoryInput,
  ): Promise<DeploymentRecord | null> {
    const normalized = {
      deploymentId: requireVersionText(input.deploymentId, "deploymentId"),
      ownerId: requireVersionText(input.ownerId, "ownerId"),
    };
    const retire = this.db.transaction((): DeploymentRecord | null => {
      const row = this.db
        .prepare(
          `SELECT d.* FROM deployments d
           JOIN flows f ON f.id = d.flow_id AND f.owner_id = ?
           JOIN flow_versions fv ON fv.id = d.flow_version_id AND fv.flow_id = f.id
           JOIN environments e
             ON e.id = d.environment_id AND e.kind IN ('draft', 'test', 'live')
           JOIN flow_project_bindings b
             ON b.flow_id = f.id AND b.project_id = e.project_id
           JOIN workbooks wb ON wb.id = b.workbook_id AND wb.project_id = b.project_id
           JOIN projects p ON p.id = b.project_id
           JOIN workspaces w ON w.id = p.workspace_id
           JOIN organizations o ON o.id = w.organization_id AND o.personal_owner_id = ?
           WHERE d.id = ?
             AND (
               (d.retired_at IS NULL AND d.status = e.kind)
               OR (d.retired_at IS NOT NULL AND d.status = 'retired')
             )`,
        )
        .get(normalized.ownerId, normalized.ownerId, normalized.deploymentId) as
        | DeploymentRow
        | undefined;
      if (!row) return null;
      const hydrated = deploymentRecord(row);
      if (!hydrated) return null;
      if (hydrated.status === "retired") return hydrated;
      const retiredAt = Date.now();
      const result = this.db
        .prepare(
          `UPDATE deployments SET status = 'retired', retired_at = ?
           WHERE id = ? AND retired_at IS NULL`,
        )
        .run(retiredAt, row.id);
      if (result.changes !== 1) throw new Error("Deployment changed during retirement");
      return requireRow(
        deploymentRecord({ ...row, status: "retired", retired_at: retiredAt }) ?? undefined,
        "valid retired deployment",
      );
    });
    return retire.immediate();
  }

  private listEnvironmentsSync(projectId: string, ownerId: string): EnvironmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM environments e
         JOIN projects p ON p.id = e.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organizations o ON o.id = w.organization_id
         WHERE e.project_id = ? AND o.personal_owner_id = ?
         ORDER BY CASE e.kind WHEN 'draft' THEN 0 WHEN 'test' THEN 1 WHEN 'live' THEN 2 ELSE 3 END,
                  e.created_at, e.id`,
      )
      .all(projectId, ownerId) as EnvironmentRow[];
    return rows.map(environmentRecord);
  }

  private ownsWorkbookSync(workbookId: string, ownerId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT wb.id
         FROM workbooks wb
         JOIN projects p ON p.id = wb.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organizations o ON o.id = w.organization_id
         WHERE wb.id = ? AND o.personal_owner_id = ?`,
      )
      .get(workbookId, ownerId);
    return Boolean(row);
  }

  private listWorkbookTabRowsSync(
    workbookId: string,
    ownerId: string,
  ): WorkbookFlowTabRow[] {
    return this.db
      .prepare(
        `SELECT t.*
         FROM workbook_flow_tabs t
         JOIN workbooks wb ON wb.id = t.workbook_id
         JOIN projects p ON p.id = wb.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organizations o ON o.id = w.organization_id AND o.personal_owner_id = ?
         JOIN flows f ON f.id = t.flow_id AND f.owner_id = ?
         WHERE t.workbook_id = ?
         ORDER BY t.position, t.id`,
      )
      .all(ownerId, ownerId, workbookId) as WorkbookFlowTabRow[];
  }

  private assertWorkbookTabInvariant(workbookId: string): void {
    const invalidTab = this.db
      .prepare(
        `SELECT t.id
         FROM workbook_flow_tabs t
         LEFT JOIN flow_project_bindings b
           ON b.flow_id = t.flow_id AND b.workbook_id = t.workbook_id
         LEFT JOIN workbooks wb ON wb.id = t.workbook_id
         LEFT JOIN projects p
           ON p.id = b.project_id AND p.id = wb.project_id
         LEFT JOIN workspaces w ON w.id = p.workspace_id
         LEFT JOIN organizations o ON o.id = w.organization_id
         LEFT JOIN flows f
           ON f.id = t.flow_id AND f.owner_id = o.personal_owner_id
         WHERE t.workbook_id = ?
           AND (b.flow_id IS NULL OR wb.id IS NULL OR p.id IS NULL OR
                w.id IS NULL OR o.id IS NULL OR f.id IS NULL)
         LIMIT 1`,
      )
      .get(workbookId) as { id: string } | undefined;
    if (invalidTab) {
      throw new Error(`Workbook tab invariant failed for tab ${invalidTab.id}`);
    }
    const bindingWithoutTab = this.db
      .prepare(
        `SELECT b.flow_id
         FROM flow_project_bindings b
         LEFT JOIN workbook_flow_tabs t
           ON t.flow_id = b.flow_id AND t.workbook_id = b.workbook_id
         WHERE b.workbook_id = ? AND t.id IS NULL
         LIMIT 1`,
      )
      .get(workbookId) as { flow_id: string } | undefined;
    if (bindingWithoutTab) {
      throw new Error(`Workbook tab invariant failed for binding ${bindingWithoutTab.flow_id}`);
    }
    const positions = this.db
      .prepare(
        `SELECT position FROM workbook_flow_tabs
         WHERE workbook_id = ? ORDER BY position, id`,
      )
      .all(workbookId) as Array<{ position: number }>;
    if (
      positions.some(
        (row, index) => !Number.isInteger(row.position) || row.position !== index,
      )
    ) {
      throw new Error(`Workbook tab invariant failed for positions in workbook ${workbookId}`);
    }
  }

  private getBindingRow(flowId: string): BindingRow | undefined {
    return this.db
      .prepare("SELECT * FROM flow_project_bindings WHERE flow_id = ?")
      .get(flowId) as BindingRow | undefined;
  }

  private listDependencyPinsSync(flowVersionId: string): DependencyPin[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM dependency_pins
         WHERE flow_version_id = ?
         ORDER BY kind, resource_id, version, COALESCE(content_hash, ''), id`,
      )
      .all(flowVersionId) as DependencyPinRow[];
    return rows.map(dependencyPinRecord).sort(compareDependencyContent);
  }

  private flowVersionRecord(
    row: FlowVersionRow,
    dependencies: readonly DependencyPin[],
  ): FlowVersionRecord {
    return {
      id: row.id,
      flowId: row.flow_id,
      versionNumber: row.version_number,
      schemaVersion: row.schema_version,
      ...(row.label === null ? {} : { label: row.label }),
      ...(row.description === null ? {} : { description: row.description }),
      graph: parsePersistedGraph(row.graph),
      semanticHash: row.semantic_hash,
      fullHash: row.full_hash,
      createdBy: row.created_by,
      createdAt: row.created_at,
      dependencies: [...dependencies],
    };
  }

  async restoreActiveDeployment(
    input: RestoreActiveDeploymentRepositoryInput,
  ): Promise<DeploymentRecord | null> {
    const normalized = {
      deploymentId: requireVersionText(input.deploymentId, "deploymentId"),
      expectedActiveDeploymentId: requireVersionText(
        input.expectedActiveDeploymentId,
        "expectedActiveDeploymentId",
      ),
      ownerId: requireVersionText(input.ownerId, "ownerId"),
    };
    const restore = this.db.transaction((): DeploymentRecord | null => {
      const prior = this.db.prepare(
        `SELECT d.*, e.kind AS environment_kind
         FROM deployments d
         JOIN flows f ON f.id = d.flow_id AND f.owner_id = ?
         JOIN environments e ON e.id = d.environment_id
         WHERE d.id = ? AND d.status = 'retired' AND d.retired_at IS NOT NULL`,
      ).get(normalized.ownerId, normalized.deploymentId) as
        | (DeploymentRow & { environment_kind: string })
        | undefined;
      if (!prior || (prior.environment_kind !== "test" && prior.environment_kind !== "live")) {
        return null;
      }
      const current = this.db.prepare(
        `SELECT * FROM deployments
         WHERE id = ? AND flow_id = ? AND environment_id = ?
           AND status = ? AND retired_at IS NULL`,
      ).get(
        normalized.expectedActiveDeploymentId,
        prior.flow_id,
        prior.environment_id,
        prior.environment_kind,
      ) as DeploymentRow | undefined;
      if (!current) return null;
      const retiredAt = Date.now();
      const retired = this.db.prepare(
        `UPDATE deployments SET status = 'retired', retired_at = ?
         WHERE id = ? AND retired_at IS NULL`,
      ).run(retiredAt, current.id);
      if (retired.changes !== 1) return null;
      const restored = this.db.prepare(
        `UPDATE deployments SET status = ?, retired_at = NULL
         WHERE id = ? AND status = 'retired' AND retired_at IS NOT NULL`,
      ).run(prior.environment_kind, prior.id);
      if (restored.changes !== 1) throw new Error("Prior deployment changed during compensation");
      const row = this.db.prepare("SELECT * FROM deployments WHERE id = ?")
        .get(prior.id) as DeploymentRow | undefined;
      return row ? deploymentRecord(row) : null;
    });
    return restore.immediate();
  }
}
