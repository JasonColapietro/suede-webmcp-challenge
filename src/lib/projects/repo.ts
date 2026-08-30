import type {
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
  WorkbookRecord,
  WorkbookFlowTab,
  WorkspaceRecord,
} from "./types";
import type { API_OPERATION_LIVE_UNAVAILABLE } from "@/lib/connectors/operation-closure";
import type { SupportedFlowGraph } from "@/lib/flow/types";

export interface DeployVersionRepositoryInput {
  readonly flowId: string;
  readonly versionId: string;
  readonly versionSemanticHash: string;
  readonly versionFullHash: string;
  readonly environmentId: string;
  readonly environmentKind: "test" | "live";
  readonly expectedActiveDeploymentId: string | null;
  readonly sourceTestDeploymentId: string | null;
  readonly confirmation: "PROMOTE TEST" | "PROMOTE LIVE";
  readonly ownerId: string;
}

export type DeployVersionRepositoryResult =
  | { readonly status: "deployed"; readonly deployment: DeploymentRecord }
  | { readonly status: "invalid-request" }
  | { readonly status: "not-found" }
  | { readonly status: "conflict" }
  | { readonly status: typeof API_OPERATION_LIVE_UNAVAILABLE };

export interface GetActiveDeploymentRepositoryInput {
  readonly flowId: string;
  readonly environmentKind: EnvironmentKind;
  readonly ownerId: string;
}

export interface ListActiveDeploymentsForFlowsRepositoryInput {
  readonly flows: readonly {
    readonly flowId: string;
    readonly ownerId: string;
  }[];
  readonly environmentKind: EnvironmentKind;
}

export interface ListDeploymentsRepositoryInput {
  readonly flowId: string;
  readonly ownerId: string;
}

export interface RetireDeploymentRepositoryInput {
  readonly deploymentId: string;
  readonly ownerId: string;
}

export interface RestoreActiveDeploymentRepositoryInput {
  readonly deploymentId: string;
  readonly expectedActiveDeploymentId: string;
  readonly ownerId: string;
}

export interface DeploymentRepo {
  deployVersion(input: DeployVersionRepositoryInput): Promise<DeployVersionRepositoryResult>;
  getActiveDeployment(
    input: GetActiveDeploymentRepositoryInput,
  ): Promise<DeploymentRecord | null>;
  /**
   * Fresh bounded read used by catalog surfaces to avoid one active-deployment
   * lookup per agent. A returned deployment is still revalidated by the exact
   * execution resolver before its immutable graph is published.
   */
  listActiveDeploymentsForFlows?(
    input: ListActiveDeploymentsForFlowsRepositoryInput,
  ): Promise<DeploymentRecord[]>;
  listDeployments(input: ListDeploymentsRepositoryInput): Promise<DeploymentRecord[]>;
  retireDeployment(input: RetireDeploymentRepositoryInput): Promise<DeploymentRecord | null>;
  /** Exact owner-scoped CAS compensation used when a post-promotion final write fails. */
  restoreActiveDeployment?(
    input: RestoreActiveDeploymentRepositoryInput,
  ): Promise<DeploymentRecord | null>;
}

export interface ListWorkbookTabsRepositoryInput {
  readonly workbookId: string;
  readonly ownerId: string;
}

export interface RenameWorkbookTabRepositoryInput extends ListWorkbookTabsRepositoryInput {
  readonly tabId: string;
  readonly title: string;
}

export interface ReorderWorkbookTabsRepositoryInput extends ListWorkbookTabsRepositoryInput {
  readonly tabIds: readonly string[];
}

export interface WorkbookTabRepo {
  listWorkbookTabs(input: ListWorkbookTabsRepositoryInput): Promise<WorkbookFlowTab[] | null>;
  renameWorkbookTab(input: RenameWorkbookTabRepositoryInput): Promise<WorkbookFlowTab | null>;
  reorderWorkbookTabs(input: ReorderWorkbookTabsRepositoryInput): Promise<WorkbookFlowTab[] | null>;
}

export interface CreateFlowVersionRepositoryInput {
  readonly flowId: string;
  readonly ownerId: string;
  readonly label?: string;
  readonly description?: string;
  readonly dependencies: readonly DependencyPinInput[];
}

export interface CreateFlowCheckpointRepositoryInput
  extends Omit<CreateFlowVersionRepositoryInput, "flowId" | "ownerId"> {
  readonly flowId: string;
  readonly ownerId: string;
  readonly graph: SupportedFlowGraph;
  readonly impactReceipt?: string;
}

export interface GetFlowVersionRepositoryInput {
  readonly flowId: string;
  readonly versionId: string;
  readonly ownerId: string;
}

export interface ListFlowVersionsRepositoryInput {
  readonly flowId: string;
  readonly ownerId: string;
}

export interface FlowVersionRepo {
  createFlowVersion(input: CreateFlowVersionRepositoryInput): Promise<FlowVersionRecord | null>;
  createFlowCheckpoint(input: CreateFlowCheckpointRepositoryInput): Promise<FlowVersionRecord | null>;
  getFlowVersion(input: GetFlowVersionRepositoryInput): Promise<FlowVersionRecord | null>;
  listFlowVersions(input: ListFlowVersionsRepositoryInput): Promise<FlowVersionSummary[]>;
}

export interface FlowProjectContext {
  readonly binding: FlowProjectBinding;
  readonly organization: OrganizationRecord;
  readonly workspace: WorkspaceRecord;
  readonly project: ProjectRecord;
  readonly workbook: WorkbookRecord;
  readonly environments: readonly EnvironmentRecord[];
}

export interface ProjectRepo extends FlowVersionRepo, DeploymentRepo, WorkbookTabRepo {
  ownsFlow(flowId: string, ownerId: string): Promise<boolean>;
  ensurePersonalContext(ownerId: string): Promise<PersonalContext>;
  getProject(projectId: string, ownerId: string): Promise<ProjectRecord | null>;
  listProjects(ownerId: string): Promise<ProjectRecord[]>;
  getWorkbook(workbookId: string, ownerId: string): Promise<WorkbookRecord | null>;
  listWorkbooks(projectId: string, ownerId: string): Promise<WorkbookRecord[]>;
  getEnvironment(environmentId: string, ownerId: string): Promise<EnvironmentRecord | null>;
  listEnvironments(projectId: string, ownerId: string): Promise<EnvironmentRecord[]>;
  bindFlow(flowId: string, context: PersonalContext): Promise<FlowProjectBinding | null>;
  getFlowContext(flowId: string, ownerId: string): Promise<FlowProjectContext | null>;
}
