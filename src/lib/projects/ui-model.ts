import type { SupportedFlowGraph } from "@/lib/flow/types";
import { isFlowGraphV1, isFlowGraphV2, parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import type {
  FlowWorkbookContext,
  DeploymentRecord,
  EnvironmentRecord,
  FlowVersionRecord,
  FlowVersionSemanticDiff,
  FlowVersionSummary,
  PersonalContext,
} from "@/lib/projects/types";
export { parseFlowWorkbookEnvelope } from "@/lib/projects/public-workbook";
import { publicFlowVersionRecord } from "@/lib/projects/public-version";

export type VersionHistoryState =
  | { status: "loading" }
  | { status: "ready"; versions: readonly FlowVersionSummary[] }
  | { status: "error"; message: string };

export type DeploymentHistoryState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly deployments: readonly DeploymentRecord[] }
  | { readonly status: "error" };

export interface RequestOwnership {
  readonly controller: AbortController;
  readonly generation: number;
  readonly rowId: string | null;
}

export interface RequestSlot {
  generation: number;
  current: RequestOwnership | null;
}

export function createRequestSlot(): RequestSlot {
  return { generation: 0, current: null };
}

export function claimLatestRequest(slot: RequestSlot, rowId: string | null): RequestOwnership {
  slot.current?.controller.abort();
  const ownership = {
    controller: new AbortController(),
    generation: slot.generation + 1,
    rowId,
  };
  slot.generation = ownership.generation;
  slot.current = ownership;
  return ownership;
}

export function claimExclusiveRequest(
  slot: RequestSlot,
  rowId: string | null,
): RequestOwnership | null {
  if (slot.current !== null) return null;
  const ownership = {
    controller: new AbortController(),
    generation: slot.generation + 1,
    rowId,
  };
  slot.generation = ownership.generation;
  slot.current = ownership;
  return ownership;
}

export function ownsRequest(
  slot: RequestSlot,
  ownership: RequestOwnership,
  currentRowId: string | null,
): boolean {
  return slot.current === ownership && !ownership.controller.signal.aborted &&
    ownership.rowId === currentRowId;
}

export function releaseRequest(slot: RequestSlot, ownership: RequestOwnership): boolean {
  if (slot.current !== ownership) return false;
  slot.current = null;
  return true;
}

export function cancelRequest(slot: RequestSlot): void {
  const current = slot.current;
  if (!current) return;
  current.controller.abort();
  if (slot.current === current) slot.current = null;
}

export function abandonVersionReviewSession(input: {
  readonly mutationSlot: RequestSlot;
  readonly refreshSlot: RequestSlot;
  readonly reviewController: AbortController | null;
  readonly reviewGeneration: { current: number };
  readonly restoreGeneration: { current: number };
}): void {
  input.reviewGeneration.current += 1;
  input.restoreGeneration.current += 1;
  input.reviewController?.abort();
  cancelRequest(input.mutationSlot);
  cancelRequest(input.refreshSlot);
}

export interface LivePromotionRequest {
  readonly versionId: string;
  readonly versionSemanticHash: string;
  readonly versionFullHash: string;
  readonly environmentId: string;
  readonly environmentKind: "live";
  readonly expectedActiveDeploymentId: string | null;
  readonly sourceTestDeploymentId: string;
  readonly confirmation: "PROMOTE LIVE";
}

export function buildLivePromotionRequest(input: {
  readonly flowId: string;
  readonly version: FlowVersionRecord;
  readonly liveEnvironment: EnvironmentRecord;
  readonly activeLive: DeploymentRecord | null;
  readonly activeTest: DeploymentRecord;
}): LivePromotionRequest | null {
  const hash = /^[0-9a-f]{64}$/;
  if (!nonEmptyString(input.flowId) || input.version.flowId !== input.flowId ||
    input.liveEnvironment.kind !== "live" ||
    input.activeTest.flowId !== input.flowId || input.activeTest.status !== "test" ||
    input.activeTest.retiredAt !== undefined || input.activeTest.flowVersionId !== input.version.id ||
    (input.activeLive !== null && (input.activeLive.flowId !== input.flowId ||
      input.activeLive.environmentId !== input.liveEnvironment.id || input.activeLive.status !== "live" ||
      input.activeLive.retiredAt !== undefined)) ||
    !hash.test(input.version.semanticHash) || !hash.test(input.version.fullHash)) return null;
  return {
    versionId: input.version.id,
    versionSemanticHash: input.version.semanticHash,
    versionFullHash: input.version.fullHash,
    environmentId: input.liveEnvironment.id,
    environmentKind: "live",
    expectedActiveDeploymentId: input.activeLive?.id ?? null,
    sourceTestDeploymentId: input.activeTest.id,
    confirmation: "PROMOTE LIVE",
  };
}

export interface EnvironmentRailItem {
  readonly kind: "draft" | "test" | "live";
  readonly detail: string;
}

export function environmentRailView(input: {
  readonly versions: readonly FlowVersionSummary[];
  readonly deployments: readonly DeploymentRecord[];
  readonly environments: readonly EnvironmentRecord[];
}): readonly EnvironmentRailItem[] {
  const versionNumbers = new Map(input.versions.map((version) => [version.id, version.versionNumber]));
  const active = (kind: "test" | "live") => {
    const environment = input.environments.find((item) => item.kind === kind);
    if (!environment) return null;
    return input.deployments.find((deployment) =>
      deployment.environmentId === environment.id &&
      deployment.status === kind &&
      deployment.retiredAt === undefined,
    ) ?? null;
  };
  const detail = (kind: "test" | "live"): string => {
    const deployment = active(kind);
    if (!deployment) return "Not promoted";
    const versionNumber = versionNumbers.get(deployment.flowVersionId);
    return versionNumber ? `v${versionNumber}` : "Version unavailable";
  };
  return [
    { kind: "draft", detail: "Mutable workspace" },
    { kind: "test", detail: detail("test") },
    { kind: "live", detail: detail("live") },
  ];
}

export interface VersionPanelOptions {
  readonly readOnly: boolean;
  readonly saving: boolean;
  readonly canSave: boolean;
}

export interface VersionPanelModel {
  readonly items: readonly FlowVersionSummary[];
  readonly countLabel: string;
  readonly message: string | null;
  readonly busy: boolean;
  readonly canRetry: boolean;
  readonly readOnly: boolean;
  readonly showSave: boolean;
  readonly saveDisabled: boolean;
  readonly announcement: string | null;
}

export type SavedVersionResult = {
  readonly kind: "created" | "deduped";
  readonly version: FlowVersionRecord;
};

export function versionCountLabel(count: number): string {
  return `${count} ${count === 1 ? "version" : "versions"}`;
}

export function formatProjectContext(context: FlowWorkbookContext, versionCount: number): string {
  return `${context.project.name} / ${context.workbook.name} · ${versionCountLabel(versionCount)}`;
}

export function projectContextView(input: {
  readonly context: FlowWorkbookContext | null;
  readonly versionCount: number;
  readonly loading: boolean;
  readonly error: string | null;
}): { readonly text: string; readonly busy: boolean } {
  return {
    text: input.loading
      ? "Loading project context…"
      : input.context
        ? formatProjectContext(input.context, input.versionCount)
        : input.error ?? "Project context unavailable.",
    busy: input.loading,
  };
}

export function versionPanelView(
  state: VersionHistoryState,
  options: VersionPanelOptions,
): VersionPanelModel {
  const versions =
    state.status === "ready"
      ? [...state.versions].sort((left, right) => right.versionNumber - left.versionNumber)
      : [];
  const message =
    state.status === "loading"
      ? "Loading version history…"
      : state.status === "error"
        ? state.message
        : versions.length === 0
          ? "No versions yet. Save this draft when you want a checkpoint."
          : null;

  return {
    items: versions,
    countLabel: versionCountLabel(versions.length),
    message,
    busy: state.status === "loading" || options.saving,
    canRetry: state.status === "error",
    readOnly: options.readOnly,
    showSave: !options.readOnly,
    saveDisabled: options.readOnly || options.saving || !options.canSave,
    announcement: options.saving ? "Saving version…" : null,
  };
}

export function saveAnnouncement(result: SavedVersionResult): string {
  return result.kind === "deduped"
    ? `Already saved as v${result.version.versionNumber}.`
    : `Saved version v${result.version.versionNumber}.`;
}

export async function saveVersionCheckpoint(input: {
  readonly rowId: string;
  readonly graph: SupportedFlowGraph;
  readonly existingVersionIds: ReadonlySet<string>;
  readonly createCheckpoint: (
    rowId: string,
    graph: SupportedFlowGraph,
  ) => Promise<FlowVersionRecord>;
}): Promise<SavedVersionResult> {
  const saved = await input.createCheckpoint(input.rowId, input.graph);
  return {
    kind: input.existingVersionIds.has(saved.id) ? "deduped" : "created",
    version: saved,
  };
}

export async function saveBeforeWorkbookNavigation(input: {
  readonly currentGraph: SupportedFlowGraph;
  readonly targetFlowId: string;
  readonly saveNow: (graph: SupportedFlowGraph) => Promise<void>;
  readonly navigate: (path: string) => void;
}): Promise<void> {
  await input.saveNow(input.currentGraph);
  input.navigate(`/build/${encodeURIComponent(input.targetFlowId)}`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function buildVersionDownload(version: FlowVersionRecord): {
  readonly filename: string;
  readonly content: string;
} {
  const portable = publicFlowVersionRecord(version);
  return {
    filename: `${version.flowId}-v${version.versionNumber}.json`,
    content: `${JSON.stringify(canonicalize(portable), null, 2)}\n`,
  };
}

export function buildCodeVersionModel(source: string, latest: FlowVersionRecord | null) {
  return {
    draftLabel: "Current draft" as const,
    draftSource: source,
    latestLabel: "Latest saved version" as const,
    latestVersionNumber: latest?.versionNumber ?? null,
    latest,
    emptyMessage: latest ? null : "No saved versions yet. Open Studio and save one.",
  };
}

export function versionRecordToSummary(version: FlowVersionRecord): FlowVersionSummary {
  return {
    id: version.id,
    flowId: version.flowId,
    versionNumber: version.versionNumber,
    schemaVersion: version.schemaVersion,
    label: version.label,
    description: version.description,
    semanticHash: version.semanticHash,
    fullHash: version.fullHash,
    createdBy: version.createdBy,
    createdAt: version.createdAt,
    dependencyCount: version.dependencies.length,
  };
}

export function deleteFlowControl(versionCount: number): {
  readonly disabled: boolean;
  readonly reason: string | null;
} {
  return versionCount > 0
    ? {
        disabled: true,
        reason: "Saved versions keep this flow immutable. Delete is unavailable.",
      }
    : { disabled: false, reason: null };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function hasNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "number" && Number.isFinite(value[key]);
}

function isVersionSummary(value: unknown): value is FlowVersionSummary {
  const item = record(value);
  return Boolean(
    item &&
      hasString(item, "id") &&
      hasString(item, "flowId") &&
      hasNumber(item, "versionNumber") &&
      hasNumber(item, "schemaVersion") &&
      hasString(item, "semanticHash") &&
      hasString(item, "fullHash") &&
      hasString(item, "createdBy") &&
      hasNumber(item, "createdAt") &&
      hasNumber(item, "dependencyCount"),
  );
}

export function parsePersonalContextEnvelope(value: unknown): PersonalContext | null {
  const envelope = record(value);
  const item = envelope ? record(envelope.context) : null;
  const organization = item ? record(item.organization) : null;
  const workspace = item ? record(item.workspace) : null;
  const project = item ? record(item.project) : null;
  const workbook = item ? record(item.workbook) : null;
  if (
    !item ||
    !organization ||
    !workspace ||
    !project ||
    !workbook ||
    !hasString(organization, "id") ||
    !hasString(workspace, "id") ||
    !hasString(project, "id") ||
    !hasString(project, "name") ||
    !hasString(workbook, "id") ||
    !hasString(workbook, "name") ||
    !Array.isArray(item.environments)
  ) {
    return null;
  }
  return item as unknown as PersonalContext;
}

export function parseVersionSummariesEnvelope(value: unknown): FlowVersionSummary[] | null {
  const envelope = record(value);
  if (!envelope || !Array.isArray(envelope.versions)) return null;
  return envelope.versions.every(isVersionSummary)
    ? (envelope.versions as FlowVersionSummary[])
    : null;
}

const DEPLOYMENT_KEYS = [
  "id", "flowId", "flowVersionId", "environmentId", "status", "createdAt",
] as const;

function parseDeployment(value: unknown): DeploymentRecord | null {
  const item = strictRecord(value);
  if (!item || !exactOptionalKeys(item, DEPLOYMENT_KEYS, ["retiredAt"])) return null;
  if (!nonEmptyString(item.id) || !nonEmptyString(item.flowId) ||
    !nonEmptyString(item.flowVersionId) || !nonEmptyString(item.environmentId) ||
    (item.status !== "draft" && item.status !== "test" && item.status !== "live" && item.status !== "retired") ||
    typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt) ||
    (item.retiredAt !== undefined && (typeof item.retiredAt !== "number" || !Number.isFinite(item.retiredAt))) ||
    ((item.status === "retired") !== (item.retiredAt !== undefined))) {
    return null;
  }
  return item as unknown as DeploymentRecord;
}

export function parseDeploymentsEnvelope(
  value: unknown,
  target: {
    readonly flowId: string;
    readonly testEnvironmentId: string;
    readonly liveEnvironmentId: string;
  },
): DeploymentRecord[] | null {
  const envelope = strictRecord(value);
  if (!envelope || !exactKeys(envelope, ["deployments"]) || !Array.isArray(envelope.deployments) ||
    Object.getPrototypeOf(envelope.deployments) !== Array.prototype || envelope.deployments.length > 200 ||
    !nonEmptyString(target.flowId) || !nonEmptyString(target.testEnvironmentId) ||
    !nonEmptyString(target.liveEnvironmentId) || target.testEnvironmentId === target.liveEnvironmentId) return null;
  const deployments: DeploymentRecord[] = [];
  const ids = new Set<string>();
  let activeTest = 0;
  let activeLive = 0;
  for (const value of envelope.deployments) {
    const deployment = parseDeployment(value);
    if (!deployment || ids.has(deployment.id) || deployment.flowId !== target.flowId ||
      deployment.status === "draft" ||
      (deployment.status === "test" && deployment.environmentId !== target.testEnvironmentId) ||
      (deployment.status === "live" && deployment.environmentId !== target.liveEnvironmentId) ||
      (deployment.status === "retired" && deployment.environmentId !== target.testEnvironmentId &&
        deployment.environmentId !== target.liveEnvironmentId)) return null;
    ids.add(deployment.id);
    if (deployment.status === "test") activeTest += 1;
    if (deployment.status === "live") activeLive += 1;
    if (activeTest > 1 || activeLive > 1) return null;
    deployments.push(deployment);
  }
  return deployments;
}

export function parseDeploymentEnvelope(value: unknown): DeploymentRecord | null {
  const envelope = strictRecord(value);
  return envelope && exactKeys(envelope, ["deployment"])
    ? parseDeployment(envelope.deployment)
    : null;
}

export function parseVersionRecordEnvelope(value: unknown): FlowVersionRecord | null {
  const envelope = record(value);
  const item = envelope ? record(envelope.version) : null;
  const graph = item ? record(item.graph) : null;
  if (
    !item ||
    !isVersionSummary({ ...item, dependencyCount: Array.isArray(item.dependencies) ? item.dependencies.length : -1 }) ||
    !graph ||
    !hasString(graph, "id") ||
    !hasString(graph, "name") ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(item.dependencies)
  ) {
    return null;
  }
  return item as unknown as FlowVersionRecord;
}

const DIFF_KINDS = ["node", "edge", "variable", "dependency"] as const;
const DIFF_CHANGES = ["added", "removed", "changed"] as const;
const UNSAFE_DIFF_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function strictRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => UNSAFE_DIFF_KEYS.has(key))) return null;
  return item;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    actual.every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sortedUniqueStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    value.every(nonEmptyString) &&
    value.every((item, index) => index === 0 || value[index - 1] < item);
}

function parseDiffEndpoint(value: unknown): value is FlowVersionSemanticDiff["from"] {
  const item = strictRecord(value);
  return !!item &&
    exactKeys(item, ["id", "versionNumber", "semanticHash"]) &&
    nonEmptyString(item.id) &&
    Number.isSafeInteger(item.versionNumber) &&
    (item.versionNumber as number) > 0 &&
    typeof item.semanticHash === "string" && /^[0-9a-f]{64}$/.test(item.semanticHash);
}

function parseDiffCounts(value: unknown): value is FlowVersionSemanticDiff["counts"] {
  const item = strictRecord(value);
  return !!item &&
    exactKeys(item, DIFF_CHANGES) &&
    DIFF_CHANGES.every((key) => Number.isSafeInteger(item[key]) && (item[key] as number) >= 0);
}

function diffEntryOrder(
  left: FlowVersionSemanticDiff["entries"][number],
  right: FlowVersionSemanticDiff["entries"][number],
): number {
  const kind = DIFF_KINDS.indexOf(left.kind) - DIFF_KINDS.indexOf(right.kind);
  return kind || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function parseDiffEntries(value: unknown): FlowVersionSemanticDiff["entries"] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 200) {
    return null;
  }
  const entries: FlowVersionSemanticDiff["entries"][number][] = [];
  for (const candidate of value) {
    const item = strictRecord(candidate);
    if (!item ||
      !exactKeys(item, ["kind", "id", "change", "fields"]) ||
      !DIFF_KINDS.some((kind) => kind === item.kind) ||
      !DIFF_CHANGES.some((change) => change === item.change) ||
      !nonEmptyString(item.id) ||
      !sortedUniqueStrings(item.fields) ||
      (item.change === "changed" ? item.fields.length === 0 : item.fields.length !== 0)) {
      return null;
    }
    entries.push(item as unknown as FlowVersionSemanticDiff["entries"][number]);
  }
  if (entries.some((entry, index) => index > 0 && diffEntryOrder(entries[index - 1], entry) >= 0)) {
    return null;
  }
  return entries;
}

export function parseVersionDiffEnvelope(value: unknown): FlowVersionSemanticDiff | null {
  const envelope = strictRecord(value);
  if (!envelope || !exactKeys(envelope, ["diff"])) return null;
  const diff = strictRecord(envelope.diff);
  if (!diff || !exactKeys(diff, [
    "from", "to", "semanticEqual", "fullEqual", "visualOnly", "changedSections",
    "counts", "entries", "truncated",
  ])) return null;
  if (!parseDiffEndpoint(diff.from) || !parseDiffEndpoint(diff.to) ||
    typeof diff.semanticEqual !== "boolean" ||
    typeof diff.fullEqual !== "boolean" ||
    typeof diff.visualOnly !== "boolean" ||
    typeof diff.truncated !== "boolean" ||
    !sortedUniqueStrings(diff.changedSections) ||
    !parseDiffCounts(diff.counts)) return null;
  const entries = parseDiffEntries(diff.entries);
  if (!entries) return null;
  const observed = entries.reduce(
    (counts, entry) => ({ ...counts, [entry.change]: counts[entry.change] + 1 }),
    { added: 0, removed: 0, changed: 0 },
  );
  const counts = diff.counts;
  const total = counts.added + counts.removed + counts.changed;
  if (diff.truncated) {
    if (entries.length !== 200 || total <= entries.length ||
      DIFF_CHANGES.some((change) => counts[change] < observed[change])) return null;
  } else if (total !== entries.length ||
    DIFF_CHANGES.some((change) => counts[change] !== observed[change])) return null;
  const semanticEqual = total === 0 && diff.changedSections.length === 0;
  if (diff.semanticEqual !== semanticEqual) return null;
  if (diff.semanticEqual !== (diff.from.semanticHash === diff.to.semanticHash)) return null;
  if (diff.fullEqual && !diff.semanticEqual) return null;
  const visualOnly = !diff.fullEqual && diff.semanticEqual && total === 0;
  if (diff.visualOnly !== visualOnly) return null;
  return diff as unknown as FlowVersionSemanticDiff;
}

function versionEndpointMatches(
  endpoint: FlowVersionSemanticDiff["from"],
  version: Pick<FlowVersionSummary, "id" | "versionNumber" | "semanticHash">,
): boolean {
  return endpoint.id === version.id && endpoint.versionNumber === version.versionNumber &&
    endpoint.semanticHash === version.semanticHash;
}

export function versionReviewEnvelopeMatches(input: {
  readonly selectedRecord: FlowVersionRecord;
  readonly selectedSummary: FlowVersionSummary;
  readonly latestSummary: FlowVersionSummary;
  readonly diff: FlowVersionSemanticDiff;
}): boolean {
  return input.selectedRecord.id === input.selectedSummary.id &&
    input.selectedRecord.flowId === input.selectedSummary.flowId &&
    input.selectedRecord.versionNumber === input.selectedSummary.versionNumber &&
    input.selectedRecord.semanticHash === input.selectedSummary.semanticHash &&
    input.selectedRecord.fullHash === input.selectedSummary.fullHash &&
    versionEndpointMatches(input.diff.from, input.selectedRecord) &&
    versionEndpointMatches(input.diff.to, input.latestSummary);
}

const RESTORE_VERSION_KEYS = [
  "id", "flowId", "versionNumber", "schemaVersion", "graph", "semanticHash", "fullHash",
  "createdBy", "createdAt", "dependencies",
] as const;
const RESTORE_VERSION_OPTIONAL_KEYS = ["label", "description"] as const;
const RESTORE_DEPENDENCY_KINDS = ["agent", "connector", "flow", "resource", "skill", "template"] as const;

function isRestoreDependency(value: unknown, versionId: string): boolean {
  const item = strictRecord(value);
  if (!item || !exactOptionalKeys(
    item,
    ["id", "flowVersionId", "kind", "resourceId", "version", "createdAt"],
    ["contentHash"],
  )) return false;
  return nonEmptyString(item.id) &&
    item.flowVersionId === versionId &&
    RESTORE_DEPENDENCY_KINDS.some((kind) => kind === item.kind) &&
    nonEmptyString(item.resourceId) &&
    nonEmptyString(item.version) &&
    (item.contentHash === undefined || nonEmptyString(item.contentHash)) &&
    typeof item.createdAt === "number" && Number.isFinite(item.createdAt);
}

export function parseVersionRestoreEnvelope(
  value: unknown,
  expected: { readonly flowId: string; readonly versionId: string },
): FlowVersionRecord | null {
  const envelope = strictRecord(value);
  if (!envelope || !exactKeys(envelope, ["version"])) return null;
  const item = strictRecord(envelope.version);
  if (!item || !exactOptionalKeys(item, RESTORE_VERSION_KEYS, RESTORE_VERSION_OPTIONAL_KEYS)) {
    return null;
  }
  if (item.id !== expected.versionId || item.flowId !== expected.flowId ||
    !Number.isSafeInteger(item.versionNumber) || (item.versionNumber as number) < 1 ||
    !Number.isSafeInteger(item.schemaVersion) || (item.schemaVersion as number) < 1 ||
    !nonEmptyString(item.semanticHash) || !nonEmptyString(item.fullHash) ||
    !nonEmptyString(item.createdBy) ||
    typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt) ||
    (item.label !== undefined && typeof item.label !== "string") ||
    (item.description !== undefined && typeof item.description !== "string") ||
    !Array.isArray(item.dependencies) || Object.getPrototypeOf(item.dependencies) !== Array.prototype ||
    !item.dependencies.every((dependency) => isRestoreDependency(dependency, expected.versionId))) {
    return null;
  }
  try {
    parseSupportedFlowGraph(item.graph);
  } catch {
    return null;
  }
  if (!isFlowGraphV1(item.graph) && !isFlowGraphV2(item.graph)) return null;
  const schemaVersion = "schemaVersion" in item.graph ? item.graph.schemaVersion : 1;
  if (item.schemaVersion !== schemaVersion) return null;
  return item as unknown as FlowVersionRecord;
}

export async function fetchVersionForRestore(input: {
  readonly flowId: string;
  readonly versionId: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<FlowVersionRecord> {
  if (!nonEmptyString(input.flowId) || !nonEmptyString(input.versionId)) {
    throw new Error("Version restore is unavailable.");
  }
  const fetcher = input.fetcher ?? ((path: string, init?: RequestInit) => fetch(path, init));
  try {
    const response = await fetcher(
      `/api/v2/flows/${encodeURIComponent(input.flowId)}/versions/${encodeURIComponent(input.versionId)}`,
      { signal: input.signal },
    );
    if (!response.ok) throw new Error("Unavailable response");
    const value: unknown = await response.json();
    const version = parseVersionRestoreEnvelope(value, input);
    if (!version) throw new Error("Invalid response");
    return version;
  } catch {
    throw new Error("Version restore is unavailable.");
  }
}
