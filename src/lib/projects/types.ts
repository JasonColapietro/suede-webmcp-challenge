import type { SupportedFlowGraph } from "@/lib/flow/types";

export type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type ReadonlyFlowGraph = DeepReadonly<SupportedFlowGraph>;

export const FLOW_SCHEMA_VERSION = 1 as const;

export const ENVIRONMENT_KINDS = ["draft", "test", "live"] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export const FLOW_LIFECYCLES = ["draft", "test", "live", "retired"] as const;
export type FlowLifecycle = (typeof FLOW_LIFECYCLES)[number];

export const DEPENDENCY_KINDS = ["agent", "connector", "flow", "resource", "skill", "template"] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export interface OrganizationRecord {
  readonly id: string;
  readonly personalOwnerId: string;
  readonly name: string;
  readonly kind: "personal" | "team";
  readonly createdAt: number;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: number;
}

export interface ProjectRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorkbookRecord {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly slug: string;
  readonly position: number;
  readonly createdAt: number;
}

export interface WorkbookFlowTab {
  readonly id: string;
  readonly workbookId: string;
  readonly flowId: string;
  readonly title: string;
  readonly position: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EnvironmentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly slug: string;
  readonly kind: EnvironmentKind;
  readonly createdAt: number;
}

export interface ProjectDetail extends ProjectRecord {
  readonly workbooks: readonly WorkbookRecord[];
  readonly environments: readonly EnvironmentRecord[];
}

export interface FlowProjectBinding {
  readonly flowId: string;
  readonly projectId: string;
  readonly workbookId: string;
  readonly createdAt: number;
}

export interface DependencyPin {
  readonly id: string;
  readonly flowVersionId: string;
  readonly kind: DependencyKind;
  readonly resourceId: string;
  readonly version: string;
  readonly contentHash?: string;
  readonly createdAt: number;
}

export interface DependencyPinInput {
  readonly kind: DependencyKind;
  readonly resourceId: string;
  readonly version: string;
  readonly contentHash?: string;
}

export interface FlowVersionRecord {
  readonly id: string;
  readonly flowId: string;
  readonly versionNumber: number;
  readonly schemaVersion: number;
  readonly label?: string;
  readonly description?: string;
  readonly graph: ReadonlyFlowGraph;
  readonly semanticHash: string;
  readonly fullHash: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly dependencies: readonly DependencyPin[];
}

export interface FlowVersionSummary {
  readonly id: string;
  readonly flowId: string;
  readonly versionNumber: number;
  readonly schemaVersion: number;
  readonly label?: string;
  readonly description?: string;
  readonly semanticHash: string;
  readonly fullHash: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly dependencyCount: number;
}

export interface FlowVersionComparison {
  readonly semanticEqual: boolean;
  readonly fullEqual: boolean;
  readonly changedSections: readonly string[];
}

export interface VersionDiffEntry {
  readonly kind: "node" | "edge" | "variable" | "dependency";
  readonly id: string;
  readonly change: "added" | "removed" | "changed";
  readonly fields: readonly string[];
}

export interface FlowVersionSemanticDiff {
  readonly from: { readonly id: string; readonly versionNumber: number; readonly semanticHash: string };
  readonly to: { readonly id: string; readonly versionNumber: number; readonly semanticHash: string };
  readonly semanticEqual: boolean;
  readonly fullEqual: boolean;
  readonly visualOnly: boolean;
  readonly changedSections: readonly string[];
  readonly counts: { readonly added: number; readonly removed: number; readonly changed: number };
  readonly entries: readonly VersionDiffEntry[];
  readonly truncated: boolean;
}

export interface DeploymentRecord {
  readonly id: string;
  readonly flowId: string;
  readonly flowVersionId: string;
  readonly environmentId: string;
  readonly status: FlowLifecycle;
  readonly createdAt: number;
  readonly retiredAt?: number;
}

export interface PersonalContext {
  readonly organization: OrganizationRecord;
  readonly workspace: WorkspaceRecord;
  readonly project: ProjectRecord;
  readonly workbook: WorkbookRecord;
  readonly environments: readonly EnvironmentRecord[];
}

export interface FlowWorkbookContext {
  readonly project: ProjectRecord;
  readonly workbook: WorkbookRecord;
  readonly environments: readonly EnvironmentRecord[];
}

export function isEnvironmentKind(value: unknown): value is EnvironmentKind {
  return typeof value === "string" && ENVIRONMENT_KINDS.some((kind) => kind === value);
}

export function parseEnvironmentKind(value: unknown): EnvironmentKind {
  if (!isEnvironmentKind(value)) {
    throw new TypeError(`Invalid environment kind: ${String(value)}`);
  }
  return value;
}

export function isFlowLifecycle(value: unknown): value is FlowLifecycle {
  return typeof value === "string" && FLOW_LIFECYCLES.some((state) => state === value);
}

export function parseFlowLifecycle(value: unknown): FlowLifecycle {
  if (!isFlowLifecycle(value)) {
    throw new TypeError(`Invalid flow lifecycle: ${String(value)}`);
  }
  return value;
}
