"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import FlowCanvas, {
  graphSelectionsEqual,
  liveSelectionBounds,
  nodeBoundsRecordsEqual,
  normalizeGraphSelection,
  pruneGraphSelection,
  commandRequestsCanvasFocus,
  selectionAfterCommand,
} from "@/components/canvas/FlowCanvas";
import NodePalette from "@/components/canvas/NodePalette";
import Inspector from "@/components/canvas/Inspector";
import FlowVariablesPanel from "@/components/canvas/FlowVariablesPanel";
import BuilderCommandBar from "@/components/canvas/BuilderCommandBar";
import CommandPalette from "@/components/canvas/CommandPalette";
import { useBuilderShortcuts } from "@/components/canvas/useBuilderShortcuts";
import RunDock from "@/components/canvas/RunDock";
import ConnectorBrowser from "@/components/connectors/ConnectorBrowser";
import {
  boundCompatibleApiOperationConnection,
  type ApiOperationActionState,
} from "@/components/connectors/ApiOperationInspector";
import FlowImpactDialog from "@/components/canvas/FlowImpactDialog";
import StudioRecoveryBanner, { type StudioRecoveryBannerState } from "@/components/canvas/StudioRecoveryBanner";
import type { FlowCallableInterface, FlowGraph, FlowNode, FlowNodeV2, FlowVariable, NodeType, SubflowReference, SupportedFlowGraph, ValueBinding } from "@/lib/flow/types";
import type { FlowTestScope } from "@/lib/flow/test-scope";
import { createTestRunUiPlan, parseTestRunPinValues } from "@/lib/flow/test-run-ui";
import type { SuedeNodeStatus } from "@/components/canvas/SuedeNode";
import ModeSwitch from "@/components/mode-switch";
import WorkspaceKeyCallout from "@/components/WorkspaceKeyCallout";
import ProjectContext from "@/components/projects/ProjectContext";
import VersionPanel from "@/components/projects/VersionPanel";
import VersionReviewDialog, {
  type VersionReviewAction,
  type VersionReviewDiffState,
} from "@/components/projects/VersionReviewDialog";
import WorkbookTabs, {
  type WorkbookTabFocusHandoff,
} from "@/components/projects/WorkbookTabs";
import SubflowBreadcrumbs, {
  type SubflowBreadcrumbDisplayItem,
  type SubflowBreadcrumbDisplayState,
} from "@/components/projects/SubflowBreadcrumbs";
import PinnedReferenceBanner, {
  type PinnedReferenceBannerState,
} from "@/components/projects/PinnedReferenceBanner";
import { trackEvent } from "@/lib/analytics";
import type { DeploymentRecord, FlowVersionRecord, FlowWorkbookContext, WorkbookFlowTab } from "@/lib/projects/types";
import { decodeRouteRowId } from "@/lib/projects/route-row-id";
import {
  parseFlowWorkbookEnvelope,
  parsePersonalContextEnvelope,
  parseVersionRecordEnvelope,
  parseVersionRestoreEnvelope,
  parseVersionDiffEnvelope,
  parseDeploymentsEnvelope,
  parseDeploymentEnvelope,
  fetchVersionForRestore,
  parseVersionSummariesEnvelope,
  saveAnnouncement,
  saveVersionCheckpoint,
  versionRecordToSummary,
  type VersionHistoryState,
  type DeploymentHistoryState,
  createRequestSlot,
  claimLatestRequest,
  claimExclusiveRequest,
  ownsRequest,
  releaseRequest,
  cancelRequest,
  versionReviewEnvelopeMatches,
  buildLivePromotionRequest,
  abandonVersionReviewSession,
  type RequestOwnership,
} from "@/lib/projects/ui-model";
import { buildVersionRestoreCommand } from "@/lib/projects/version-restore";
import {
  parseCreatedFlowId,
  parsePersistedFlow,
  parseTemplateGraph,
} from "@/lib/flow/api-contract";
import {
  FlowSaveCoordinator,
  ImpactRequiredError,
  flowSaveFingerprint,
  type ImpactPendingState,
} from "@/lib/flow/save-queue";
import {
  storeFirstSaveSessionHandoff,
  takeMatchingFirstSaveSessionHandoff,
  type CanvasViewport,
} from "@/lib/studio/first-save-session-handoff";
import {
  STUDIO_ALTERNATE_NAVIGATION_MESSAGE,
  STUDIO_NAVIGATION_CHANGED_MESSAGE,
  STUDIO_NAVIGATION_PASTE_WAIT_MESSAGE,
  STUDIO_PASTE_NAVIGATION_MESSAGE,
  StudioNavigationCoordinator,
  isStudioPasteNavigationPending,
  isUnmodifiedPrimaryStudioNavigation,
  resolveStudioNavigationPathAfterCreate,
} from "@/lib/flow/studio-navigation";
import {
  emptyStudioRecoveryFlags,
  encodeStudioRecovery,
  parseStudioRecovery,
  readStudioRecovery,
  recoveryDisposition,
  rekeyStudioRecovery,
  removeStudioRecovery,
  studioRecoveryOwnerScope,
  studioRecoveryStorageKey,
  writeStudioRecovery,
  type StudioRecoveryEnvelope,
} from "@/lib/flow/studio-recovery";
import { StudioHistoryGuard } from "@/lib/flow/studio-history-guard";
import {
  createStudioHistoryBrowserPort,
  getOrCreateStudioRecoverySessionNonce,
  studioHistoryMarkerFromState,
} from "@/lib/flow/studio-history-browser";
import {
  resolveStudioRecoveryRouteIdentity,
  recoveryBindingAfterMigration,
  runStudioTransitionMutation,
  studioRecoveryBootstrapReady,
  studioTransitionBlocked,
} from "@/lib/flow/studio-recovery-bootstrap";
import {
  createGraphHistory,
  dispatchGraphCommand,
  redoGraphCommand,
  resetGraphHistory,
  undoGraphCommand,
  type GraphDispatchOptions,
  type GraphHistoryState,
} from "@/lib/flow/graph-history";
import type {
  GraphCommand,
  GraphSelection,
  JsonPatchOp,
  NodeBounds,
} from "@/lib/flow/graph-command-types";
import {
  commandForSelectionDelete,
  commandState,
  type BuilderCommandContext,
  type BuilderCommandId,
} from "@/lib/flow/builder-command-registry";
import {
  parseGraphFragment,
  serializeGraphFragment,
  type GraphFragmentV1,
} from "@/lib/flow/graph-fragment";
import {
  PendingSubflowPasteController,
} from "@/lib/flow/subflow-reference-paste";
import {
  createSubflowReferenceClient,
  type SubflowReferenceClient,
} from "@/lib/flow/subflow-reference-client";
import { layoutGraph } from "@/lib/flow/graph-layout";

/* layoutGraph's 300px column pitch predates the current node-card width
   (capped at 300px in SuedeNode). Stretch the x axis so wired columns keep a
   real gutter between cards; y rows are already generous. */
const LAYOUT_X_ORIGIN = 80;
const LAYOUT_X_STRETCH = 340 / 300;
function spreadLayout(
  positions: Record<string, { x: number; y: number }>,
): Record<string, { x: number; y: number }> {
  return Object.fromEntries(
    Object.entries(positions).map(([id, p]) => [
      id,
      { x: Math.round(LAYOUT_X_ORIGIN + (p.x - LAYOUT_X_ORIGIN) * LAYOUT_X_STRETCH), y: p.y },
    ]),
  );
}
import { getNodeDefinition } from "@/lib/flow/node-definitions";
import { normalizeSubflowReference } from "@/lib/flow/subflow-reference";
import {
  appendSubflowBreadcrumb,
  clearSubflowBreadcrumbSession,
  consumeSubflowFocusAfterGraphLoad,
  deriveSubflowAncestorReturn,
  getOrCreateSubflowBreadcrumbNonce,
  projectSubflowBreadcrumbRequest,
  readSubflowBreadcrumbTrail,
  stageSubflowBreadcrumbRouteEffect,
  validateSubflowBreadcrumbResponse,
  type SubflowBreadcrumbEntry,
} from "@/lib/flow/subflow-breadcrumb-session";
import {
  assertGraphPortReferences,
} from "@/lib/flow/node-ports";
import type { ValidatedNodePortResolver } from "@/lib/flow/node-ports";
import type { SubflowResolveProjection } from "@/lib/flow/subflow-api";
import {
  ConnectionClientError,
  connectionChoices,
  createConnectionClient,
  type ConnectionChoice,
} from "@/lib/connections/client";
import type { ConnectionChoicesStatus } from "@/components/canvas/Inspector";
import { CONNECTOR_LAB_ENABLED } from "@/lib/connectors/flags";
import {
  createConnectorClient,
  type ConnectorClient,
} from "@/lib/connectors/client";
import {
  createConnectorReadinessClient,
  type ConnectorReadinessClient,
} from "@/lib/connectors/readiness-client";
import type { ConnectorReadinessReceipt } from "@/lib/connectors/readiness";
import {
  createApiOperationSimulationClient,
  type ApiOperationSimulationClient,
} from "@/lib/connectors/simulation-client";
import type { ApiOperationSimulationReceiptV1 } from "@/lib/connectors/simulation-contract";
import type { ApiOperationBrowserClosureProjection } from "@/lib/connectors/operation-closure";
import type { ApiOperationReference } from "@/lib/flow/api-operation-reference";
import {
  API_OPERATION_REPAIR_MESSAGE,
  bindStudioOperationClosures,
  commandForApiOperationPick,
  createStudioOperationPortResolver,
  invalidateStudioSimulationForPinChange,
  isCurrentStudioContext,
  operationVersionIdsForGraph,
  projectContextualStudioValue,
  studioOperationClosureContextKey,
} from "@/lib/connectors/studio-authoring";
import {
  StudioReferenceSessionGate,
  bindReferenceBootstrapGraph,
  consumeReferenceBootstrapGraph,
  createReferenceBootstrapGraph,
  discardBoundReferenceBootstrapGraph,
  hasReferenceBootstrapMarker,
  peekReferenceBootstrapGraph,
  stageReferenceBootstrapGraph,
  updateReferenceBootstrapGraph,
} from "@/lib/flow/studio-reference-session-gate";
import type { StudioReferenceAction, StudioReferenceBlocker } from "@/lib/flow/subflow-reference-ledger";
import {
  PendingPasteEpochGuard,
  PendingPasteIntent,
  TrustedClipboardIntent,
  bindDeferredPasteIntent,
  clonePendingPasteIntent,
  consumeDeferredPasteIntent,
  createPendingPasteIntent,
  createTrustedClipboardIntent,
  detachTypedReferencesForExternalClipboard,
  discardDeferredPasteIntent,
  discardBoundDeferredPasteIntent,
  fragmentHasTypedReferences,
  readPendingPasteIntent,
  peekDeferredPasteIntent,
  readTrustedClipboardIntent,
  stageDeferredPasteIntent,
} from "@/lib/flow/studio-paste-session";
import "../../chrome.css";
import "../../site.css";

const SAVE_DEBOUNCE_MS = 800;
const WORKBOOK_TAB_FOCUS_KEY = "suede.workbook-tab-focus";
const UNPERSISTED_PLAIN_PASTE_PARENT = "studio-unpersisted-plain-paste-parent";
const EMPTY_STRING_RECORD: Readonly<Record<string, string>> = Object.freeze({});
const GRAPH_CONTEXT_IDS = new WeakMap<object, number>();
let nextGraphContextId = 1;

function graphContextId(graph: SupportedFlowGraph | null): number | null {
  if (!graph) return null;
  const existing = GRAPH_CONTEXT_IDS.get(graph);
  if (existing !== undefined) return existing;
  const created = nextGraphContextId++;
  GRAPH_CONTEXT_IDS.set(graph, created);
  return created;
}

type StudioOperationClosureState =
  | Readonly<{ contextKey: string; status: "disabled"; graph: SupportedFlowGraph | null }>
  | Readonly<{ contextKey: string; status: "empty"; graph: SupportedFlowGraph | null }>
  | Readonly<{ contextKey: string; status: "loading"; graph: SupportedFlowGraph }>
  | Readonly<{
      contextKey: string;
      status: "ready";
      graph: SupportedFlowGraph;
      byNodeId: ReadonlyMap<string, ApiOperationBrowserClosureProjection>;
    }>
  | Readonly<{ contextKey: string; status: "repair"; graph: SupportedFlowGraph; reason: string }>;

type ContextualActionState<Receipt> = Readonly<{
  contextKey: string;
  value: ApiOperationActionState<Receipt>;
}>;

type ContextualPinState = Readonly<{
  contextKey: string;
  values: Readonly<Record<string, string>>;
}>;

function readStoredWorkbookTabFocus(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(WORKBOOK_TAB_FOCUS_KEY);
    return value && value.length <= 512 ? value : null;
  } catch {
    return null;
  }
}

function storeWorkbookTabFocus(flowId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(WORKBOOK_TAB_FOCUS_KEY, flowId);
  } catch {
    // The in-memory ref still handles clients whose storage is unavailable.
  }
}

function clearStoredWorkbookTabFocus(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(WORKBOOK_TAB_FOCUS_KEY);
  } catch {
    // The in-memory marker is still cleared by the caller.
  }
}

interface LaunchInfo {
  slug: string;
  endpoints?: string[];
  agentId?: string;
  schedule?: { cron: string; description: string; nextRunAt: number | null } | null;
  payout?: { payTo: string; source: "creator" | "platform" | "unset" } | null;
  webhook?: { url: string; secret?: string; note?: string } | null;
  /**
   * Whether the agent is collecting USDC on paid calls. undefined = the
   * launch response did not say (older contract); the panel then points at
   * the Workspace Settle toggle instead of asserting a state.
   */
  settlementLive?: boolean;
  /** Server-provided payout caveat (lane contract; optional at runtime). */
  payoutWarning?: string;
  /** Pricing guidance from the launch response, when the server sends it. */
  floorUsdc?: number;
  suggestedUsdc?: number;
}

interface PendingStudioNavigation {
  path: string;
  createdRowId: string | null;
}

interface PendingAuthoritativeLoad {
  readonly graph: SupportedFlowGraph;
  readonly rowId: string | null;
}

interface PendingCreatedMigration {
  readonly rowId: string;
  readonly fingerprint: string;
  readonly current: boolean;
}

type StudioDispatchPersistence =
  | { readonly kind: "schedule" }
  | { readonly kind: "draft-only" };

function emptyGraph(): FlowGraph {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return { id, name: "Untitled flow", nodes: [], edges: [] };
}

function genNodeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `node_${crypto.randomUUID()}`;
  }
  return `node_${Math.random().toString(36).slice(2)}`;
}

/** How long a transient command toast stays on the canvas before clearing. */
const COMMAND_ANNOUNCEMENT_MS = 6000;

function genCommandId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}`;
}

export default function BuildPage(): React.JSX.Element {
  const params = useParams<{ flowId: string }>();
  const searchParams = useSearchParams();
  const flowId = decodeRouteRowId(params.flowId);
  const pendingTabFocusRef = useRef<string | null>(null);
  if (pendingTabFocusRef.current === null) {
    pendingTabFocusRef.current = readStoredWorkbookTabFocus();
  }
  return (
    <BuildSession
      key={flowId}
      flowId={flowId}
      template={searchParams.get("template")}
      fromGuided={searchParams.get("from") === "guided"}
      pendingTabFocusRef={pendingTabFocusRef}
    />
  );
}

function BuildSession({
  flowId,
  template,
  fromGuided,
  pendingTabFocusRef,
}: {
  readonly flowId: string;
  readonly template: string | null;
  readonly fromGuided: boolean;
  readonly pendingTabFocusRef: WorkbookTabFocusHandoff;
}): React.JSX.Element {
  const router = useRouter();
  const isNew = flowId === "new";
  const incomingFirstSaveRowIdRef = useRef(isNew ? null : flowId);
  const outgoingFirstSaveHandoffRef = useRef<{
    readonly rowId: string;
    readonly persistedFingerprint: string;
  } | null>(null);
  const restoredFirstSaveGraphRef = useRef<{
    readonly authoritativeFingerprint: string;
    readonly currentFingerprint: string;
  } | null>(null);
  const [forceCompactCanvas, setForceCompactCanvas] = useState(false);
  const [guidedBannerDismissed, setGuidedBannerDismissed] = useState(false);
  const sessionParentFlowId = isNew ? null : flowId;
  const referenceGateRef = useRef(new StudioReferenceSessionGate());
  const referenceBootstrapTokenRef = useRef<string | null>(null);

  const [history, setHistory] = useState<GraphHistoryState | null>(null);
  const historyRef = useRef<GraphHistoryState | null>(null);
  const graph = history?.graph ?? null;
  const [selection, setSelection] = useState<GraphSelection>(() =>
    normalizeGraphSelection([], [], null),
  );
  const selectionRef = useRef<GraphSelection>(selection);
  const [measuredBounds, setMeasuredBounds] = useState<Readonly<Record<string, NodeBounds>>>({});
  const measuredBoundsRef = useRef<Readonly<Record<string, NodeBounds>>>(measuredBounds);
  useEffect(() => {
    measuredBoundsRef.current = measuredBounds;
  }, [measuredBounds]);
  const [initialCanvasViewport, setInitialCanvasViewport] = useState<CanvasViewport | undefined>();
  const canvasViewportRef = useRef<CanvasViewport | null>(null);
  const [commandAnnouncement, setCommandAnnouncement] = useState<string>("");
  // The command toast is transient. Nothing used to clear it, so the last
  // command's text sat over the canvas for the rest of the session AND — because
  // commandAnnouncement leads the live-region chain below — permanently pinned
  // that region to a stale string, so launch/save outcomes could never be
  // announced again. Clearing to "" does not re-announce.
  useEffect(() => {
    if (commandAnnouncement === "") return;
    const timer = window.setTimeout(() => setCommandAnnouncement(""), COMMAND_ANNOUNCEMENT_MS);
    return () => window.clearTimeout(timer);
  }, [commandAnnouncement]);
  const [canvasFocusRequest, setCanvasFocusRequest] = useState<number>(0);
  const [canvasFocusNodeRequest, setCanvasFocusNodeRequest] = useState<{ readonly nodeId: string; readonly token: number } | undefined>();
  const [subflowBreadcrumbState, setSubflowBreadcrumbState] = useState<SubflowBreadcrumbDisplayState>(isNew ? { kind: "empty" } : { kind: "loading" });
  const [pinnedReferenceBannerState, setPinnedReferenceBannerState] = useState<PinnedReferenceBannerState>({ kind: "empty" });
  const [subflowBreadcrumbRetry, setSubflowBreadcrumbRetry] = useState(0);
  const subflowBreadcrumbNonceRef = useRef<string | null>(null);
  const claimedSubflowTrailRef = useRef<readonly SubflowBreadcrumbEntry[]>([]);
  const subflowBreadcrumbClaimRef = useRef<string | null>(null);
  const subflowBreadcrumbValidationRef = useRef<string | null>(null);
  const subflowTrailValidatedRef = useRef(false);
  const subflowBreadcrumbGenerationRef = useRef(0);
  const subflowBreadcrumbAbortRef = useRef<AbortController | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState<boolean>(false);
  const [clipboardFragment, setClipboardFragment] = useState<GraphFragmentV1 | null>(null);
  const [clipboardReadAvailable, setClipboardReadAvailable] = useState<boolean>(false);
  const trustedClipboardRef = useRef<TrustedClipboardIntent | null>(null);
  const pendingPasteControllerRef = useRef<PendingSubflowPasteController | null>(null);
  if (pendingPasteControllerRef.current === null) {
    pendingPasteControllerRef.current = new PendingSubflowPasteController();
  }
  const subflowPasteClientRef = useRef<SubflowReferenceClient | null>(null);
  if (subflowPasteClientRef.current === null) {
    subflowPasteClientRef.current = createSubflowReferenceClient();
  }
  const pendingPasteEpochGuardRef = useRef<PendingPasteEpochGuard | null>(null);
  if (pendingPasteEpochGuardRef.current === null) {
    pendingPasteEpochGuardRef.current = new PendingPasteEpochGuard();
  }
  const pendingPasteOperationRef = useRef<boolean>(false);
  const deferredPasteTokenRef = useRef<string | null>(null);
  const retryPasteIntentRef = useRef<PendingPasteIntent | null>(null);
  const [routeDeferredPasteIntent, setRouteDeferredPasteIntent] = useState<PendingPasteIntent | null>(null);
  const [pasteResolving, setPasteResolving] = useState<boolean>(false);
  const [pasteResolutionError, setPasteResolutionError] = useState<string | null>(null);
  const canvasColumnRef = useRef<HTMLDivElement | null>(null);
  const commandsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pasteSequenceRef = useRef<number>(0);
  const nameGroupRef = useRef<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, SuedeNodeStatus>>({});
  const [testScope, setTestScope] = useState<FlowTestScope | null>(null);
  const [runDockBusy, setRunDockBusy] = useState<boolean>(false);
  // Next-safe-action ladder: Draft → Run test → Save version → Launch →
  // View endpoint. "Tested" means the last full (unscoped) dock run finished
  // with every node done; scoped single-node tests don't count.
  const [hasSuccessfulTest, setHasSuccessfulTest] = useState<boolean>(false);
  const runDockControlRef = useRef<HTMLButtonElement | null>(null);
  const lastRunWasScopedRef = useRef<boolean>(false);
  const effectiveTestScopeRef = useRef<FlowTestScope | null>(null);
  const [connectionMetadataState, setConnectionMetadataState] = useState<{
    readonly contextKey: string;
    readonly status: ConnectionChoicesStatus;
    readonly choices: readonly ConnectionChoice[];
  }>({ contextKey: "", status: "loading", choices: Object.freeze([]) });
  const connectorClientRef = useRef<ConnectorClient | null>(null);
  const readinessClientRef = useRef<ConnectorReadinessClient | null>(null);
  const simulationClientRef = useRef<ApiOperationSimulationClient | null>(null);
  const closureAbortRef = useRef<AbortController | null>(null);
  const closureGenerationRef = useRef(0);
  const simulationAbortRef = useRef<AbortController | null>(null);
  const simulationGenerationRef = useRef(0);
  const readinessAbortRef = useRef<AbortController | null>(null);
  const readinessGenerationRef = useRef(0);
  const [operationClosures, setOperationClosures] = useState<StudioOperationClosureState>(() =>
    CONNECTOR_LAB_ENABLED
      ? { contextKey: "", status: "empty", graph: null }
      : { contextKey: "", status: "disabled", graph: null });
  const [apiOperationPickerOpen, setApiOperationPickerOpen] = useState(false);
  const apiOperationPickerContextRef = useRef<string | null>(null);
  const apiOperationPickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [simulationState, setSimulationState] = useState<ContextualActionState<ApiOperationSimulationReceiptV1>>({ contextKey: "", value: { status: "idle" } });
  const [readinessState, setReadinessState] = useState<ContextualActionState<ConnectorReadinessReceipt>>({ contextKey: "", value: { status: "idle" } });
  const [apiOperationPinValues, setApiOperationPinValues] = useState<ContextualPinState>({ contextKey: "", values: {} });
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped by the load-failure Retry button to re-run the flow fetch. */
  const [flowLoadRetry, setFlowLoadRetry] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [impactPending, setImpactPending] = useState<ImpactPendingState | null>(null);
  const [impactDialogOpen, setImpactDialogOpen] = useState<boolean>(false);
  const [impactConfirming, setImpactConfirming] = useState<boolean>(false);
  const impactPendingRef = useRef<ImpactPendingState | null>(impactPending);
  const impactConfirmingRef = useRef<boolean>(impactConfirming);
  const [referenceSaveBlocked, setReferenceSaveBlocked] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [launch, setLaunch] = useState<LaunchInfo | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  // Blank by default (not "0"): template loads fill in the suggested price,
  // and a blank field forces an explicit pricing choice at launch instead of
  // silently shipping a free endpoint.
  const [priceUsdc, setPriceUsdc] = useState<string>("");
  const [payoutAddress, setPayoutAddress] = useState<string>("");
  // Opt-in only: settlement stays OFF by default on every launch; this box
  // flips it on via the settlement route AFTER a successful launch.
  const [collectOnLaunch, setCollectOnLaunch] = useState<boolean>(false);
  const [persistedId, setPersistedId] = useState<string | null>(isNew ? null : flowId);
  const persistedIdRef = useRef<string | null>(isNew ? null : flowId);
  const [projectContext, setProjectContext] = useState<FlowWorkbookContext | null>(null);
  const [workbookTabs, setWorkbookTabs] = useState<readonly WorkbookFlowTab[]>([]);
  const [busyFlowId, setBusyFlowId] = useState<string | null>(null);
  const [workbookTabError, setWorkbookTabError] = useState<string | null>(null);
  const workbookSwitchRef = useRef<string | null>(null);
  const sessionMountedRef = useRef(true);
  const [contextLoading, setContextLoading] = useState<boolean>(true);
  const [contextError, setContextError] = useState<string | null>(null);
  const [versionHistory, setVersionHistory] = useState<VersionHistoryState>({
    status: isNew ? "ready" : "loading",
    versions: [],
  });
  const [versionSaving, setVersionSaving] = useState<boolean>(false);
  const [versionAnnouncement, setVersionAnnouncement] = useState<string | null>(null);
  const versionRestoreGenerationRef = useRef(0);
  const [deploymentHistory, setDeploymentHistory] = useState<DeploymentHistoryState>(
    isNew ? { status: "ready", deployments: [] } : { status: "loading" },
  );
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<FlowVersionRecord | null>(null);
  const [versionReviewDiff, setVersionReviewDiff] = useState<VersionReviewDiffState>({ status: "loading" });
  const [versionReviewBusy, setVersionReviewBusy] = useState<VersionReviewAction | null>(null);
  const [livePromotionPhrase, setLivePromotionPhrase] = useState("");
  const versionReviewTriggerRef = useRef<HTMLElement | null>(null);
  const versionReviewAbortRef = useRef<AbortController | null>(null);
  const versionReviewGenerationRef = useRef(0);
  const projectLoadSlotRef = useRef(createRequestSlot());
  const deploymentRefreshSlotRef = useRef(createRequestSlot());
  const versionMutationSlotRef = useRef(createRequestSlot());
  useEffect(() => {
    // Both slots are created once by useRef and their `.current` is never
    // reassigned — only mutated in place — so reading them here is the same
    // object the cleanup would have read, and the lint rule is satisfied
    // without changing what gets abandoned.
    //
    // `versionReviewAbortRef` is deliberately NOT captured the same way: that
    // one IS reassigned per request, and the cleanup has to abort whichever
    // controller is in flight at unmount, not the one that existed at mount.
    const mutationSlot = versionMutationSlotRef.current;
    const refreshSlot = deploymentRefreshSlotRef.current;
    return () => abandonVersionReviewSession({
      mutationSlot,
      refreshSlot,
      reviewController: versionReviewAbortRef.current,
      reviewGeneration: versionReviewGenerationRef,
      restoreGeneration: versionRestoreGenerationRef,
    });
  }, [flowId]);
  useLayoutEffect(() => {
    impactPendingRef.current = impactPending;
  }, [impactPending]);
  useLayoutEffect(() => {
    impactConfirmingRef.current = impactConfirming;
  }, [impactConfirming]);
  const studioNavigationCoordinatorRef = useRef(new StudioNavigationCoordinator());
  const pendingStudioNavigationRef = useRef<PendingStudioNavigation | null>(null);
  const authoritativeGraphRef = useRef<SupportedFlowGraph | null>(null);
  const authoritativeRowIdRef = useRef<string | null>(isNew ? null : flowId);
  const baseSavedFingerprintRef = useRef<string | null>(null);
  const installedBaselineFingerprintRef = useRef<string | null>(null);
  const recoveryEnvelopeRef = useRef<StudioRecoveryEnvelope | null>(null);
  const recoveryStorageRef = useRef<Storage | null>(null);
  const recoveryStorageKeyRef = useRef<string | null>(null);
  const recoveryRouteScopeRef = useRef<string | null>(null);
  const studioHistoryGuardRef = useRef<StudioHistoryGuard | null>(null);
  const pendingHistoryNavigationRef = useRef(false);
  const beforeUnloadHandlerRef = useRef<((event: BeforeUnloadEvent) => void) | null>(null);
  const beforeUnloadAttachedRef = useRef(false);
  const beginRouteEffectRef = useRef<(effect: () => void) => boolean>((effect) => { effect(); return true; });
  const writeRecoverySnapshotRef = useRef<(force?: boolean, previousKey?: string | null) => "stored" | "clean" | "failed">(() => "failed");
  const recoveryIsDirtyRef = useRef<() => boolean>(() => false);
  const recoveryInitializedRef = useRef<string | null>(null);
  const [ownerScopeHash, setOwnerScopeHash] = useState<string | null>(null);
  const ownerScopeHashRef = useRef<string | null>(null);
  const operationClosureContextKey = studioOperationClosureContextKey({
    graphToken: graphContextId(graph),
    ownerScopeHash,
    persistedId,
  });
  const operationClosureContextKeyRef = useRef(operationClosureContextKey);
  operationClosureContextKeyRef.current = operationClosureContextKey;
  const operationClosureContextMatches = operationClosures.contextKey === operationClosureContextKey;
  const [ownerLoadError, setOwnerLoadError] = useState<string | null>(null);
  const [ownerLoadRetry, setOwnerLoadRetry] = useState(0);
  const connectionMetadataContextKey = JSON.stringify([ownerScopeHash, ownerLoadRetry]);
  const connectionMetadataContextKeyRef = useRef(connectionMetadataContextKey);
  connectionMetadataContextKeyRef.current = connectionMetadataContextKey;
  const visibleConnectionMetadataState = projectContextualStudioValue(
    connectionMetadataContextKey,
    { contextKey: connectionMetadataState.contextKey, value: connectionMetadataState },
    { contextKey: connectionMetadataContextKey, status: "loading" as const, choices: Object.freeze([]) },
  );
  const [authoritativeLoadVersion, setAuthoritativeLoadVersion] = useState(0);
  const [pendingAuthoritativeLoad, setPendingAuthoritativeLoad] = useState<PendingAuthoritativeLoad | null>(null);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const [recoveryUi, setRecoveryUi] = useState<{
    readonly state: StudioRecoveryBannerState;
    readonly message: string;
  } | null>(null);
  const recoverySessionNonceRef = useRef<string | null>(null);
  const pendingCreatedMigrationRef = useRef<PendingCreatedMigration | null>(null);
  const createdRowAwaitingPersistRef = useRef<string | null>(null);
  const finishCreatedMigrationRef = useRef<() => void>(() => undefined);
  const heldDeferredPasteRef = useRef<PendingPasteIntent | null>(null);
  const heldDeferredGraphRef = useRef<SupportedFlowGraph | null>(null);
  const persistedSnapshotsRef = useRef(new Map<string, SupportedFlowGraph>());
  if (recoverySessionNonceRef.current === null && typeof window !== "undefined") {
    try {
      recoveryStorageRef.current = window.sessionStorage;
    } catch {
      recoveryStorageRef.current = null;
    }
    const createNonce = () => crypto.randomUUID().replace(/-/g, "_");
    recoverySessionNonceRef.current = recoveryStorageRef.current
      ? getOrCreateStudioRecoverySessionNonce(recoveryStorageRef.current, createNonce)
      : createNonce();
  }

  const referenceBlocker = useCallback((action: StudioReferenceAction) =>
    referenceGateRef.current.blocker(action), []);
  const impactActionBlocker = useCallback((): string | null =>
    impactPendingRef.current !== null || impactConfirmingRef.current
      ? "Review the reusable-flow impact before continuing."
      : null, []);
  const testEnvironment = projectContext?.environments.find(
    (environment) => environment.kind === "test",
  ) ?? null;
  const liveEnvironment = projectContext?.environments.find(
    (environment) => environment.kind === "live",
  ) ?? null;
  const activeDeployment = useCallback((kind: "test" | "live"): DeploymentRecord | null => {
    if (deploymentHistory.status !== "ready" || !projectContext) return null;
    const environment = projectContext.environments.find((item) => item.kind === kind);
    if (!environment) return null;
    return deploymentHistory.deployments.find((deployment) =>
      deployment.environmentId === environment.id && deployment.status === kind &&
      deployment.retiredAt === undefined,
    ) ?? null;
  }, [deploymentHistory, projectContext]);
  const activeTestDeployment = activeDeployment("test");
  const activeLiveDeployment = activeDeployment("live");
  const latestImmutableVersion = versionHistory.status === "ready"
    ? versionHistory.versions.reduce<(typeof versionHistory.versions)[number] | null>(
      (latest, version) => !latest || version.versionNumber > latest.versionNumber ? version : latest,
      null,
    )
    : null;
  const v2TestGraph = graph && "schemaVersion" in graph && graph.schemaVersion === 2
    ? graph
    : null;
  useEffect(() => {
    closureGenerationRef.current += 1;
    const generation = closureGenerationRef.current;
    const contextKey = operationClosureContextKey;
    closureAbortRef.current?.abort();
    closureAbortRef.current = null;
    if (!CONNECTOR_LAB_ENABLED) {
      setOperationClosures({ contextKey, status: "disabled", graph });
      return;
    }
    if (!graph) {
      setOperationClosures({ contextKey, status: "empty", graph: null });
      return;
    }
    let operationVersionIds: readonly string[];
    try { operationVersionIds = operationVersionIdsForGraph(graph); } catch {
      setOperationClosures({ contextKey, status: "repair", graph, reason: API_OPERATION_REPAIR_MESSAGE });
      return;
    }
    if (operationVersionIds.length === 0 || !("schemaVersion" in graph) || graph.schemaVersion !== 2) {
      setOperationClosures({ contextKey, status: "empty", graph });
      return;
    }
    if (ownerScopeHash === null) {
      setOperationClosures({ contextKey, status: "loading", graph });
      return;
    }
    const snapshot = graph;
    const rowId = persistedId;
    const controller = new AbortController();
    closureAbortRef.current = controller;
    if (connectorClientRef.current === null) connectorClientRef.current = createConnectorClient();
    setOperationClosures({ contextKey, status: "loading", graph: snapshot });
    void connectorClientRef.current.resolveOperations(operationVersionIds, controller.signal).then((envelope) => {
      if (controller.signal.aborted || generation !== closureGenerationRef.current ||
          historyRef.current?.graph !== snapshot || persistedIdRef.current !== rowId ||
          operationClosureContextKeyRef.current !== contextKey) return;
      const result = bindStudioOperationClosures(snapshot, operationVersionIds, envelope);
      setOperationClosures(result.status === "ready"
        ? { contextKey, status: "ready", graph: snapshot, byNodeId: result.byNodeId }
        : { contextKey, status: "repair", graph: snapshot, reason: result.reason });
    }).catch(() => {
      if (!controller.signal.aborted && generation === closureGenerationRef.current &&
          historyRef.current?.graph === snapshot && persistedIdRef.current === rowId &&
          operationClosureContextKeyRef.current === contextKey) {
        setOperationClosures({ contextKey, status: "repair", graph: snapshot, reason: API_OPERATION_REPAIR_MESSAGE });
      }
    }).finally(() => {
      if (closureAbortRef.current === controller) closureAbortRef.current = null;
    });
    return () => controller.abort();
  }, [graph, operationClosureContextKey, ownerScopeHash, persistedId]);

  const testRunDisabledReason = useMemo((): string | null => {
    const impactBlocked = impactActionBlocker();
    if (impactBlocked) return impactBlocked;
    const referenceBlocked = referenceBlocker("run");
    if (referenceBlocked) return referenceBlocked.message;
    if (contextLoading) return "Loading the Test environment.";
    if (!persistedId) return "Save this flow before running a scoped test.";
    if (!graph || !("schemaVersion" in graph) || graph.schemaVersion !== 2) {
      return "Scoped tests require a version 2 flow.";
    }
    if (!projectContext) return "Project context is unavailable for scoped tests.";
    if (!testEnvironment) return "Create a Test environment before running a scoped test.";
    return null;
  }, [
    contextLoading,
    graph,
    impactActionBlocker,
    persistedId,
    projectContext,
    referenceBlocker,
    testEnvironment,
  ]);
  const testScopeNodeExists = Boolean(
    testScope && v2TestGraph &&
    v2TestGraph.nodes.some((node) => node.id === testScope.nodeId),
  );
  const effectiveTestScope = testRunDisabledReason === null && testScopeNodeExists
    ? testScope
    : null;
  const handleRunTestScope = useCallback((scope: FlowTestScope): void => {
    if (runDockBusy) return;
    const impactBlocked = impactActionBlocker();
    if (impactBlocked) return;
    const referenceBlocked = referenceBlocker("run");
    if (referenceBlocked || testRunDisabledReason !== null) return;
    setTestScope(scope);
  }, [impactActionBlocker, referenceBlocker, runDockBusy, testRunDisabledReason]);

  useEffect(() => {
    if (testScope !== null && (testRunDisabledReason !== null || !testScopeNodeExists)) {
      setTestScope(null);
    }
  }, [testRunDisabledReason, testScope, testScopeNodeExists]);
  const pasteNavigationBlocker = useCallback((): string | null =>
    isStudioPasteNavigationPending({
      operation: pendingPasteOperationRef.current,
      epoch: pendingPasteEpochGuardRef.current!.hasActiveOperation(),
      controller: pendingPasteControllerRef.current!.hasActivePlan(),
      deferred: deferredPasteTokenRef.current !== null,
      resolving: pasteResolving,
    })
      ? STUDIO_PASTE_NAVIGATION_MESSAGE
      : null, [pasteResolving]);

  useEffect(() => {
    effectiveTestScopeRef.current = effectiveTestScope;
  }, [effectiveTestScope]);
  const handleRunDockRunning = useCallback((running: boolean): void => {
    if (running) lastRunWasScopedRef.current = effectiveTestScopeRef.current !== null;
    setRunDockBusy(running);
  }, []);
  useEffect(() => {
    // A finished, unscoped run where every node reports "done" counts as the
    // flow's successful test; a single "error" (or a scoped run) does not.
    if (runDockBusy || lastRunWasScopedRef.current) return;
    const values = Object.values(statuses);
    if (values.length === 0) return;
    if (values.every((status) => status === "done")) setHasSuccessfulTest(true);
  }, [runDockBusy, statuses]);
  // While histories load, promote Launch (the pre-ladder default) so the
  // header never flashes "Run test" at an owner whose flow is already live.
  const studioReadinessKnown =
    versionHistory.status !== "loading" && deploymentHistory.status !== "loading";
  const alreadyDeployed =
    deploymentHistory.status === "ready" && deploymentHistory.deployments.length > 0;
  const hasSavedVersion =
    versionHistory.status === "ready" && versionHistory.versions.length > 0;
  const studioPrimaryAction: "run-test" | "save-version" | "launch" | "view-endpoint" =
    launch?.slug
      ? "view-endpoint"
      : !studioReadinessKnown || alreadyDeployed || hasSavedVersion
        ? "launch"
        : !hasSuccessfulTest
          ? "run-test"
          : "save-version";

  const recoveryIsDirty = useCallback((): boolean => {
    const currentGraph = historyRef.current?.graph;
    const baseline = installedBaselineFingerprintRef.current;
    const saveState = saveCoordinatorRef.current?.recoveryState() ?? {
      scheduled: false, inflight: false, retryable: false, impact: false,
    };
    return Boolean(
      (currentGraph && baseline !== null && flowSaveFingerprint(currentGraph) !== baseline) ||
      saveState.scheduled || saveState.inflight || saveState.retryable || saveState.impact ||
      referenceBlocker("save") || pasteNavigationBlocker() ||
      studioNavigationCoordinatorRef.current.isBusy() || workbookSwitchRef.current !== null ||
      pendingHistoryNavigationRef.current,
    );
  }, [pasteNavigationBlocker, referenceBlocker]);

  const writeRecoverySnapshot = useCallback((
    force = false,
    previousKey: string | null = null,
  ): "stored" | "clean" | "failed" => {
    if (typeof window === "undefined" || (!force && !recoveryIsDirty())) return "clean";
    const key = recoveryStorageKeyRef.current;
    const routeScope = recoveryRouteScopeRef.current;
    const sessionNonce = recoverySessionNonceRef.current;
    const currentGraph = historyRef.current?.graph;
    const storage = recoveryStorageRef.current;
    const owner = ownerScopeHashRef.current;
    if (!key || !routeScope || !sessionNonce || !owner || !currentGraph) return "failed";
    if (storage === null) {
      setRecoveryUi({
        state: "warning",
        message: "Browser recovery is unavailable. Keep this tab open and save before leaving.",
      });
      return "failed";
    }
    const saveState = saveCoordinatorRef.current!.recoveryState();
    const encoded = encodeStudioRecovery({
      ownerScopeHash: owner,
      routeScope,
      sessionNonce,
      graph: currentGraph,
      baseSavedFingerprint: baseSavedFingerprintRef.current,
      now: Date.now(),
      flags: {
        ...emptyStudioRecoveryFlags(),
        impact: saveState.impact,
        reference: referenceBlocker("save") !== null,
        paste: pasteNavigationBlocker() !== null,
        inflight: saveState.inflight || studioNavigationCoordinatorRef.current.isBusy() ||
          workbookSwitchRef.current !== null || pendingHistoryNavigationRef.current,
        scheduled: saveState.scheduled,
        retryable: saveState.retryable,
      },
    });
    const stored = encoded.status === "ready"
      ? previousKey && previousKey !== key
        ? rekeyStudioRecovery(storage, previousKey, key, encoded.text).status === "migrated"
        : writeStudioRecovery(storage, key, encoded.text).status === "stored"
      : false;
    if (!stored) {
      setRecoveryUi({
        state: "warning",
        message: "This workflow graph is not available for browser recovery. Keep this tab open and save before leaving.",
      });
      return "failed";
    }
    return "stored";
  }, [pasteNavigationBlocker, recoveryIsDirty, referenceBlocker]);
  writeRecoverySnapshotRef.current = writeRecoverySnapshot;
  recoveryIsDirtyRef.current = recoveryIsDirty;

  const cancelPendingPaste = useCallback((message?: string, discardDeferred = false): void => {
    const hadPendingOperation = pendingPasteOperationRef.current ||
      pendingPasteEpochGuardRef.current!.hasActiveOperation() ||
      pendingPasteControllerRef.current!.hasActivePlan();
    if (discardDeferred) pendingPasteEpochGuardRef.current!.cancelForGraphMutation();
    else pendingPasteEpochGuardRef.current!.cancel();
    pendingPasteControllerRef.current!.cancel();
    if (discardDeferred) {
      const deferredToken = deferredPasteTokenRef.current;
      if (deferredToken !== null) discardDeferredPasteIntent(deferredToken);
      deferredPasteTokenRef.current = null;
    }
    pendingPasteOperationRef.current = false;
    setPasteResolving(false);
    if (message && hadPendingOperation) {
      setPasteResolutionError(message);
      setCommandAnnouncement(message);
    }
  }, []);

  const replaceSelection = useCallback((next: GraphSelection): void => {
    if (graphSelectionsEqual(selectionRef.current, next)) return;
    selectionRef.current = next;
    setSelection(next);
  }, []);

  const replaceMeasuredBounds = useCallback((next: Readonly<Record<string, NodeBounds>>): void => {
    measuredBoundsRef.current = next;
    setMeasuredBounds((current) => nodeBoundsRecordsEqual(current, next) ? current : next);
  }, []);

  const resetLoadedGraph = useCallback((nextGraph: SupportedFlowGraph): void => {
    cancelPendingPaste(undefined, true);
    const incomingFirstSaveRowId = incomingFirstSaveRowIdRef.current;
    incomingFirstSaveRowIdRef.current = null;
    const authoritativeFingerprint = flowSaveFingerprint(nextGraph);
    const firstSave = incomingFirstSaveRowId === null
      ? null
      : takeMatchingFirstSaveSessionHandoff(
        incomingFirstSaveRowId,
        authoritativeFingerprint,
      );
    if (firstSave) {
      const restored = structuredClone(firstSave.history);
      const restoredSelection = pruneGraphSelection(firstSave.selection, restored.graph);
      const restoredBounds = Object.fromEntries(
        Object.entries(firstSave.measuredBounds).filter(([nodeId]) =>
          restoredSelection.nodeIds.includes(nodeId)),
      );
      historyRef.current = restored;
      referenceGateRef.current.reset(sessionParentFlowId, restored.graph);
      setReferenceSaveBlocked(
        referenceGateRef.current.blocker("save")?.message ?? null,
      );
      setHistory(restored);
      selectionRef.current = restoredSelection;
      setSelection(restoredSelection);
      measuredBoundsRef.current = restoredBounds;
      setMeasuredBounds(restoredBounds);
      canvasViewportRef.current = firstSave.viewport;
      setInitialCanvasViewport(firstSave.viewport ?? undefined);
      restoredFirstSaveGraphRef.current = {
        authoritativeFingerprint,
        currentFingerprint: firstSave.currentFingerprint,
      };
      return;
    }
    const current = historyRef.current;
    const next = current
      ? resetGraphHistory(current, nextGraph)
      : createGraphHistory(nextGraph);
    historyRef.current = next;
    referenceGateRef.current.reset(sessionParentFlowId, nextGraph);
    setReferenceSaveBlocked(referenceGateRef.current.blocker("save")?.message ?? null);
    setHistory(next);
    replaceSelection(normalizeGraphSelection([], [], null));
    replaceMeasuredBounds({});
  }, [cancelPendingPaste, replaceMeasuredBounds, replaceSelection, sessionParentFlowId]);

  const snapshotFirstSaveHandoff = useCallback((migration: {
    readonly rowId: string;
    readonly persistedFingerprint: string;
  }): void => {
    const currentHistory = historyRef.current;
    if (!currentHistory) return;
    const currentFingerprint = flowSaveFingerprint(currentHistory.graph);
    const acceptedAuthoritativeFingerprints = [...new Set([
      migration.persistedFingerprint,
      baseSavedFingerprintRef.current,
      ...persistedSnapshotsRef.current.keys(),
      currentFingerprint,
    ].filter((fingerprint): fingerprint is string => fingerprint !== null))];
    storeFirstSaveSessionHandoff({
      rowId: migration.rowId,
      persistedFingerprint: migration.persistedFingerprint,
      currentFingerprint,
      acceptedAuthoritativeFingerprints,
      history: currentHistory,
      selection: selectionRef.current,
      measuredBounds: measuredBoundsRef.current,
      viewport: canvasViewportRef.current,
      createdAt: Date.now(),
    });
  }, []);

  const recordAuthoritativeGraph = useCallback((
    nextGraph: SupportedFlowGraph,
    rowId: string | null,
  ): void => {
    authoritativeGraphRef.current = structuredClone(nextGraph);
    authoritativeRowIdRef.current = rowId;
    baseSavedFingerprintRef.current = rowId === null ? null : flowSaveFingerprint(nextGraph);
    setPendingAuthoritativeLoad({ graph: structuredClone(nextGraph), rowId });
    setAuthoritativeLoadVersion((version) => version + 1);
  }, []);

  const finishCreatedMigration = useCallback((): void => {
    const migration = pendingCreatedMigrationRef.current;
    const owner = ownerScopeHashRef.current;
    const sessionNonce = recoverySessionNonceRef.current;
    if (migration === null || owner === null || sessionNonce === null) return;
    const previousKey = recoveryStorageKeyRef.current;
    const previousRouteScope = recoveryRouteScopeRef.current;
    const identity = resolveStudioRecoveryRouteIdentity({
      persistedRowId: migration.rowId,
      sessionNonce,
      template,
      authoritativeFingerprint: migration.fingerprint,
    });
    const nextKey = studioRecoveryStorageKey(owner, identity.routeScope, sessionNonce);
    recoveryRouteScopeRef.current = identity.routeScope;
    recoveryStorageKeyRef.current = nextKey;
    baseSavedFingerprintRef.current = migration.fingerprint;
    const outcome = writeRecoverySnapshotRef.current(true, previousKey);
    const binding = recoveryBindingAfterMigration(
      outcome === "stored",
      { storageKey: previousKey, routeScope: previousRouteScope },
      { storageKey: nextKey, routeScope: identity.routeScope },
    );
    recoveryStorageKeyRef.current = binding.storageKey;
    recoveryRouteScopeRef.current = binding.routeScope;
    if (outcome !== "stored") {
      return;
    }

    const savedGraph = persistedSnapshotsRef.current.get(migration.fingerprint);
    if (savedGraph) authoritativeGraphRef.current = structuredClone(savedGraph);
    authoritativeRowIdRef.current = migration.rowId;
    createdRowAwaitingPersistRef.current = null;
    pendingCreatedMigrationRef.current = null;
    if (migration.current) {
      const currentGraph = historyRef.current?.graph;
      if (currentGraph && flowSaveFingerprint(currentGraph) === migration.fingerprint) {
        installedBaselineFingerprintRef.current = migration.fingerprint;
        const storage = recoveryStorageRef.current;
        if (storage !== null) removeStudioRecovery(storage, nextKey);
        recoveryEnvelopeRef.current = null;
        setRecoveryUi(null);
      }
    }
    if (pendingStudioNavigationRef.current === null) {
      beginRouteEffectRef.current(() => {
        const outgoingHandoff = {
          rowId: migration.rowId,
          persistedFingerprint: migration.fingerprint,
        };
        outgoingFirstSaveHandoffRef.current = outgoingHandoff;
        snapshotFirstSaveHandoff(outgoingHandoff);
        router.replace(`/build/${encodeURIComponent(migration.rowId)}`);
      });
    }
  }, [router, snapshotFirstSaveHandoff, template]);
  finishCreatedMigrationRef.current = finishCreatedMigration;

  const commandContext = useMemo<BuilderCommandContext>(() => ({
    canUndo: (history?.past.length ?? 0) > 0,
    canRedo: (history?.future.length ?? 0) > 0,
    canPaste: clipboardFragment !== null || clipboardReadAvailable,
    selectedNodeIds: selection.nodeIds,
    selectedEdgeIds: selection.edgeIds,
    boundedNodeIds: Object.keys(measuredBounds).sort(),
    graphNodeCount: graph?.nodes.length ?? 0,
  }), [history, clipboardFragment, clipboardReadAvailable, selection, measuredBounds, graph]);

  useEffect(() => {
    setClipboardReadAvailable(typeof navigator !== "undefined" && Boolean(navigator.clipboard?.readText));
  }, []);

  const saveCoordinatorRef = useRef<FlowSaveCoordinator | null>(null);
  if (saveCoordinatorRef.current === null) {
    saveCoordinatorRef.current = new FlowSaveCoordinator(
      isNew ? null : flowId,
      {
        create: async (next: SupportedFlowGraph): Promise<string> => {
          persistedSnapshotsRef.current.set(flowSaveFingerprint(next), structuredClone(next));
          const res = await fetch("/api/flows", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: next.name, graph: next }),
          });
          if (!res.ok) throw new Error(`Create failed (${res.status})`);
          const data: unknown = await res.json();
          const rowId = parseCreatedFlowId(data);
          if (rowId === null) {
            throw new Error("Create response missing persisted flow id.");
          }
          const bootstrapToken = referenceBootstrapTokenRef.current;
          if (bootstrapToken !== null) {
            bindReferenceBootstrapGraph(bootstrapToken, rowId);
          }
          const deferredPasteToken = deferredPasteTokenRef.current;
          if (deferredPasteToken !== null) {
            bindDeferredPasteIntent(deferredPasteToken, rowId);
          }
          return rowId;
        },
        update: async (
          rowId: string,
          next: SupportedFlowGraph,
          impactReceipt?: string,
        ): Promise<void> => {
          persistedSnapshotsRef.current.set(flowSaveFingerprint(next), structuredClone(next));
          const res = await fetch(`/api/flows/${encodeURIComponent(rowId)}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: next.name,
              graph: next,
              ...(impactReceipt === undefined ? {} : { impactReceipt }),
            }),
          });
          if (res.ok) return;
          const data: unknown = await res.json().catch(() => null);
          const impactRequired = ImpactRequiredError.parse(res.status, data);
          if (impactRequired) throw impactRequired;
          throw new Error(`Save failed (${res.status})`);
        },
      },
      {
        onCreated: (rowId) => {
          persistedIdRef.current = rowId;
          createdRowAwaitingPersistRef.current = rowId;
          setPersistedId(rowId);
          const pending = pendingStudioNavigationRef.current;
          if (pending !== null) {
            pending.createdRowId = rowId;
            pending.path = resolveStudioNavigationPathAfterCreate(pending.path, rowId);
          }
        },
        onSavingChange: setSaving,
        onError: (error) => {
          if (error instanceof ImpactRequiredError) {
            setSaveError(null);
            return;
          }
          setSaveError(
            error === null
              ? null
              : error instanceof Error
                ? error.message
                : "Save failed.",
          );
        },
        onImpactPendingChange: (pending) => {
          setImpactPending(pending);
          setImpactDialogOpen(pending !== null);
          if (pending === null) setImpactConfirming(false);
        },
        onPersisted: (event) => {
          baseSavedFingerprintRef.current = event.fingerprint;
          installedBaselineFingerprintRef.current = event.fingerprint;
          const persistedSnapshot = persistedSnapshotsRef.current.get(event.fingerprint);
          if (persistedSnapshot) authoritativeGraphRef.current = structuredClone(persistedSnapshot);
          persistedSnapshotsRef.current.delete(event.fingerprint);
          setRecoveryVersion((version) => version + 1);
          const currentGraph = historyRef.current?.graph;
          const currentKey = recoveryStorageKeyRef.current;
          if (createdRowAwaitingPersistRef.current === event.rowId) {
            pendingCreatedMigrationRef.current = {
              rowId: event.rowId,
              fingerprint: event.fingerprint,
              current: event.current,
            };
            finishCreatedMigrationRef.current();
            return;
          }
          if (currentGraph && event.current && flowSaveFingerprint(currentGraph) === event.fingerprint &&
              event.rowId === persistedIdRef.current) {
            if (recoveryStorageRef.current !== null && currentKey !== null) {
              removeStudioRecovery(recoveryStorageRef.current, currentKey);
            }
            authoritativeGraphRef.current = structuredClone(currentGraph);
            recoveryEnvelopeRef.current = null;
            setRecoveryUi(null);
            return;
          }
          writeRecoverySnapshotRef.current();
        },
      },
      SAVE_DEBOUNCE_MS,
    );
  }

  const bootstrapReferenceParent = useCallback((next: SupportedFlowGraph): Promise<void> => {
    const existingToken = referenceBootstrapTokenRef.current;
    if (existingToken !== null) {
      updateReferenceBootstrapGraph(existingToken, next);
      return Promise.resolve();
    }
    const token = stageReferenceBootstrapGraph(next);
    referenceBootstrapTokenRef.current = token;
    setReferenceSaveBlocked("Creating a parent flow before reusable flow verification.");
    return saveCoordinatorRef.current!.saveNow(createReferenceBootstrapGraph(next)).catch((error: unknown) => {
      setReferenceSaveBlocked("Reusable flow setup could not create its parent flow. Not saved.");
      throw error;
    });
  }, []);

  // Prefill the payout field with the workspace's saved wallet, if any.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me");
        if (!res.ok) throw new Error(`Owner lookup failed (${res.status})`);
        const body: unknown = await res.json();
        const ownerId =
          typeof body === "object" && body !== null && typeof (body as { ownerId?: unknown }).ownerId === "string"
            ? (body as { ownerId: string }).ownerId
            : null;
        const address =
          typeof body === "object" && body !== null
            ? (body as { wallet?: { address?: string } | null }).wallet?.address
            : undefined;
        if (ownerId === null) throw new Error("Owner lookup returned no owner id");
        if (!cancelled) {
          const scope = studioRecoveryOwnerScope(ownerId);
          ownerScopeHashRef.current = scope;
          setOwnerScopeHash(scope);
          setOwnerLoadError(null);
        }
        if (!cancelled && typeof address === "string" && address) {
          setPayoutAddress((prev) => (prev === "" ? address : prev));
        }
      } catch {
        if (!cancelled) {
          setOwnerLoadError("Could not verify the workflow owner. Retry to load browser recovery safely.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerLoadRetry]);

  // Connection reads are metadata-only and deliberately independent from
  // graph/project loading. HTTP editing can surface this state later while
  // every other node remains usable if the connection service is absent.
  useEffect(() => {
    let cancelled = false;
    const owner = ownerScopeHash;
    const contextKey = connectionMetadataContextKey;
    setConnectionMetadataState({ contextKey, status: "loading", choices: Object.freeze([]) });
    if (owner === null) return;
    const client = createConnectionClient();
    void client.list({ limit: 100 }).then((envelope) => {
      if (cancelled || ownerScopeHashRef.current !== owner ||
          connectionMetadataContextKeyRef.current !== contextKey) return;
      setConnectionMetadataState({
        contextKey,
        status: "ready",
        choices: connectionChoices(envelope),
      });
    }).catch((error: unknown) => {
      if (cancelled || ownerScopeHashRef.current !== owner ||
          connectionMetadataContextKeyRef.current !== contextKey) return;
      const status: ConnectionChoicesStatus =
        error instanceof ConnectionClientError && error.error !== "connection service unavailable"
          ? "error"
          : "unavailable";
      setConnectionMetadataState({ contextKey, status, choices: Object.freeze([]) });
    });
    return () => {
      cancelled = true;
    };
  }, [connectionMetadataContextKey, ownerScopeHash]);

  useEffect(() => {
    apiOperationPickerContextRef.current = null;
    setApiOperationPickerOpen(false);
  }, [operationClosureContextKey]);

  // --- Initial load -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      if (isNew) {
        if (template) {
          try {
            const res = await fetch(
              `/api/templates?slug=${encodeURIComponent(template)}`,
            );
            if (res.ok) {
              const data: unknown = await res.json();
              const g = parseTemplateGraph(data);
              if (g && !cancelled) {
                // Templates ship with a suggested price so launch = priced.
                const suggested =
                  typeof data === "object" && data !== null
                    ? (data as { template?: { suggestedPriceUsdc?: unknown } })
                        .template?.suggestedPriceUsdc
                    : undefined;
                if (typeof suggested === "number" && suggested >= 0) {
                  setPriceUsdc(String(suggested));
                }
                // Templates were authored on a 240px pitch that predates the
                // current card width — re-lay them so nothing opens overlapped.
                let seeded = { ...g, id: emptyGraph().id };
                try {
                  const positions = spreadLayout(layoutGraph(seeded));
                  seeded = {
                    ...seeded,
                    nodes: seeded.nodes.map((node) =>
                      positions[node.id] ? { ...node, position: positions[node.id] } : node,
                    ),
                  };
                } catch {
                  // Layout is cosmetic; ship the template's own positions on failure.
                }
                recordAuthoritativeGraph(seeded, null);
                return;
              }
            }
          } catch {
            // Fall through to empty graph below.
          }
        }
        if (!cancelled) {
          const initial = emptyGraph();
          recordAuthoritativeGraph(initial, null);
        }
        return;
      }

      try {
        const res = await fetch(`/api/flows/${encodeURIComponent(flowId)}`);
        if (!res.ok) throw new Error(`Failed to load flow (${res.status})`);
        const data: unknown = await res.json();
        const persisted = parsePersistedFlow(data);
        if (!persisted) throw new Error("Malformed flow payload.");
        if (!cancelled) {
          recordAuthoritativeGraph(persisted.graph, persisted.rowId);
          persistedIdRef.current = persisted.rowId;
          setPersistedId(persisted.rowId);
          if (hasReferenceBootstrapMarker(persisted.graph)) {
            setReferenceSaveBlocked(
              "Reusable flow setup was interrupted. Add or choose the reusable flow again. Not saved.",
            );
          }
        }
      } catch (err: unknown) {
        if (!cancelled) {
          if (pendingTabFocusRef.current === flowId) {
            pendingTabFocusRef.current = null;
            clearStoredWorkbookTabFocus();
          }
          setLoadError(
            err instanceof Error ? err.message : "Failed to load flow.",
          );
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [isNew, template, flowId, pendingTabFocusRef, recordAuthoritativeGraph, flowLoadRetry]);

  const loadProjectState = useCallback(() => {
    cancelRequest(deploymentRefreshSlotRef.current);
    const currentRowId = persistedIdRef.current;
    const operation = claimLatestRequest(projectLoadSlotRef.current, currentRowId);
    const { controller } = operation;
    const commitProjectLoad = (write: () => void): boolean => {
      if (!ownsRequest(projectLoadSlotRef.current, operation, persistedIdRef.current)) return false;
      write();
      return true;
    };
    commitProjectLoad(() => {
      setContextLoading(true);
      if (currentRowId) {
        setVersionHistory({ status: "loading" });
        setDeploymentHistory({ status: "loading" });
      }
    });
    void (async () => {
      const contextRequest: Promise<{
        readonly context: FlowWorkbookContext;
        readonly tabs: readonly WorkbookFlowTab[];
      }> = !isNew
        ? fetch(`/api/v2/flows/${encodeURIComponent(flowId)}/workbook`, {
            signal: controller.signal,
          }).then(async (res) => {
            if (!res.ok) throw new Error("Project context unavailable.");
            const parsed = parseFlowWorkbookEnvelope(await res.json());
            if (!parsed || !parsed.tabs.some((tab) => tab.flowId === currentRowId)) {
              throw new Error("Project context unavailable.");
            }
            return parsed;
          })
        : fetch("/api/v2/context", { signal: controller.signal }).then(async (res) => {
            if (!res.ok) throw new Error("Project context unavailable.");
            const parsed = parsePersonalContextEnvelope(await res.json());
            if (!parsed) throw new Error("Project context unavailable.");
            return { context: parsed, tabs: [] };
          });
      const versionsRequest = currentRowId
        ? fetch(`/api/v2/flows/${encodeURIComponent(currentRowId)}/versions`, {
            signal: controller.signal,
          }).then(async (res) => {
            if (!res.ok) throw new Error("Version history unavailable.");
            const parsed = parseVersionSummariesEnvelope(await res.json());
            if (!parsed) throw new Error("Version history unavailable.");
            return parsed;
          })
        : Promise.resolve([]);
      const [contextResult, versionsResult] = await Promise.allSettled([
        contextRequest,
        versionsRequest,
      ]);
      let deploymentsResult: PromiseSettledResult<readonly DeploymentRecord[]>;
      if (!currentRowId) {
        deploymentsResult = { status: "fulfilled", value: [] };
      } else if (contextResult.status === "fulfilled") {
        const test = contextResult.value.context.environments.find((item) => item.kind === "test");
        const live = contextResult.value.context.environments.find((item) => item.kind === "live");
        if (!test || !live) {
          deploymentsResult = { status: "rejected", reason: new Error("Deployment history unavailable.") };
        } else {
          deploymentsResult = await fetch(
            `/api/v2/flows/${encodeURIComponent(currentRowId)}/deployments`,
            { signal: controller.signal },
          ).then(async (res): Promise<PromiseSettledResult<readonly DeploymentRecord[]>> => {
            if (!res.ok) return { status: "rejected", reason: new Error("Deployment history unavailable.") };
            const parsed = parseDeploymentsEnvelope(await res.json(), {
              flowId: currentRowId,
              testEnvironmentId: test.id,
              liveEnvironmentId: live.id,
            });
            return parsed
              ? { status: "fulfilled", value: parsed }
              : { status: "rejected", reason: new Error("Deployment history unavailable.") };
          }).catch((reason: unknown) => ({ status: "rejected", reason }));
        }
      } else {
        deploymentsResult = { status: "rejected", reason: new Error("Deployment history unavailable.") };
      }
      if (!ownsRequest(projectLoadSlotRef.current, operation, persistedIdRef.current)) return;
      commitProjectLoad(() => {
        if (contextResult.status === "fulfilled") {
          setProjectContext(contextResult.value.context);
          setWorkbookTabs(contextResult.value.tabs);
          if (pendingTabFocusRef.current === flowId) clearStoredWorkbookTabFocus();
          setContextError(null);
        } else {
          setProjectContext(null);
          setWorkbookTabs([]);
          if (pendingTabFocusRef.current === flowId) {
            pendingTabFocusRef.current = null;
            clearStoredWorkbookTabFocus();
          }
          setContextError("Project context unavailable.");
        }
      });
      commitProjectLoad(() => {
        setVersionHistory(versionsResult.status === "fulfilled"
          ? { status: "ready", versions: versionsResult.value }
          : { status: "error", message: "Version history unavailable." });
      });
      commitProjectLoad(() => {
        setDeploymentHistory(deploymentsResult.status === "fulfilled"
          ? { status: "ready", deployments: deploymentsResult.value }
          : { status: "error" });
      });
      commitProjectLoad(() => setContextLoading(false));
      releaseRequest(projectLoadSlotRef.current, operation);
    })();
    return operation;
    // `persistedId` is not read here — the body goes through persistedIdRef so
    // an in-flight load keeps checking ownership against the current row id
    // rather than the one captured when the callback was made. Listing it as a
    // dependency only rebuilt the callback for a value it never used.
  }, [flowId, isNew, pendingTabFocusRef]);

  useEffect(() => {
    const operation = loadProjectState();
    return () => operation.controller.abort();
  }, [loadProjectState]);

  useEffect(() => {
    versionReviewAbortRef.current?.abort();
    const reviewFlowId = persistedId;
    const reviewVersionId = selectedVersionId;
    if (!reviewFlowId || !reviewVersionId || versionHistory.status !== "ready") {
      setSelectedVersion(null);
      if (reviewVersionId) setVersionReviewDiff({ status: "error" });
      return;
    }
    const latest = [...versionHistory.versions].sort(
      (left, right) => right.versionNumber - left.versionNumber,
    )[0];
    const selectedSummary = versionHistory.versions.find((version) => version.id === reviewVersionId);
    if (!latest || !selectedSummary || selectedSummary.flowId !== reviewFlowId || latest.flowId !== reviewFlowId) {
      setSelectedVersion(null);
      setVersionReviewDiff({ status: "error" });
      return;
    }
    const controller = new AbortController();
    versionReviewAbortRef.current = controller;
    const generation = versionReviewGenerationRef.current + 1;
    versionReviewGenerationRef.current = generation;
    setSelectedVersion(null);
    setVersionReviewDiff({ status: "loading" });
    const selectedPath = `/api/v2/flows/${encodeURIComponent(reviewFlowId)}/versions/${encodeURIComponent(reviewVersionId)}`;
    const compareQuery = new URLSearchParams({ from: reviewVersionId, to: latest.id });
    const comparePath = `/api/v2/flows/${encodeURIComponent(reviewFlowId)}/versions/compare?${compareQuery.toString()}`;
    void Promise.all([
      fetch(selectedPath, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("review unavailable");
        const version = parseVersionRestoreEnvelope(await response.json(), {
          flowId: reviewFlowId,
          versionId: reviewVersionId,
        });
        if (!version) throw new Error("review unavailable");
        return version;
      }),
      fetch(comparePath, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("review unavailable");
        const diff = parseVersionDiffEnvelope(await response.json());
        if (!diff) {
          throw new Error("review unavailable");
        }
        return diff;
      }),
    ]).then(([version, diff]) => {
      if (controller.signal.aborted || versionReviewGenerationRef.current !== generation ||
        persistedIdRef.current !== reviewFlowId) return;
      if (!versionReviewEnvelopeMatches({
        selectedRecord: version,
        selectedSummary,
        latestSummary: latest,
        diff,
      })) throw new Error("review unavailable");
      setSelectedVersion(version);
      setVersionReviewDiff({ status: "ready", diff });
    }).catch(() => {
      if (controller.signal.aborted || versionReviewGenerationRef.current !== generation) return;
      setSelectedVersion(null);
      setVersionReviewDiff({ status: "error" });
    });
    return () => controller.abort();
  }, [persistedId, selectedVersionId, versionHistory]);

  // --- Persistence --------------------------------------------------------
  const supersedeWithoutSaving = useCallback((next: SupportedFlowGraph): void => {
    saveCoordinatorRef.current!.supersedeWithoutSaving(next);
  }, []);

  const persist = useCallback((next: SupportedFlowGraph): Promise<void> => {
    const activeBootstrapToken = referenceBootstrapTokenRef.current;
    if (activeBootstrapToken !== null) {
      supersedeWithoutSaving(next);
      updateReferenceBootstrapGraph(activeBootstrapToken, next);
      const activeBlocker = referenceBlocker("save");
      setReferenceSaveBlocked(
        activeBlocker?.message ?? "Finishing parent flow creation. Latest changes are not saved yet.",
      );
      return Promise.resolve();
    }
    const blocker = referenceBlocker("save");
    if (blocker) {
      supersedeWithoutSaving(next);
      setCommandAnnouncement(blocker.message);
      setReferenceSaveBlocked(blocker.message);
      if (sessionParentFlowId === null) return bootstrapReferenceParent(next);
      return Promise.resolve();
    }
    setReferenceSaveBlocked(null);
    return saveCoordinatorRef.current!.saveNow(next);
  }, [bootstrapReferenceParent, referenceBlocker, sessionParentFlowId, supersedeWithoutSaving]);

  const scheduleSave = useCallback(
    (next: SupportedFlowGraph): StudioReferenceBlocker | null => {
      const activeBootstrapToken = referenceBootstrapTokenRef.current;
      if (activeBootstrapToken !== null) {
        supersedeWithoutSaving(next);
        updateReferenceBootstrapGraph(activeBootstrapToken, next);
        const activeBlocker = referenceBlocker("save");
        setReferenceSaveBlocked(
          activeBlocker?.message ?? "Finishing parent flow creation. Latest changes are not saved yet.",
        );
        return activeBlocker;
      }
      const blocker = referenceBlocker("save");
      if (blocker) {
        supersedeWithoutSaving(next);
        setReferenceSaveBlocked(blocker.message);
        if (sessionParentFlowId === null) {
          void bootstrapReferenceParent(next).catch(() => undefined);
        }
        return blocker;
      }
      setReferenceSaveBlocked(null);
      saveCoordinatorRef.current!.schedule(next);
      return null;
    },
    [bootstrapReferenceParent, referenceBlocker, sessionParentFlowId, supersedeWithoutSaving],
  );

  useEffect(() => {
    const restored = restoredFirstSaveGraphRef.current;
    if (!restored || history === null ||
        flowSaveFingerprint(history.graph) !== restored.currentFingerprint) return;
    restoredFirstSaveGraphRef.current = null;
    // The old coordinator flushes before disposing, but its final PUT can race
    // this remount's authoritative GET. Route a different current snapshot
    // through the same reusable-flow verification gate as every editor change.
    if (restored.currentFingerprint !== restored.authoritativeFingerprint) {
      scheduleSave(history.graph);
    }
  }, [history, scheduleSave]);

  useEffect(() => {
    if (typeof window === "undefined" || !studioRecoveryBootstrapReady({
      ownerScopeHash,
      authoritativeReady: pendingAuthoritativeLoad !== null,
    }) || pendingAuthoritativeLoad === null || ownerScopeHash === null) return;
    const authoritative = pendingAuthoritativeLoad.graph;
    const sessionNonce = recoverySessionNonceRef.current;
    if (sessionNonce === null) return;
    const initialization = `${ownerScopeHash}\0${authoritativeLoadVersion}`;
    if (recoveryInitializedRef.current === initialization) return;
    recoveryInitializedRef.current = initialization;

    const authoritativeFingerprint = flowSaveFingerprint(authoritative);
    const identity = resolveStudioRecoveryRouteIdentity({
      persistedRowId: pendingAuthoritativeLoad.rowId,
      sessionNonce,
      template,
      authoritativeFingerprint,
    });
    const storageKey = studioRecoveryStorageKey(ownerScopeHash, identity.routeScope, sessionNonce);
    recoveryRouteScopeRef.current = identity.routeScope;
    recoveryStorageKeyRef.current = storageKey;
    baseSavedFingerprintRef.current = identity.baseSavedFingerprint;

    const holdDeferredWork = (): void => {
      const rowId = pendingAuthoritativeLoad.rowId;
      heldDeferredGraphRef.current = rowId ? peekReferenceBootstrapGraph(rowId) : null;
      heldDeferredPasteRef.current = rowId ? peekDeferredPasteIntent(rowId) : null;
    };
    const installAuthoritative = (resumeDeferred: boolean): void => {
      holdDeferredWork();
      const chosen = heldDeferredGraphRef.current ?? authoritative;
      installedBaselineFingerprintRef.current = authoritativeFingerprint;
      resetLoadedGraph(chosen);
      setPendingAuthoritativeLoad(null);
      if (resumeDeferred) {
        const rowId = pendingAuthoritativeLoad.rowId;
        if (rowId && heldDeferredGraphRef.current) {
          consumeReferenceBootstrapGraph(rowId);
          if (referenceGateRef.current.blocker("save") === null) {
            saveCoordinatorRef.current!.schedule(heldDeferredGraphRef.current);
          }
        }
        if (rowId && heldDeferredPasteRef.current) {
          const resumed = consumeDeferredPasteIntent(rowId);
          if (resumed) setRouteDeferredPasteIntent(resumed);
        }
        heldDeferredGraphRef.current = null;
        heldDeferredPasteRef.current = null;
      }
    };
    const installWarning = (message: string): void => {
      installAuthoritative(false);
      setRecoveryUi({ state: "warning", message });
    };

    const storage = recoveryStorageRef.current;
    if (storage === null) {
      installWarning("Browser recovery is unavailable. Keep this tab open and save before leaving.");
      return;
    }
    const stored = readStudioRecovery(storage, storageKey);
    if (stored.status === "unavailable") {
      installWarning("Browser recovery is unavailable. Keep this tab open and save before leaving.");
      return;
    }

    if (stored.status === "missing") {
      installAuthoritative(true);
      return;
    }
    if (stored.status === "found") {
      const parsed = parseStudioRecovery(stored.text, {
        ownerScopeHash,
        routeScope: identity.routeScope,
        sessionNonce,
        now: Date.now(),
      });
      if (parsed.status === "ready") {
        recoveryEnvelopeRef.current = parsed.envelope;
        const disposition = recoveryDisposition(
          parsed.envelope,
          identity.baseSavedFingerprint,
        );
        if (disposition === "clear") {
          removeStudioRecovery(storage, storageKey);
          recoveryEnvelopeRef.current = null;
          installAuthoritative(true);
          return;
        } else if (disposition === "restore") {
          if (pendingAuthoritativeLoad.rowId) {
            discardBoundReferenceBootstrapGraph(pendingAuthoritativeLoad.rowId);
            discardBoundDeferredPasteIntent(pendingAuthoritativeLoad.rowId);
          }
          installedBaselineFingerprintRef.current = authoritativeFingerprint;
          resetLoadedGraph(parsed.envelope.graph);
          setPendingAuthoritativeLoad(null);
          setRecoveryUi({
            state: "restored",
            message: parsed.envelope.flags.paste
              ? "Recovered the workflow graph. An interrupted paste was not resumed. Save or discard this browser copy."
              : "Recovered a newer workflow graph from this browser. Save it or discard it.",
          });
          setRecoveryVersion((version) => version + 1);
          return;
        } else {
          holdDeferredWork();
          setRecoveryUi({
            state: "conflict",
            message: "Two versions of this flow changed. Choose which one to keep.",
          });
          return;
        }
      } else {
        removeStudioRecovery(storage, storageKey);
        installWarning(
          parsed.status === "unsafe"
            ? "An unsafe browser recovery copy was removed. Review this saved workflow before continuing."
            : "An invalid browser recovery copy was removed. Review this saved workflow before continuing.",
        );
        return;
      }
    }
    if (stored.status === "too-large") {
      removeStudioRecovery(storage, storageKey);
      installWarning("The browser recovery copy was too large to use safely and was removed.");
    }
  }, [
    authoritativeLoadVersion,
    ownerScopeHash,
    pendingAuthoritativeLoad,
    persist,
    referenceBlocker,
    resetLoadedGraph,
    template,
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || isNew || ownerScopeHash === null || graph === null ||
        pendingAuthoritativeLoad !== null || authoritativeLoadVersion === 0) return;
    const storage = recoveryStorageRef.current;
    if (storage === null) {
      setSubflowBreadcrumbState({ kind: "error" });
      setPinnedReferenceBannerState({ kind: "error" });
      return;
    }
    if (subflowBreadcrumbNonceRef.current === null) {
      const createNonce = () => crypto.randomUUID().replace(/-/g, "_");
      subflowBreadcrumbNonceRef.current = getOrCreateSubflowBreadcrumbNonce(storage, createNonce);
    }
    const nonce = subflowBreadcrumbNonceRef.current;
    const claimKey = `${ownerScopeHash}\0${flowId}\0${authoritativeLoadVersion}`;
    const validationKey = `${claimKey}\0${subflowBreadcrumbRetry}`;
    if (subflowBreadcrumbValidationRef.current === validationKey) return;
    subflowBreadcrumbValidationRef.current = validationKey;
    if (subflowBreadcrumbClaimRef.current !== claimKey) {
      subflowBreadcrumbClaimRef.current = claimKey;
      claimedSubflowTrailRef.current = readSubflowBreadcrumbTrail(storage, {
        nonce,
        currentFlowId: flowId,
        now: Date.now(),
      });
    }
    const request = projectSubflowBreadcrumbRequest(claimedSubflowTrailRef.current, flowId);
    if (request === null) {
      clearSubflowBreadcrumbSession(storage);
      claimedSubflowTrailRef.current = [];
      setSubflowBreadcrumbState({ kind: "error" });
      setPinnedReferenceBannerState({ kind: "error" });
      return;
    }
    subflowBreadcrumbAbortRef.current?.abort();
    subflowTrailValidatedRef.current = false;
    const controller = new AbortController();
    subflowBreadcrumbAbortRef.current = controller;
    const generation = subflowBreadcrumbGenerationRef.current + 1;
    subflowBreadcrumbGenerationRef.current = generation;
    setSubflowBreadcrumbState({ kind: "loading" });
    setPinnedReferenceBannerState({ kind: "empty" });
    void (async () => {
      try {
        const response = await fetch("/api/v2/subflows/breadcrumbs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        const value: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted || subflowBreadcrumbGenerationRef.current !== generation) return;
        const validated = response.ok ? validateSubflowBreadcrumbResponse(value, request) : null;
        if (validated === null) {
          subflowTrailValidatedRef.current = false;
          clearSubflowBreadcrumbSession(storage);
          claimedSubflowTrailRef.current = [];
          setSubflowBreadcrumbState({ kind: "error" });
          setPinnedReferenceBannerState({ kind: "error" });
          return;
        }
        subflowTrailValidatedRef.current = true;
        const items: readonly SubflowBreadcrumbDisplayItem[] = validated.crumbs.map((crumb, index) => ({
          flowId: crumb.flowId,
          label: crumb.name,
          current: index === validated.crumbs.length - 1,
        }));
        setSubflowBreadcrumbState(items.length >= 2 ? { kind: "ready", items } : { kind: "empty" });
        const localCurrent = claimedSubflowTrailRef.current.at(-1);
        const validatedCurrent = validated.crumbs.at(-1);
        const validatedParent = validated.crumbs.at(-2);
        const localPin = localCurrent?.via?.reference.kind === "pinned"
          ? localCurrent.via.reference
          : null;
        setPinnedReferenceBannerState(localPin && validatedCurrent && validatedParent &&
          validatedCurrent.flowId === localCurrent?.flowId &&
          validatedCurrent.versionId === localPin.versionId &&
          validatedCurrent.contentHash === localPin.contentHash &&
          validatedCurrent.versionNumber !== undefined
          ? {
              kind: "ready",
              parentLabel: validatedParent.name,
              versionLabel: String(validatedCurrent.versionNumber),
              contentHash: localPin.contentHash,
            }
          : { kind: "empty" });
        const focusGraph = historyRef.current?.graph;
        if (!focusGraph) return;
        const focus = consumeSubflowFocusAfterGraphLoad(storage, {
          nonce,
          targetFlowId: flowId,
          graphLoaded: true,
          nodeIds: focusGraph.nodes.map(({ id }) => id),
          now: Date.now(),
        });
        if (focus.status === "focused") {
          const nextSelection = normalizeGraphSelection([focus.originNodeId], [], focus.originNodeId);
          selectionRef.current = nextSelection;
          setSelection(nextSelection);
          setCanvasFocusNodeRequest((current) => ({
            nodeId: focus.originNodeId,
            token: (current?.token ?? 0) + 1,
          }));
        }
      } catch {
        if (controller.signal.aborted || subflowBreadcrumbGenerationRef.current !== generation) return;
        subflowTrailValidatedRef.current = false;
        clearSubflowBreadcrumbSession(storage);
        claimedSubflowTrailRef.current = [];
        setSubflowBreadcrumbState({ kind: "error" });
        setPinnedReferenceBannerState({ kind: "error" });
      }
    })();
    return () => {
      controller.abort();
      if (subflowBreadcrumbAbortRef.current === controller) {
        subflowBreadcrumbAbortRef.current = null;
        subflowBreadcrumbGenerationRef.current += 1;
        subflowBreadcrumbValidationRef.current = null;
        subflowTrailValidatedRef.current = false;
      }
    };
  }, [
    authoritativeLoadVersion,
    flowId,
    graph,
    isNew,
    ownerScopeHash,
    pendingAuthoritativeLoad,
    subflowBreadcrumbRetry,
  ]);

  useEffect(() => {
    if (ownerScopeHash !== null && pendingCreatedMigrationRef.current !== null) {
      finishCreatedMigration();
    }
  }, [finishCreatedMigration, ownerScopeHash]);

  useEffect(() => {
    if (typeof window === "undefined" || ownerScopeHash === null || authoritativeLoadVersion === 0) return;
    const sessionNonce = recoverySessionNonceRef.current;
    if (sessionNonce === null) return;
    const port = createStudioHistoryBrowserPort(window.history);
    const guard = new StudioHistoryGuard({
      history: port,
      isDirty: () => recoveryIsDirtyRef.current(),
      writeRecovery: () => writeRecoverySnapshotRef.current(),
      createNonce: () => sessionNonce,
      onBackRequest: (decision) => {
        if (window.confirm("Leave this workflow? Your browser recovery copy will be kept.")) decision.confirm();
        else decision.cancel();
      },
    });
    studioHistoryGuardRef.current = guard;
    guard.mount();

    beginRouteEffectRef.current = (effect): boolean => {
      if (pendingHistoryNavigationRef.current) return false;
      pendingHistoryNavigationRef.current = true;
      setRecoveryVersion((version) => version + 1);
      const result = guard.beginInternalNavigation(() => {
        try {
          effect();
        } finally {
          pendingHistoryNavigationRef.current = false;
          setRecoveryVersion((version) => version + 1);
        }
      });
      if (result === "blocked") {
        pendingHistoryNavigationRef.current = false;
        setRecoveryVersion((version) => version + 1);
        return false;
      }
      return true;
    };

    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      guard.handleBeforeUnload(event);
    };
    const onPageHide = (): void => guard.handlePageHide();
    const onPageShow = (event: PageTransitionEvent): void => {
      guard.handlePageShow({ persisted: event.persisted });
    };
    const onPopState = (event: PopStateEvent): void => {
      guard.handlePopState(studioHistoryMarkerFromState(event.state));
    };
    beforeUnloadHandlerRef.current = onBeforeUnload;
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("popstate", onPopState);
    return () => {
      if (beforeUnloadAttachedRef.current) {
        window.removeEventListener("beforeunload", onBeforeUnload);
        beforeUnloadAttachedRef.current = false;
      }
      if (beforeUnloadHandlerRef.current === onBeforeUnload) beforeUnloadHandlerRef.current = null;
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("popstate", onPopState);
      guard.dispose();
      if (studioHistoryGuardRef.current === guard) studioHistoryGuardRef.current = null;
      beginRouteEffectRef.current = (effect) => { effect(); return true; };
      pendingHistoryNavigationRef.current = false;
    };
  }, [authoritativeLoadVersion, ownerScopeHash]);

  useEffect(() => {
    const guard = studioHistoryGuardRef.current;
    if (guard === null) return;
    guard.sync();
    const dirty = recoveryIsDirtyRef.current();
    const beforeUnloadHandler = beforeUnloadHandlerRef.current;
    if (dirty && beforeUnloadHandler && !beforeUnloadAttachedRef.current) {
      window.addEventListener("beforeunload", beforeUnloadHandler);
      beforeUnloadAttachedRef.current = true;
    } else if (!dirty && beforeUnloadHandler && beforeUnloadAttachedRef.current) {
      window.removeEventListener("beforeunload", beforeUnloadHandler);
      beforeUnloadAttachedRef.current = false;
    }
    if (dirty) writeRecoverySnapshotRef.current();
  }, [
    history,
    impactPending,
    pasteResolving,
    recoveryVersion,
    referenceSaveBlocked,
    saving,
    busyFlowId,
  ]);

  const handleSaveRecovered = useCallback((): void => {
    if (saveCoordinatorRef.current!.recoveryState().inflight) {
      setCommandAnnouncement("Wait for the current recovery save to finish.");
      return;
    }
    const current = historyRef.current?.graph;
    if (current === undefined) return;
    setCommandAnnouncement("Saving the recovered workflow graph.");
    void persist(current);
  }, [persist]);

  const resumeHeldDeferredWork = useCallback((): void => {
    const rowId = authoritativeRowIdRef.current;
    const deferredGraph = heldDeferredGraphRef.current;
    const deferredPaste = heldDeferredPasteRef.current;
    if (rowId && deferredGraph) {
      consumeReferenceBootstrapGraph(rowId);
      scheduleSave(deferredGraph);
    }
    if (rowId && deferredPaste) {
      const resumed = consumeDeferredPasteIntent(rowId);
      if (resumed) setRouteDeferredPasteIntent(resumed);
    }
    heldDeferredGraphRef.current = null;
    heldDeferredPasteRef.current = null;
  }, [scheduleSave]);

  const handleDiscardRecovered = useCallback((): void => {
    const authoritative = authoritativeGraphRef.current;
    if (authoritative === null) return;
    if (!saveCoordinatorRef.current!.acceptAuthoritative(authoritative)) {
      setCommandAnnouncement("Wait for the recovered workflow save to finish before discarding it.");
      return;
    }
    resetLoadedGraph(authoritative);
    baseSavedFingerprintRef.current = flowSaveFingerprint(authoritative);
    installedBaselineFingerprintRef.current = flowSaveFingerprint(authoritative);
    const key = recoveryStorageKeyRef.current;
    if (recoveryStorageRef.current !== null && key !== null) {
      removeStudioRecovery(recoveryStorageRef.current, key);
    }
    recoveryEnvelopeRef.current = null;
    setRecoveryUi(null);
    setRecoveryVersion((version) => version + 1);
  }, [resetLoadedGraph]);

  const handleRecoverConflict = useCallback((): void => {
    const envelope = recoveryEnvelopeRef.current;
    if (envelope === null) return;
    const rowId = authoritativeRowIdRef.current;
    if (rowId) {
      discardBoundReferenceBootstrapGraph(rowId);
      discardBoundDeferredPasteIntent(rowId);
    }
    heldDeferredGraphRef.current = null;
    heldDeferredPasteRef.current = null;
    resetLoadedGraph(envelope.graph);
    const authoritative = authoritativeGraphRef.current;
    if (authoritative) installedBaselineFingerprintRef.current = flowSaveFingerprint(authoritative);
    setPendingAuthoritativeLoad(null);
    setRecoveryUi({
      state: "restored",
      message: envelope.flags.paste
        ? "Recovered the browser workflow graph. An interrupted paste was not resumed. Save or discard this copy."
        : "Recovered the browser workflow graph. Save it or discard it.",
    });
    setRecoveryVersion((version) => version + 1);
  }, [resetLoadedGraph]);

  const handleKeepSaved = useCallback((): void => {
    if (recoveryUi?.state === "warning" || recoveryUi?.state === "interrupted") {
      setRecoveryUi(null);
      resumeHeldDeferredWork();
      finishCreatedMigrationRef.current();
      return;
    }
    const authoritative = authoritativeGraphRef.current;
    if (recoveryUi?.state === "conflict" && authoritative) {
      if (!saveCoordinatorRef.current!.acceptAuthoritative(authoritative)) {
        setCommandAnnouncement("Wait for the current save to finish before choosing the saved workflow.");
        return;
      }
      const chosen = heldDeferredGraphRef.current ?? authoritative;
      resetLoadedGraph(chosen);
      baseSavedFingerprintRef.current = flowSaveFingerprint(authoritative);
      installedBaselineFingerprintRef.current = flowSaveFingerprint(authoritative);
      setPendingAuthoritativeLoad(null);
      const key = recoveryStorageKeyRef.current;
      if (recoveryStorageRef.current !== null && key !== null) {
        removeStudioRecovery(recoveryStorageRef.current, key);
      }
      recoveryEnvelopeRef.current = null;
      setRecoveryUi(null);
      resumeHeldDeferredWork();
      setRecoveryVersion((version) => version + 1);
      return;
    }
    handleDiscardRecovered();
  }, [handleDiscardRecovered, recoveryUi?.state, resetLoadedGraph, resumeHeldDeferredWork]);

  useEffect(() => {
    sessionMountedRef.current = true;
    saveCoordinatorRef.current!.mount();
    return () => {
      sessionMountedRef.current = false;
      const outgoingHandoff = outgoingFirstSaveHandoffRef.current;
      if (outgoingHandoff) snapshotFirstSaveHandoff(outgoingHandoff);
      cancelPendingPaste();
      void saveCoordinatorRef.current?.dispose();
    };
  }, [cancelPendingPaste, snapshotFirstSaveHandoff]);

  const dispatch = useCallback((
    command: GraphCommand,
    options: GraphDispatchOptions = {},
    persistence: StudioDispatchPersistence = { kind: "schedule" },
  ): number | null => {
    const result = runStudioTransitionMutation({
      navigationBusy: studioNavigationCoordinatorRef.current.isBusy(),
      workbookSwitching: workbookSwitchRef.current !== null,
      historyTraversal: pendingHistoryNavigationRef.current,
    }, () => {
      const current = historyRef.current;
      if (!current) return null;
      cancelPendingPaste("Paste cancelled because the flow changed. Retry paste.", true);
      try {
        const next = dispatchGraphCommand(current, command, options);
        historyRef.current = next;
        setHistory(next);
        referenceGateRef.current.reconcile(sessionParentFlowId, next.graph, "edit");
        const nextSelection = selectionAfterCommand(selectionRef.current, next.graph, command);
        replaceSelection(nextSelection);
        setMeasuredBounds((currentBounds) => Object.fromEntries(
          Object.entries(currentBounds).filter(([id]) => nextSelection.nodeIds.includes(id)),
        ));
        if (commandRequestsCanvasFocus(command)) {
          setCanvasFocusRequest((currentRequest) => currentRequest + 1);
        }
        const saveBlocker = persistence.kind === "schedule" ? scheduleSave(next.graph) : null;
        const label = options.label ?? command.kind;
        const affected = next.past.at(-1)?.affectedIds.length ?? 0;
        setCommandAnnouncement(saveBlocker?.message ?? `${label}: ${affected} affected.`);
        return affected;
      } catch {
        setCommandAnnouncement(`${options.label ?? command.kind} could not be applied.`);
        return null;
      }
    });
    if (result.status === "blocked") {
      setCommandAnnouncement("Wait for the current navigation to finish before editing.");
      return null;
    }
    return result.value;
  }, [cancelPendingPaste, replaceSelection, scheduleSave, sessionParentFlowId]);

  const undo = useCallback((): void => {
    if (studioTransitionBlocked({
      navigationBusy: studioNavigationCoordinatorRef.current.isBusy(),
      workbookSwitching: workbookSwitchRef.current !== null,
      historyTraversal: pendingHistoryNavigationRef.current,
    })) {
      setCommandAnnouncement("Wait for the current navigation to finish before editing.");
      return;
    }
    const current = historyRef.current;
    const entry = current?.past.at(-1);
    if (!current || !entry) return;
    cancelPendingPaste("Paste cancelled because the flow changed. Retry paste.", true);
    try {
      const next = undoGraphCommand(current);
      historyRef.current = next;
      setHistory(next);
      referenceGateRef.current.reconcile(sessionParentFlowId, next.graph, "undo");
      replaceSelection(pruneGraphSelection(selectionRef.current, next.graph));
      const saveBlocker = scheduleSave(next.graph);
      setCommandAnnouncement(saveBlocker?.message ?? `Undid ${entry.label}.`);
    } catch {
      setCommandAnnouncement(`Could not undo ${entry.label}.`);
    }
  }, [cancelPendingPaste, replaceSelection, scheduleSave, sessionParentFlowId]);

  const redo = useCallback((): void => {
    if (studioTransitionBlocked({
      navigationBusy: studioNavigationCoordinatorRef.current.isBusy(),
      workbookSwitching: workbookSwitchRef.current !== null,
      historyTraversal: pendingHistoryNavigationRef.current,
    })) {
      setCommandAnnouncement("Wait for the current navigation to finish before editing.");
      return;
    }
    const current = historyRef.current;
    const entry = current?.future[0];
    if (!current || !entry) return;
    cancelPendingPaste("Paste cancelled because the flow changed. Retry paste.", true);
    try {
      const next = redoGraphCommand(current);
      historyRef.current = next;
      setHistory(next);
      referenceGateRef.current.reconcile(sessionParentFlowId, next.graph, "redo");
      replaceSelection(pruneGraphSelection(selectionRef.current, next.graph));
      const saveBlocker = scheduleSave(next.graph);
      setCommandAnnouncement(saveBlocker?.message ?? `Redid ${entry.label}.`);
    } catch {
      setCommandAnnouncement(`Could not redo ${entry.label}.`);
    }
  }, [cancelPendingPaste, replaceSelection, scheduleSave, sessionParentFlowId]);

  const handleAddNode = useCallback(
    (type: NodeType) => {
      if (type === "api.operation") {
        setCommandAnnouncement("Choose a resolved API operation from the picker.");
        return;
      }
      const current = historyRef.current?.graph;
      if (!current) return;
      const offset = current.nodes.length * 28;
      dispatch({
        v: 1,
        id: genCommandId("palette"),
        kind: "node.add",
        node: {
          id: genNodeId(),
          type,
          params: {},
          position: { x: 160 + offset, y: 120 + offset },
        },
      }, { label: "Added node" });
    },
    [dispatch],
  );

  const handleParamsPatch = useCallback(
    (patch: readonly JsonPatchOp[], groupId?: string) => {
      const nodeId = selectionRef.current.primaryNodeId;
      if (!nodeId) return;
      dispatch({
        v: 1,
        id: genCommandId("inspector"),
        kind: "node.patch",
        nodeId,
        patch,
      }, { label: "Updated node", groupId });
    },
    [dispatch],
  );

  const handleVariableAdd = useCallback((variable: FlowVariable): void => {
    dispatch({ v: 1, id: genCommandId("variable-add"), kind: "variable.add", variable }, { label: "Added variable" });
  }, [dispatch]);

  const handleCallableInterfaceSet = useCallback((interfaceValue: FlowCallableInterface): void => {
    dispatch({
      v: 1,
      id: genCommandId("callable-interface-set"),
      kind: "callable-interface.set",
      interface: interfaceValue,
    }, { label: "Updated callable interface" });
  }, [dispatch]);

  const handleCallableInterfaceRemove = useCallback((): void => {
    dispatch({
      v: 1,
      id: genCommandId("callable-interface-remove"),
      kind: "callable-interface.remove",
    }, { label: "Removed callable interface" });
  }, [dispatch]);

  const handleSubflowReferenceResolved = useCallback((
    projection: SubflowResolveProjection,
    nodeId: string,
  ): void => {
    if (projection.issues.length > 0) return;
    const current = historyRef.current?.graph;
    const node = current?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || (node.type !== "subflow" && node.type !== "loop")) return;
    const affected = dispatch({
      v: 1,
      id: genCommandId("subflow-reference"),
      kind: "subflow-reference.set",
      nodeId,
      reference: projection.reference,
    }, { label: "Updated reusable flow reference" });
    if (affected === null) return;
    const nextGraph = historyRef.current?.graph;
    if (!nextGraph || !referenceGateRef.current.markResolved(
      sessionParentFlowId,
      nodeId,
      projection.reference,
    )) return;
    const saveBlocker = scheduleSave(nextGraph);
    setCommandAnnouncement(saveBlocker?.message ?? "Reusable flow reference verified.");
  }, [dispatch, scheduleSave, sessionParentFlowId]);


  const handleVariablePatch = useCallback((variableId: string, patch: readonly JsonPatchOp[]): void => {
    dispatch({ v: 1, id: genCommandId("variable-patch"), kind: "variable.patch", variableId, patch }, { label: "Updated variable" });
  }, [dispatch]);

  const handleVariableRemove = useCallback((variableId: string): void => {
    dispatch({ v: 1, id: genCommandId("variable-remove"), kind: "variable.remove", variableId }, { label: "Removed variable" });
  }, [dispatch]);

  const handleBindingSet = useCallback((key: string, binding: ValueBinding): void => {
    const nodeId = selectionRef.current.primaryNodeId;
    if (!nodeId) return;
    dispatch({ v: 1, id: genCommandId("binding-set"), kind: "binding.set", nodeId, key, binding }, { label: "Updated data source" });
  }, [dispatch]);

  const handleBindingRemove = useCallback((key: string): void => {
    const current = historyRef.current?.graph;
    const nodeId = selectionRef.current.primaryNodeId;
    const node = current?.nodes.find((candidate) => candidate.id === nodeId);
    if (!nodeId || !node || !("bindings" in node) || node.bindings[key] === undefined) return;
    dispatch({ v: 1, id: genCommandId("binding-remove"), kind: "binding.remove", nodeId, key }, { label: "Removed data source" });
  }, [dispatch]);

  const handleNameChange = useCallback(
    (name: string) => {
      dispatch({
        v: 1,
        id: genCommandId("rename"),
        kind: "graph.rename",
        name,
      }, { label: "Renamed flow", groupId: nameGroupRef.current ?? undefined });
    },
    [dispatch],
  );

  const handleCanvasSelection = useCallback((
    nextSelection: GraphSelection,
    bounds: Readonly<Record<string, NodeBounds>>,
  ): void => {
    replaceSelection(nextSelection);
    replaceMeasuredBounds(bounds);
  }, [replaceMeasuredBounds, replaceSelection]);

  const handleRetrySave = useCallback(async (): Promise<void> => {
    const impactBlocked = impactActionBlocker();
    if (impactBlocked) {
      setCommandAnnouncement(impactBlocked);
      return;
    }
    const blocker = referenceBlocker("retry-save");
    const retryingReferenceBootstrap = referenceBootstrapTokenRef.current !== null;
    if (blocker && !retryingReferenceBootstrap) {
      setCommandAnnouncement(blocker.message);
      setReferenceSaveBlocked(blocker.message);
      return;
    }
    try {
      if (retryingReferenceBootstrap) {
        setReferenceSaveBlocked("Retrying parent flow creation before reusable flow verification.");
        const token = referenceBootstrapTokenRef.current;
        const currentGraph = historyRef.current?.graph;
        if (token === null || !currentGraph) return;
        updateReferenceBootstrapGraph(token, currentGraph);
        await saveCoordinatorRef.current!.saveNow(createReferenceBootstrapGraph(currentGraph));
      } else {
        await saveCoordinatorRef.current!.retryLatest();
      }
      setCommandAnnouncement(
        retryingReferenceBootstrap
          ? "Parent created. Reusable flow changes still need verification and are not saved."
          : "Saved latest changes.",
      );
    } catch {
      setCommandAnnouncement("Latest changes are still waiting to save.");
    }
  }, [impactActionBlocker, referenceBlocker]);

  const handleConfirmImpact = useCallback(async (): Promise<void> => {
    if (impactPending === null || impactConfirming) return;
    setImpactConfirming(true);
    setSaveError(null);
    try {
      await saveCoordinatorRef.current!.confirmImpact();
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : "Impact confirmation failed.");
    } finally {
      if (sessionMountedRef.current) setImpactConfirming(false);
    }
  }, [impactConfirming, impactPending]);

  const writeSelectionToClipboard = useCallback(async (
    event?: ClipboardEvent,
    trigger?: HTMLElement,
  ): Promise<void> => {
    const current = historyRef.current?.graph;
    if (!current) return;
    try {
      const fragment = serializeGraphFragment(current, selectionRef.current);
      const externalFragment = detachTypedReferencesForExternalClipboard(fragment);
      const text = JSON.stringify(externalFragment);
      if (event?.clipboardData) {
        event.preventDefault();
        event.clipboardData.setData("text/plain", text);
      } else {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard permission unavailable");
        await navigator.clipboard.writeText(text);
      }
      trustedClipboardRef.current = createTrustedClipboardIntent(fragment, text);
      setClipboardFragment(externalFragment);
      setCommandAnnouncement(`Copied ${fragment.nodes.length} nodes. ${externalFragment.redactionCount} protected values removed.`);
    } catch {
      setCommandAnnouncement("Copy unavailable. Select nodes and allow clipboard access.");
      trigger?.focus();
    }
  }, []);

  const commitPendingPasteBatch = useCallback((
    command: Extract<GraphCommand, { kind: "graph.batch" }>,
    resolutions: readonly {
      readonly nodeId: string;
      readonly requestedFingerprint: string;
      readonly projection: SubflowResolveProjection;
    }[],
    parentFlowId: string,
    transition: "paste" | "duplicate",
    label: string,
  ): SupportedFlowGraph => {
    if (command.kind !== "graph.batch") throw new Error("Pending paste must commit one graph batch");
    const current = historyRef.current;
    if (!current) throw new Error("Pending paste target graph is unavailable");
    const next = dispatchGraphCommand(current, command, { label });
    const validator = new StudioReferenceSessionGate();
    validator.reset(parentFlowId, current.graph);
    validator.reconcile(parentFlowId, next.graph, transition);
    for (const resolution of resolutions) {
      if (!validator.markResolved(
        parentFlowId,
        resolution.nodeId,
        resolution.projection.reference,
      )) throw new Error("Pending paste resolution receipt did not match its materialized node");
    }
    referenceGateRef.current.reconcile(sessionParentFlowId, next.graph, transition);
    for (const resolution of resolutions) {
      if (sessionParentFlowId === null) {
        throw new Error("Pending typed paste parent route is unavailable");
      }
      if (!referenceGateRef.current.markResolved(
        sessionParentFlowId,
        resolution.nodeId,
        resolution.projection.reference,
      )) throw new Error("Pending paste resolution receipt could not be recorded");
    }
    historyRef.current = next;
    setHistory(next);
    const nextSelection = selectionAfterCommand(selectionRef.current, next.graph, command);
    replaceSelection(nextSelection);
    setMeasuredBounds((currentBounds) => Object.fromEntries(
      Object.entries(currentBounds).filter(([id]) => nextSelection.nodeIds.includes(id)),
    ));
    return next.graph;
  }, [replaceSelection, sessionParentFlowId]);

  const startPendingPaste = useCallback((intent: PendingPasteIntent): void => {
    cancelPendingPaste();
    const operationEpoch = pendingPasteEpochGuardRef.current!.begin();
    const paste = readPendingPasteIntent(intent);
    const priorDeferredToken = deferredPasteTokenRef.current;
    if (priorDeferredToken !== null) discardDeferredPasteIntent(priorDeferredToken);
    deferredPasteTokenRef.current = null;
    pendingPasteOperationRef.current = true;
    retryPasteIntentRef.current = clonePendingPasteIntent(intent);
    setPasteResolutionError(null);
    const currentGraph = historyRef.current?.graph;
    if (!currentGraph) {
      pendingPasteEpochGuardRef.current!.cancel();
      pendingPasteOperationRef.current = false;
      return;
    }
    const existingReferenceBlocker = referenceBlocker("save");
    if (existingReferenceBlocker) {
      pendingPasteEpochGuardRef.current!.cancel();
      pendingPasteOperationRef.current = false;
      const message = "Verify existing reusable flow references before pasting or duplicating.";
      setPasteResolutionError(message);
      setCommandAnnouncement(message);
      return;
    }
    const typed = fragmentHasTypedReferences(paste.fragment);
    if (typed && sessionParentFlowId === null) {
      const deferredPasteToken = stageDeferredPasteIntent(intent);
      deferredPasteTokenRef.current = deferredPasteToken;
      setPasteResolving(true);
      setCommandAnnouncement("Creating a parent flow before verifying pasted reusable flows.");
      if (persistedId !== null) {
        bindDeferredPasteIntent(deferredPasteToken, persistedId);
      } else if (referenceBootstrapTokenRef.current !== null && !saving) {
        const bootstrapToken = referenceBootstrapTokenRef.current;
        updateReferenceBootstrapGraph(bootstrapToken, currentGraph);
        void saveCoordinatorRef.current!.saveNow(createReferenceBootstrapGraph(currentGraph)).catch(() => {
          if (!sessionMountedRef.current) return;
          pendingPasteEpochGuardRef.current!.cancel();
          pendingPasteOperationRef.current = false;
          setPasteResolving(false);
          const message = "Paste is waiting for its parent flow. Retry paste.";
          setPasteResolutionError(message);
          setCommandAnnouncement(message);
        });
      } else {
        void bootstrapReferenceParent(currentGraph).catch(() => {
          if (!sessionMountedRef.current) return;
          pendingPasteEpochGuardRef.current!.cancel();
          pendingPasteOperationRef.current = false;
          setPasteResolving(false);
          const message = "Paste is waiting for its parent flow. Retry paste.";
          setPasteResolutionError(message);
          setCommandAnnouncement(message);
        });
      }
      return;
    }

    const parentFlowId = sessionParentFlowId ?? UNPERSISTED_PLAIN_PASTE_PARENT;
    const plan = pendingPasteControllerRef.current!.begin({
      parentFlowId,
      fragment: paste.fragment,
      commandId: paste.commandId,
      targetOrigin: paste.targetOrigin,
      targetGraph: currentGraph,
    });
    const requests = plan.requests();
    const commitResolved = (resolutions: readonly {
      readonly nodeId: string;
      readonly requestedFingerprint: string;
      readonly projection: SubflowResolveProjection;
    }[]): void => {
      if (!pendingPasteEpochGuardRef.current!.isCurrent(operationEpoch) ||
          !pendingPasteControllerRef.current!.isActive(plan)) return;
      let committedGraph: SupportedFlowGraph | null = null;
      pendingPasteControllerRef.current!.commit(plan, resolutions, {
        parentFlowId,
        currentTargetGraph: historyRef.current!.graph,
        apply: (command) => {
          committedGraph = commitPendingPasteBatch(
            command,
            resolutions,
            parentFlowId,
            paste.label === "Duplicated selection" ? "duplicate" : "paste",
            paste.label,
          );
        },
      });
      if (!committedGraph) throw new Error("Pending paste did not commit its exact graph");
      if (!pendingPasteEpochGuardRef.current!.complete(operationEpoch)) {
        throw new Error("Pending paste operation changed before commit");
      }
      const saveBlocker = scheduleSave(committedGraph);
      if (saveBlocker) throw new Error(saveBlocker.message);
      if (paste.advancePasteSequence) pasteSequenceRef.current += 1;
      pendingPasteOperationRef.current = false;
      setPasteResolving(false);
      setPasteResolutionError(null);
      retryPasteIntentRef.current = null;
      setCommandAnnouncement(paste.announcement);
    };

    if (requests.length === 0) {
      commitResolved([]);
      return;
    }

    setPasteResolving(true);
    setCommandAnnouncement(`Verifying ${requests.length} reusable flow reference${requests.length === 1 ? "" : "s"} before paste.`);
    void (async () => {
      try {
        const resolutions: Array<{
          readonly nodeId: string;
          readonly requestedFingerprint: string;
          readonly projection: SubflowResolveProjection;
        }> = [];
        for (const request of requests) {
          const projection = await subflowPasteClientRef.current!.resolve({
            parentFlowId,
            nodeId: request.nodeId,
            reference: request.reference,
            signal: operationEpoch.signal,
          });
          if (!pendingPasteEpochGuardRef.current!.isCurrent(operationEpoch) ||
              !pendingPasteControllerRef.current!.isActive(plan)) return;
          if (projection.issues.length > 0) throw new Error("A pasted reusable flow changed and must be reviewed.");
          resolutions.push({
            nodeId: request.nodeId,
            requestedFingerprint: request.fingerprint,
            projection,
          });
        }
        commitResolved(resolutions);
      } catch {
        if (!pendingPasteEpochGuardRef.current!.isCurrent(operationEpoch)) return;
        pendingPasteControllerRef.current!.cancel();
        pendingPasteEpochGuardRef.current!.cancel();
        pendingPasteOperationRef.current = false;
        setPasteResolving(false);
        const message = "Paste could not be verified safely. Review reusable flows and retry paste.";
        setPasteResolutionError(message);
        setCommandAnnouncement(message);
      }
    })();
  }, [
    bootstrapReferenceParent,
    cancelPendingPaste,
    commitPendingPasteBatch,
    persistedId,
    referenceBlocker,
    saving,
    scheduleSave,
    sessionParentFlowId,
  ]);

  const tryStartPendingPaste = useCallback((intent: PendingPasteIntent): void => {
    if (studioTransitionBlocked({
      navigationBusy: studioNavigationCoordinatorRef.current.isBusy(),
      workbookSwitching: workbookSwitchRef.current !== null,
      historyTraversal: pendingHistoryNavigationRef.current,
    })) {
      setCommandAnnouncement(STUDIO_NAVIGATION_PASTE_WAIT_MESSAGE);
      return;
    }
    try {
      startPendingPaste(intent);
    } catch {
      pendingPasteControllerRef.current!.cancel();
      pendingPasteEpochGuardRef.current!.cancel();
      pendingPasteOperationRef.current = false;
      retryPasteIntentRef.current = clonePendingPasteIntent(intent);
      setPasteResolving(false);
      const message = "Paste could not be prepared safely. Review reusable flows and retry paste.";
      setPasteResolutionError(message);
      setCommandAnnouncement(message);
    }
  }, [startPendingPaste]);

  const pasteFragmentText = useCallback((text: string, trusted?: GraphFragmentV1): void => {
    try {
      const fragment = trusted ?? parseGraphFragment(text);
      const current = historyRef.current?.graph;
      if (!current) return;
      if (!trusted) setClipboardFragment(fragment);
      const sequence = pasteSequenceRef.current;
      tryStartPendingPaste(createPendingPasteIntent({
        fragment,
        commandId: genCommandId("paste"),
        targetOrigin: { x: 120 + sequence * 28, y: 120 + sequence * 28 },
        label: "Pasted nodes",
        announcement: `Pasted ${fragment.nodes.length} nodes. ${fragment.redactionCount} credential values removed.`,
        advancePasteSequence: true,
      }));
    } catch {
      setCommandAnnouncement("Paste rejected. Clipboard does not contain a safe graph fragment.");
    }
  }, [tryStartPendingPaste]);

  useEffect(() => {
    if (!routeDeferredPasteIntent) return;
    setRouteDeferredPasteIntent(null);
    if (recoveryEnvelopeRef.current !== null) {
      setCommandAnnouncement("An interrupted paste was not resumed after workflow recovery.");
      return;
    }
    tryStartPendingPaste(routeDeferredPasteIntent);
  }, [routeDeferredPasteIntent, tryStartPendingPaste]);

  const handleRetryPendingPaste = useCallback((): void => {
    const intent = retryPasteIntentRef.current;
    if (intent) tryStartPendingPaste(intent);
  }, [tryStartPendingPaste]);

  const readClipboardAndPaste = useCallback(async (trigger?: HTMLElement): Promise<void> => {
    try {
      if (!navigator.clipboard?.readText) throw new Error("Clipboard permission unavailable");
      const text = await navigator.clipboard.readText();
      pasteFragmentText(text, readTrustedClipboardIntent(trustedClipboardRef.current, text) ?? undefined);
    } catch {
      setCommandAnnouncement("Paste unavailable. Allow clipboard access and try again.");
      trigger?.focus();
    }
  }, [pasteFragmentText]);

  const handleNativeCopy = useCallback((event: ClipboardEvent): void => {
    void writeSelectionToClipboard(event);
  }, [writeSelectionToClipboard]);

  const handleNativePaste = useCallback((event: ClipboardEvent): void => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    pasteFragmentText(text, readTrustedClipboardIntent(trustedClipboardRef.current, text) ?? undefined);
  }, [pasteFragmentText]);

  const executeBuilderCommand = useCallback((
    id: BuilderCommandId,
    trigger?: HTMLElement,
  ): void => {
    const availability = commandState(id, commandContext);
    if (!availability.enabled) {
      setCommandAnnouncement(availability.reason ?? "Command unavailable.");
      trigger?.focus();
      return;
    }
    const current = historyRef.current?.graph;
    if (!current && id !== "palette.open") return;
    if (id === "palette.open") {
      setCommandPaletteOpen(true);
      return;
    }
    if (id === "history.undo") return undo();
    if (id === "history.redo") return redo();
    if (id === "selection.copy") {
      void writeSelectionToClipboard(undefined, trigger);
      return;
    }
    if (id === "selection.paste") {
      if (clipboardReadAvailable) {
        void readClipboardAndPaste(trigger);
      } else if (clipboardFragment) {
        pasteFragmentText(JSON.stringify(clipboardFragment));
      } else {
        void readClipboardAndPaste(trigger);
      }
      return;
    }
    if (!current) return;
    const selectedNodeIds = [...selectionRef.current.nodeIds].sort();
    if (id === "selection.duplicate") {
      const fragment = serializeGraphFragment(current, selectionRef.current);
      const selectedNodes = current.nodes.filter((node) => selectionRef.current.nodeIds.includes(node.id));
      const minX = Math.min(...selectedNodes.map((node) => node.position.x));
      const minY = Math.min(...selectedNodes.map((node) => node.position.y));
      tryStartPendingPaste(createPendingPasteIntent({
        fragment,
        commandId: genCommandId("duplicate"),
        targetOrigin: { x: minX + 40, y: minY + 40 },
        label: "Duplicated selection",
        announcement: `Duplicated ${fragment.nodes.length} nodes.`,
        advancePasteSequence: false,
      }));
      return;
    }
    if (id === "selection.delete") {
      dispatch(
        commandForSelectionDelete(current, selectionRef.current, genCommandId("delete")),
        { label: "Deleted selection" },
      );
      return;
    }
    if (id === "graph.auto-layout") {
      dispatch({ v: 1, id: genCommandId("layout"), kind: "layout.apply", positions: spreadLayout(layoutGraph(current)) }, { label: "Auto-layout" });
      return;
    }
    const geometry = {
      "selection.align-left": ["selection.align", "x", "start"],
      "selection.align-center-x": ["selection.align", "x", "center"],
      "selection.align-right": ["selection.align", "x", "end"],
      "selection.align-top": ["selection.align", "y", "start"],
      "selection.align-center-y": ["selection.align", "y", "center"],
      "selection.align-bottom": ["selection.align", "y", "end"],
      "selection.distribute-x": ["selection.distribute", "x"],
      "selection.distribute-y": ["selection.distribute", "y"],
    } as const;
    const spec = geometry[id as keyof typeof geometry];
    if (!spec) return;
    const bounds = liveSelectionBounds(current, selectedNodeIds, measuredBounds);
    if (spec[0] === "selection.align") {
      dispatch({ v: 1, id: genCommandId("align"), kind: "selection.align", nodeIds: selectedNodeIds, bounds, axis: spec[1], mode: spec[2] }, { label: availability.label });
    } else {
      dispatch({ v: 1, id: genCommandId("distribute"), kind: "selection.distribute", nodeIds: selectedNodeIds, bounds, axis: spec[1] }, { label: availability.label });
    }
  }, [
    clipboardFragment,
    clipboardReadAvailable,
    commandContext,
    dispatch,
    measuredBounds,
    pasteFragmentText,
    readClipboardAndPaste,
    redo,
    tryStartPendingPaste,
    undo,
    writeSelectionToClipboard,
  ]);

  useBuilderShortcuts({
    scopeRef: canvasColumnRef,
    onCommand: executeBuilderCommand,
    onNativeCopy: handleNativeCopy,
    onNativePaste: handleNativePaste,
  });

  const handleSaveVersion = useCallback(async (): Promise<void> => {
    if (!graph || !persistedId || versionHistory.status !== "ready") return;
    const impactBlocked = impactActionBlocker();
    if (impactBlocked) {
      setVersionAnnouncement(impactBlocked);
      return;
    }
    const blocker = referenceBlocker("version");
    if (blocker) {
      setVersionAnnouncement(blocker.message);
      setReferenceSaveBlocked(blocker.message);
      return;
    }
    setVersionSaving(true);
    setVersionAnnouncement(null);
    const versionGraph = structuredClone(graph);
    const versionFingerprint = flowSaveFingerprint(versionGraph);
    try {
      await saveCoordinatorRef.current!.saveNow(versionGraph);
      const currentGraph = historyRef.current?.graph;
      if (!currentGraph || flowSaveFingerprint(currentGraph) !== versionFingerprint) {
        setVersionAnnouncement("The flow changed while saving. Save this version again.");
        return;
      }
      const result = await saveVersionCheckpoint({
        rowId: persistedId,
        graph: versionGraph,
        existingVersionIds: new Set(versionHistory.versions.map((item) => item.id)),
        createCheckpoint: async (rowId, current) => {
          const res = await fetch(`/api/v2/flows/${encodeURIComponent(rowId)}/versions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ graph: current }),
          });
          if (!res.ok) throw new Error(`Version save failed (${res.status})`);
          const parsed = parseVersionRecordEnvelope(await res.json());
          if (!parsed) throw new Error("Malformed saved version.");
          return parsed;
        },
      });
      setVersionHistory((current) => {
        if (current.status !== "ready" || result.kind === "deduped") return current;
        return {
          status: "ready",
          versions: [versionRecordToSummary(result.version), ...current.versions],
        };
      });
      setVersionAnnouncement(saveAnnouncement(result));
    } catch (error: unknown) {
      if (error instanceof ImpactRequiredError) {
        setVersionAnnouncement("Review the reusable-flow impact before saving a version.");
        return;
      }
      const message = error instanceof Error ? error.message : "Version save failed.";
      setVersionHistory({ status: "error", message });
      setVersionAnnouncement(message);
    } finally {
      setVersionSaving(false);
    }
  }, [graph, impactActionBlocker, persistedId, referenceBlocker, versionHistory]);

  const handleRestoreVersion = useCallback(async (
    versionId: string,
    mutation: RequestOwnership,
  ): Promise<void> => {
    const restoreGraph = historyRef.current?.graph;
    const restoreRowId = persistedIdRef.current;
    if (!restoreGraph || !restoreRowId ||
      !ownsRequest(versionMutationSlotRef.current, mutation, restoreRowId)) return;
    const expectedDraftFingerprint = flowSaveFingerprint(restoreGraph);
    const reviewGeneration = versionReviewGenerationRef.current;
    const requestGeneration = versionRestoreGenerationRef.current + 1;
    versionRestoreGenerationRef.current = requestGeneration;
    const impactBlocked = impactActionBlocker();
    if (impactBlocked) {
      setVersionAnnouncement(impactBlocked);
      return;
    }
    const referenceBlocked = referenceBlocker("version");
    if (referenceBlocked) {
      setVersionAnnouncement(referenceBlocked.message);
      setReferenceSaveBlocked(referenceBlocked.message);
      return;
    }
    setVersionAnnouncement(null);
    try {
      const version = await fetchVersionForRestore({
        flowId: restoreRowId,
        versionId,
        signal: mutation.controller.signal,
      });
      if (!ownsRequest(versionMutationSlotRef.current, mutation, persistedIdRef.current) ||
        versionReviewGenerationRef.current !== reviewGeneration ||
        versionRestoreGenerationRef.current !== requestGeneration) return;
      const latestImpactBlocked = impactActionBlocker();
      if (latestImpactBlocked) {
        setVersionAnnouncement(latestImpactBlocked);
        return;
      }
      const latestReferenceBlocked = referenceBlocker("version");
      if (latestReferenceBlocked) {
        setVersionAnnouncement(latestReferenceBlocked.message);
        setReferenceSaveBlocked(latestReferenceBlocked.message);
        return;
      }
      const currentGraph = historyRef.current?.graph;
      if (persistedIdRef.current !== restoreRowId ||
        !ownsRequest(versionMutationSlotRef.current, mutation, persistedIdRef.current) ||
        versionReviewGenerationRef.current !== reviewGeneration ||
        versionRestoreGenerationRef.current !== requestGeneration ||
        !currentGraph ||
        flowSaveFingerprint(currentGraph) !== expectedDraftFingerprint) {
        setVersionAnnouncement("The draft changed before restore. Try again.");
        return;
      }
      const command = buildVersionRestoreCommand({
        currentGraph,
        version,
        expectedDraftFingerprint,
        commandId: genCommandId(`restore:v${version.versionNumber}`),
      });
      if (!ownsRequest(versionMutationSlotRef.current, mutation, persistedIdRef.current) ||
        versionReviewGenerationRef.current !== reviewGeneration ||
        versionRestoreGenerationRef.current !== requestGeneration) return;
      const affected = dispatch(command,
        { label: `Restore v${version.versionNumber}` },
        { kind: "draft-only" },
      );
      setVersionAnnouncement(affected === null
        ? "The saved version could not be restored."
        : `Restored v${version.versionNumber} to the draft. Save when ready. Undo is available.`);
    } catch {
      if (ownsRequest(versionMutationSlotRef.current, mutation, persistedIdRef.current) &&
        versionReviewGenerationRef.current === reviewGeneration &&
        versionRestoreGenerationRef.current === requestGeneration) {
        setVersionAnnouncement("The saved version could not be restored.");
      }
    }
  }, [dispatch, impactActionBlocker, referenceBlocker]);

  const refreshDeploymentReceipts = useCallback(async (
    rowId: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const test = projectContext?.environments.find((item) => item.kind === "test");
    const live = projectContext?.environments.find((item) => item.kind === "live");
    if (!test || !live || persistedIdRef.current !== rowId) return false;
    const operation = claimLatestRequest(deploymentRefreshSlotRef.current, rowId);
    const abortFromParent = () => operation.controller.abort();
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener("abort", abortFromParent, { once: true });
    try {
      const response = await fetch(`/api/v2/flows/${encodeURIComponent(rowId)}/deployments`, {
        signal: operation.controller.signal,
      });
      if (!response.ok) throw new Error("unavailable");
      const deployments = parseDeploymentsEnvelope(await response.json(), {
        flowId: rowId,
        testEnvironmentId: test.id,
        liveEnvironmentId: live.id,
      });
      if (!deployments || !ownsRequest(deploymentRefreshSlotRef.current, operation, persistedIdRef.current)) {
        throw new Error("unavailable");
      }
      setDeploymentHistory({ status: "ready", deployments });
      releaseRequest(deploymentRefreshSlotRef.current, operation);
      return true;
    } catch {
      if (ownsRequest(deploymentRefreshSlotRef.current, operation, persistedIdRef.current)) {
        setDeploymentHistory({ status: "error" });
        releaseRequest(deploymentRefreshSlotRef.current, operation);
      }
      return false;
    } finally {
      signal?.removeEventListener("abort", abortFromParent);
    }
  }, [projectContext]);

  const handleOpenVersionReview = useCallback((versionId: string, trigger: HTMLButtonElement): void => {
    versionReviewTriggerRef.current = trigger;
    versionRestoreGenerationRef.current += 1;
    cancelRequest(versionMutationSlotRef.current);
    cancelRequest(deploymentRefreshSlotRef.current);
    setVersionReviewBusy(null);
    setLivePromotionPhrase("");
    setSelectedVersionId(versionId);
  }, []);

  const handleDismissVersionReview = useCallback((): void => {
    versionReviewGenerationRef.current += 1;
    versionRestoreGenerationRef.current += 1;
    versionReviewAbortRef.current?.abort();
    cancelRequest(versionMutationSlotRef.current);
    cancelRequest(deploymentRefreshSlotRef.current);
    setSelectedVersionId(null);
    setSelectedVersion(null);
    setVersionReviewBusy(null);
    setLivePromotionPhrase("");
  }, []);

  const handleReviewRestore = useCallback(async (): Promise<void> => {
    const intent = selectedVersion;
    const rowId = persistedIdRef.current;
    if (!intent || !rowId) return;
    const operation = claimExclusiveRequest(versionMutationSlotRef.current, rowId);
    if (!operation) return;
    setVersionReviewBusy("restore");
    try {
      await handleRestoreVersion(selectedVersion.id, operation);
    } finally {
      if (releaseRequest(versionMutationSlotRef.current, operation)) setVersionReviewBusy(null);
    }
  }, [handleRestoreVersion, selectedVersion]);

  const handlePromoteVersionToTest = useCallback(async (): Promise<void> => {
    const intent = selectedVersion;
    const rowId = persistedIdRef.current;
    if (!intent || !rowId || !testEnvironment || deploymentHistory.status !== "ready" ||
      impactActionBlocker() || referenceBlocker("version")) return;
    const operation = claimExclusiveRequest(versionMutationSlotRef.current, rowId);
    if (!operation) return;
    const { controller } = operation;
    const generation = versionReviewGenerationRef.current;
    setVersionReviewBusy("test");
    setVersionAnnouncement(null);
    try {
      const response = await fetch(`/api/v2/flows/${encodeURIComponent(rowId)}/deployments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          versionId: intent.id,
          versionSemanticHash: intent.semanticHash,
          versionFullHash: intent.fullHash,
          environmentId: testEnvironment.id,
          environmentKind: "test",
          expectedActiveDeploymentId: activeTestDeployment?.id ?? null,
          sourceTestDeploymentId: null,
          confirmation: "PROMOTE TEST",
        }),
      });
      const deployment = response.ok ? parseDeploymentEnvelope(await response.json()) : null;
      if (!deployment || deployment.flowId !== rowId || deployment.flowVersionId !== intent.id ||
        deployment.environmentId !== testEnvironment.id || deployment.status !== "test") {
        throw new Error("promotion unavailable");
      }
      if (controller.signal.aborted || versionReviewGenerationRef.current !== generation ||
        selectedVersionId !== intent.id || !ownsRequest(versionMutationSlotRef.current, operation, persistedIdRef.current)) return;
      const refreshed = await refreshDeploymentReceipts(rowId, controller.signal);
      if (controller.signal.aborted || versionReviewGenerationRef.current !== generation) return;
      setVersionAnnouncement(refreshed
        ? `Promoted v${intent.versionNumber} to Test.`
        : "Test promotion completed, but environment status could not refresh.");
    } catch {
      if (!controller.signal.aborted && ownsRequest(versionMutationSlotRef.current, operation, persistedIdRef.current)) {
        await refreshDeploymentReceipts(rowId, controller.signal);
        if (ownsRequest(versionMutationSlotRef.current, operation, persistedIdRef.current)) {
          setVersionAnnouncement("This version could not be promoted to Test. Refresh environment status and try again.");
        }
      }
    } finally {
      if (releaseRequest(versionMutationSlotRef.current, operation)) setVersionReviewBusy(null);
    }
  }, [activeTestDeployment?.id, deploymentHistory.status, impactActionBlocker, referenceBlocker, refreshDeploymentReceipts, selectedVersion, selectedVersionId, testEnvironment]);

  const handlePromoteVersionToLive = useCallback(async (): Promise<void> => {
    const intent = selectedVersion;
    const rowId = persistedIdRef.current;
    const sourceTestDeployment = activeTestDeployment;
    if (!intent || !rowId || !liveEnvironment || !testEnvironment || !sourceTestDeployment || deploymentHistory.status !== "ready" ||
      impactActionBlocker() || referenceBlocker("version") ||
      sourceTestDeployment.flowId !== rowId || sourceTestDeployment.environmentId !== testEnvironment.id ||
      sourceTestDeployment.status !== "test" || sourceTestDeployment.retiredAt !== undefined ||
      sourceTestDeployment.flowVersionId !== intent.id || livePromotionPhrase !== "PROMOTE LIVE") return;
    const liveRequest = buildLivePromotionRequest({
      flowId: rowId,
      version: intent,
      liveEnvironment,
      activeLive: activeLiveDeployment,
      activeTest: sourceTestDeployment,
    });
    if (!liveRequest) return;
    const operation = claimExclusiveRequest(versionMutationSlotRef.current, rowId);
    if (!operation) return;
    const { controller } = operation;
    const generation = versionReviewGenerationRef.current;
    setVersionReviewBusy("live");
    setVersionAnnouncement(null);
    try {
      const response = await fetch(`/api/v2/flows/${encodeURIComponent(rowId)}/deployments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          ...liveRequest,
          sourceTestDeploymentId: activeTestDeployment.id,
          confirmation: "PROMOTE LIVE",
        }),
      });
      const deployment = response.ok ? parseDeploymentEnvelope(await response.json()) : null;
      if (!deployment || deployment.flowId !== rowId || deployment.flowVersionId !== intent.id ||
        deployment.environmentId !== liveEnvironment.id || deployment.status !== "live") {
        throw new Error("promotion unavailable");
      }
      if (controller.signal.aborted || versionReviewGenerationRef.current !== generation ||
        selectedVersionId !== intent.id || !ownsRequest(versionMutationSlotRef.current, operation, persistedIdRef.current)) return;
      const refreshed = await refreshDeploymentReceipts(rowId, controller.signal);
      if (controller.signal.aborted || versionReviewGenerationRef.current !== generation) return;
      setLivePromotionPhrase("");
      setVersionAnnouncement(refreshed
        ? `Promoted v${intent.versionNumber} to Live.`
        : "Live promotion completed, but environment status could not refresh.");
    } catch {
      if (!controller.signal.aborted && ownsRequest(versionMutationSlotRef.current, operation, persistedIdRef.current)) {
        await refreshDeploymentReceipts(rowId, controller.signal);
        if (ownsRequest(versionMutationSlotRef.current, operation, persistedIdRef.current)) {
          setVersionAnnouncement("This version could not be promoted to Live. Refresh environment status and try again.");
        }
      }
    } finally {
      if (releaseRequest(versionMutationSlotRef.current, operation)) setVersionReviewBusy(null);
    }
    // Depends on the whole `activeLiveDeployment`, not just its id: the body
    // passes the record itself to the impact check, so keying on the id alone
    // could hand it a stale record whenever a deployment's fields change
    // without its id changing. No extra churn — the record comes straight out
    // of `deploymentHistory`, which is already a dependency here.
  }, [activeLiveDeployment, activeTestDeployment, deploymentHistory.status, impactActionBlocker, liveEnvironment, livePromotionPhrase, referenceBlocker, refreshDeploymentReceipts, selectedVersion, selectedVersionId, testEnvironment]);

  const handleLaunch = useCallback(async (): Promise<void> => {
    setLaunchError(null);
    const impactBlocked = impactActionBlocker();
    if (impactBlocked) {
      setLaunchError(impactBlocked);
      return;
    }
    const blocker = referenceBlocker("launch");
    if (blocker) {
      setLaunchError(blocker.message);
      setReferenceSaveBlocked(blocker.message);
      return;
    }
    const id = persistedId;
    if (!id || !graph) {
      setLaunchError("Save the flow before launching.");
      return;
    }
    const trimmedPrice = priceUsdc.trim();
    // A blank price is not a price: force an explicit choice (0 is a valid
    // one) instead of quietly launching a free endpoint.
    if (trimmedPrice === "") {
      setLaunchError("Set a price per call before launching. Enter 0 to serve calls free.");
      return;
    }
    const parsedPrice = Number.parseFloat(trimmedPrice);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      setLaunchError("Price must be a number of 0 or more, e.g. 0.05. Use 0 for free calls.");
      return;
    }
    try {
      await saveCoordinatorRef.current!.saveNow(graph);
      const body: Record<string, unknown> = { priceUsdc: parsedPrice };
      const trimmedPayout = payoutAddress.trim();
      if (trimmedPayout !== "") {
        body.payoutAddress = trimmedPayout;
      }
      const res = await fetch(`/api/flows/${id}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const serverError =
          typeof data === "object" && data !== null
            ? (data as { error?: unknown }).error
            : undefined;
        const friendly =
          serverError === "API_OPERATION_LIVE_UNAVAILABLE"
            ? "This flow uses an imported API operation that can't run live yet. Remove that node or keep the flow in dry-run mode."
            : typeof serverError === "string"
              ? serverError
              : `Launch failed (${res.status})`;
        throw new Error(friendly);
      }
      if (typeof data === "object" && data !== null) {
        const d = data as Record<string, unknown>;
        const slug =
          typeof d.slug === "string"
            ? d.slug
            : typeof (d.agent as { slug?: string } | undefined)?.slug ===
                "string"
              ? (d.agent as { slug: string }).slug
              : "";
        const endpoints = Array.isArray(d.endpoints)
          ? d.endpoints.filter((e): e is string => typeof e === "string")
          : undefined;
        const agentId =
          typeof (d.agent as { id?: string } | undefined)?.id === "string"
            ? (d.agent as { id: string }).id
            : undefined;
        if (slug) {
          // Lane contract: settlementLive/payoutWarning/floorUsdc/suggestedUsdc
          // may arrive on the launch response. All optional at runtime.
          let settlementLive: boolean | undefined =
            typeof d.settlementLive === "boolean" ? d.settlementLive : undefined;
          const payoutWarning =
            typeof d.payoutWarning === "string" && d.payoutWarning !== ""
              ? d.payoutWarning
              : undefined;
          const floorUsdc = typeof d.floorUsdc === "number" ? d.floorUsdc : undefined;
          const suggestedUsdc =
            typeof d.suggestedUsdc === "number" ? d.suggestedUsdc : undefined;
          if (collectOnLaunch && settlementLive !== true) {
            // Opt-in requested: flip settlement AFTER the successful launch.
            // A failure here never fails the launch; the panel keeps the
            // one-click turn-on action.
            try {
              const settleRes = await fetch(
                `/api/agents/${encodeURIComponent(slug)}/settlement`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ live: true }),
                },
              );
              const settleBody: unknown = await settleRes.json().catch(() => null);
              if (
                settleRes.ok &&
                typeof settleBody === "object" &&
                settleBody !== null &&
                (settleBody as { settlementLive?: unknown }).settlementLive === true
              ) {
                settlementLive = true;
              } else {
                settlementLive = settlementLive ?? false;
              }
            } catch {
              settlementLive = settlementLive ?? false;
            }
          }
          setLaunch({
            slug,
            endpoints,
            agentId,
            schedule: (d.schedule as LaunchInfo["schedule"]) ?? null,
            payout: (d.payout as LaunchInfo["payout"]) ?? null,
            webhook: (d.webhook as LaunchInfo["webhook"]) ?? null,
            ...(settlementLive !== undefined ? { settlementLive } : {}),
            ...(payoutWarning !== undefined ? { payoutWarning } : {}),
            ...(floorUsdc !== undefined ? { floorUsdc } : {}),
            ...(suggestedUsdc !== undefined ? { suggestedUsdc } : {}),
          });
          setCommandAnnouncement(
            settlementLive === true
              ? `Agent is live at /a/${slug} and collecting payment.`
              : `Agent is live at /a/${slug}.`,
          );
          trackEvent("agent_published", { slug, priceUsdc: parsedPrice });
          return;
        }
      }
      throw new Error("Launch response missing slug.");
    } catch (err: unknown) {
      if (err instanceof ImpactRequiredError) {
        setLaunchError(null);
        return;
      }
      setLaunchError(err instanceof Error ? err.message : "Launch failed.");
    }
  }, [persistedId, graph, impactActionBlocker, priceUsdc, payoutAddress, collectOnLaunch, referenceBlocker]);

  const handleWorkbookTabActivate = useCallback(async (
    target: WorkbookFlowTab,
  ): Promise<void> => {
    const currentGraph = historyRef.current?.graph;
    if (!currentGraph || target.flowId === flowId) return;
    if (studioTransitionBlocked({
      navigationBusy: studioNavigationCoordinatorRef.current.isBusy(),
      workbookSwitching: workbookSwitchRef.current !== null,
      historyTraversal: pendingHistoryNavigationRef.current,
    })) {
      setWorkbookTabError("A navigation save is already in progress.");
      return;
    }
    const impactBlocked = impactActionBlocker();
    if (impactBlocked) {
      setWorkbookTabError(impactBlocked);
      return;
    }
    const pasteBlocked = pasteNavigationBlocker();
    if (pasteBlocked) {
      setWorkbookTabError(pasteBlocked);
      return;
    }
    const blocker = referenceBlocker("workbook-navigation");
    if (blocker) {
      setWorkbookTabError(blocker.message);
      setReferenceSaveBlocked(blocker.message);
      return;
    }
    workbookSwitchRef.current = target.flowId;
    setBusyFlowId(target.flowId);
    setWorkbookTabError(null);
    try {
      const result = await studioNavigationCoordinatorRef.current.run({
        path: `/build/${encodeURIComponent(target.flowId)}`,
        graph: currentGraph,
        getCurrentGraph: () => historyRef.current?.graph ?? null,
        saveNow: (snapshot) => saveCoordinatorRef.current!.saveNow(snapshot),
        beforeNavigate: pasteNavigationBlocker,
        navigate: (path) => {
          pendingTabFocusRef.current = target.flowId;
          storeWorkbookTabFocus(target.flowId);
          if (!beginRouteEffectRef.current(() => router.push(path))) {
            throw new Error("History navigation blocked");
          }
        },
      });
      if (result.status === "changed") {
        setWorkbookTabError(STUDIO_NAVIGATION_CHANGED_MESSAGE);
        throw new Error("Workbook tab switch refused.");
      }
      if (result.status === "blocked") {
        setWorkbookTabError(result.message);
        throw new Error("Workbook tab switch refused.");
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "Workbook tab switch refused.") throw error;
      if (pendingTabFocusRef.current === target.flowId) {
        pendingTabFocusRef.current = null;
        clearStoredWorkbookTabFocus();
      }
      if (error instanceof ImpactRequiredError) {
        setWorkbookTabError(null);
        return;
      }
      setWorkbookTabError("Could not switch tabs because the current draft did not save.");
      throw new Error("Workbook tab switch refused.");
    } finally {
      workbookSwitchRef.current = null;
      if (sessionMountedRef.current) setBusyFlowId(null);
    }
  }, [flowId, impactActionBlocker, pasteNavigationBlocker, pendingTabFocusRef, referenceBlocker, router]);

  const restoreCreatedFlowRoute = useCallback((createdRowId: string): void => {
    const currentGraph = historyRef.current?.graph;
    if (!currentGraph) {
      setCommandAnnouncement("The saved flow is ready, but this draft could not be verified. Stay on this page.");
      return;
    }
    const impactBlocked = impactActionBlocker();
    if (impactBlocked) {
      setImpactDialogOpen(true);
      setCommandAnnouncement(impactBlocked);
      return;
    }
    const pasteBlocked = pasteNavigationBlocker();
    if (pasteBlocked) {
      setCommandAnnouncement(pasteBlocked);
      return;
    }
    const blocker = referenceBlocker("global-navigation");
    if (blocker) {
      setReferenceSaveBlocked(blocker.message);
      setCommandAnnouncement(blocker.message);
      return;
    }
    const authoritativePath = `/build/${encodeURIComponent(createdRowId)}`;
    setCommandAnnouncement("Saving the latest changes before opening the saved flow.");
    void studioNavigationCoordinatorRef.current.run({
      path: authoritativePath,
      graph: currentGraph,
      getCurrentGraph: () => historyRef.current?.graph ?? null,
      saveNow: (snapshot) => saveCoordinatorRef.current!.saveNow(snapshot),
      beforeNavigate: pasteNavigationBlocker,
      navigate: () => {
        if (!beginRouteEffectRef.current(() => router.replace(authoritativePath))) {
          throw new Error("History navigation blocked");
        }
      },
    }).then((result) => {
      if (result.status === "changed") {
        setCommandAnnouncement(STUDIO_NAVIGATION_CHANGED_MESSAGE);
      }
      if (result.status === "blocked") setCommandAnnouncement(result.message);
    }).catch((error: unknown) => {
      if (error instanceof ImpactRequiredError) {
        setImpactDialogOpen(true);
        setCommandAnnouncement("Review the reusable-flow impact before opening the saved flow.");
      } else {
        setCommandAnnouncement("The latest draft did not save. Stay on this page and try again.");
      }
    });
  }, [impactActionBlocker, pasteNavigationBlocker, referenceBlocker, router]);

  const handleStudioNavigation = useCallback((path: string): void => {
    if (studioTransitionBlocked({
      navigationBusy: studioNavigationCoordinatorRef.current.isBusy(),
      workbookSwitching: workbookSwitchRef.current !== null,
      historyTraversal: pendingHistoryNavigationRef.current,
    })) {
      setCommandAnnouncement("A navigation save is already in progress.");
      return;
    }
    const currentGraph = historyRef.current?.graph;
    if (!currentGraph) return;
    const impactBlocked = impactActionBlocker();
    if (impactBlocked) {
      setImpactDialogOpen(true);
      setCommandAnnouncement(impactBlocked);
      return;
    }
    const pasteBlocked = pasteNavigationBlocker();
    if (pasteBlocked) {
      setCommandAnnouncement(pasteBlocked);
      return;
    }
    const blocker = referenceBlocker("global-navigation");
    if (blocker) {
      setReferenceSaveBlocked(blocker.message);
      setCommandAnnouncement(blocker.message);
      return;
    }

    const pending: PendingStudioNavigation = { path, createdRowId: null };
    pendingStudioNavigationRef.current = pending;
    setCommandAnnouncement("Saving the current draft before leaving.");
    void studioNavigationCoordinatorRef.current.run({
      path,
      graph: currentGraph,
      getCurrentGraph: () => historyRef.current?.graph ?? null,
      saveNow: (snapshot) => saveCoordinatorRef.current!.saveNow(snapshot),
      beforeNavigate: pasteNavigationBlocker,
      navigate: () => {
        if (pendingStudioNavigationRef.current === pending) {
          pendingStudioNavigationRef.current = null;
        }
        if (!beginRouteEffectRef.current(() => router.push(pending.path))) {
          throw new Error("History navigation blocked");
        }
      },
    }).then((result) => {
      if (result.status === "navigated") return;
      setCommandAnnouncement(result.message);
      const createdRowId = pending.createdRowId;
      if (pendingStudioNavigationRef.current === pending) {
        pendingStudioNavigationRef.current = null;
      }
      if (createdRowId !== null && result.status === "changed") {
        restoreCreatedFlowRoute(createdRowId);
      }
    }).catch((error: unknown) => {
      if (error instanceof ImpactRequiredError) {
        setImpactDialogOpen(true);
        setCommandAnnouncement("Review the reusable-flow impact before leaving.");
      } else {
        setCommandAnnouncement("Could not leave because the current draft did not save.");
      }
      const createdRowId = pending.createdRowId;
      if (pendingStudioNavigationRef.current === pending) {
        pendingStudioNavigationRef.current = null;
      }
      if (createdRowId !== null) {
        restoreCreatedFlowRoute(createdRowId);
      }
    });
  }, [impactActionBlocker, pasteNavigationBlocker, referenceBlocker, restoreCreatedFlowRoute, router]);

  const navigateSubflowTrail = useCallback((input: {
    readonly targetFlowId: string;
    readonly trail: readonly SubflowBreadcrumbEntry[];
    readonly focus: { readonly targetFlowId: string; readonly originNodeId: string } | null;
    readonly activation: { readonly button: number; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean; preventDefault(): void };
    readonly expectedReference?: { readonly nodeId: string; readonly fingerprint: string };
  }): void => {
    input.activation.preventDefault();
    if (!isUnmodifiedPrimaryStudioNavigation(input.activation)) {
      setCommandAnnouncement(STUDIO_ALTERNATE_NAVIGATION_MESSAGE);
      return;
    }
    if (studioTransitionBlocked({
      navigationBusy: studioNavigationCoordinatorRef.current.isBusy(),
      workbookSwitching: workbookSwitchRef.current !== null,
      historyTraversal: pendingHistoryNavigationRef.current,
    })) {
      setCommandAnnouncement("A navigation save is already in progress.");
      return;
    }
    const currentGraph = historyRef.current?.graph;
    const storage = recoveryStorageRef.current;
    const nonce = subflowBreadcrumbNonceRef.current;
    if (!currentGraph || !storage || !nonce) {
      setCommandAnnouncement("Workflow navigation is unavailable. Stay on this page.");
      return;
    }
    const impactBlocked = impactActionBlocker();
    if (impactBlocked) {
      setImpactDialogOpen(true);
      setCommandAnnouncement(impactBlocked);
      return;
    }
    const pasteBlocked = pasteNavigationBlocker();
    if (pasteBlocked) {
      setCommandAnnouncement(pasteBlocked);
      return;
    }
    const blocker = referenceBlocker("global-navigation");
    if (blocker) {
      setReferenceSaveBlocked(blocker.message);
      setCommandAnnouncement(blocker.message);
      return;
    }
    const expectedGraphFingerprint = flowSaveFingerprint(currentGraph);
    const path = `/build/${encodeURIComponent(input.targetFlowId)}`;
    setCommandAnnouncement("Saving the current draft before opening the reusable flow.");
    void studioNavigationCoordinatorRef.current.run({
      path,
      graph: currentGraph,
      getCurrentGraph: () => historyRef.current?.graph ?? null,
      saveNow: (snapshot) => saveCoordinatorRef.current!.saveNow(snapshot),
      beforeNavigate: () => impactActionBlocker() ?? pasteNavigationBlocker() ?? referenceBlocker("global-navigation")?.message ?? null,
      navigate: () => {
        const latestReferenceGraph = historyRef.current?.graph;
        if (!latestReferenceGraph || flowSaveFingerprint(latestReferenceGraph) !== expectedGraphFingerprint) {
          throw new Error("Subflow navigation graph changed");
        }
        if (input.expectedReference) {
          const latestNode = latestReferenceGraph.nodes.find(({ id }) => id === input.expectedReference?.nodeId);
          let latestFingerprint: string | null = null;
          if (latestNode && (latestNode.type === "subflow" || latestNode.type === "loop")) {
            try {
              const normalized = normalizeSubflowReference(latestNode.params);
              if (normalized.kind === "typed") latestFingerprint = JSON.stringify(normalized.reference);
            } catch { latestFingerprint = null; }
          }
          if (latestFingerprint !== input.expectedReference.fingerprint ||
              referenceBlocker("save")?.nodeIds.includes(input.expectedReference.nodeId)) {
            throw new Error("Subflow reference changed");
          }
        }
        if (!beginRouteEffectRef.current(() => {
          try {
            const result = stageSubflowBreadcrumbRouteEffect(storage, {
              nonce,
              targetFlowId: input.targetFlowId,
              trail: input.trail,
              focus: input.focus,
              now: Date.now(),
            }, () => {
              subflowTrailValidatedRef.current = false;
              router.push(path);
            });
            if (result.status !== "routed") {
              studioHistoryGuardRef.current?.mount();
              setCommandAnnouncement("Workflow navigation is unavailable. Stay on this page.");
            }
          } catch {
            studioHistoryGuardRef.current?.mount();
            setCommandAnnouncement("Workflow navigation is unavailable. Stay on this page.");
          }
        })) throw new Error("History navigation blocked");
      },
    }).then((result) => {
      if (result.status !== "navigated") setCommandAnnouncement(result.message);
    }).catch((error: unknown) => {
      if (error instanceof ImpactRequiredError) {
        setImpactDialogOpen(true);
        setCommandAnnouncement("Review the reusable-flow impact before continuing.");
      } else if (error instanceof Error && error.message === "Subflow navigation graph changed") {
        setCommandAnnouncement(STUDIO_NAVIGATION_CHANGED_MESSAGE);
      } else if (error instanceof Error && error.message === "Subflow reference changed") {
        setCommandAnnouncement("The reusable flow reference changed. Verify it again before opening.");
      } else {
        setCommandAnnouncement("Could not open the reusable flow because the current draft did not save.");
      }
    });
  }, [impactActionBlocker, pasteNavigationBlocker, referenceBlocker, router]);

  const handleOpenResolvedSubflow = useCallback((
    nodeId: string,
    reference: SubflowReference,
    activation: { readonly button: number; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean; preventDefault(): void },
  ): void => {
    if (!subflowTrailValidatedRef.current) {
      activation.preventDefault();
      setCommandAnnouncement("Wait for the workflow trail to finish checking before opening this reusable flow.");
      return;
    }
    const currentFlowId = persistedIdRef.current;
    if (!currentFlowId) {
      activation.preventDefault();
      setCommandAnnouncement("Save this workflow before opening its reusable flow.");
      return;
    }
    const currentTrail = claimedSubflowTrailRef.current.length > 0
      ? claimedSubflowTrailRef.current
      : [{ flowId: currentFlowId, via: null }] satisfies readonly SubflowBreadcrumbEntry[];
    const nextTrail = appendSubflowBreadcrumb(currentTrail, {
      flowId: reference.flowId,
      via: {
        parentFlowId: currentFlowId,
        originNodeId: nodeId,
        reference: reference.kind === "pinned"
          ? {
              kind: "pinned",
              flowId: reference.flowId,
              versionId: reference.versionId,
              interfaceHash: reference.interfaceHash,
              contentHash: reference.contentHash,
            }
          : {
              kind: "draft",
              flowId: reference.flowId,
              interfaceHash: reference.interfaceHash,
            },
      },
    });
    if (!nextTrail) {
      activation.preventDefault();
      setCommandAnnouncement("This reusable flow trail cannot be opened safely.");
      return;
    }
    navigateSubflowTrail({
      targetFlowId: reference.flowId,
      trail: nextTrail,
      focus: null,
      activation,
      expectedReference: { nodeId, fingerprint: JSON.stringify(reference) },
    });
  }, [navigateSubflowTrail]);

  const handleSubflowBreadcrumbNavigate = useCallback((
    item: SubflowBreadcrumbDisplayItem,
    activation: { readonly button: number; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean; preventDefault(): void },
  ): void => {
    const destination = deriveSubflowAncestorReturn(claimedSubflowTrailRef.current, item.flowId);
    if (!destination) {
      activation.preventDefault();
      setCommandAnnouncement("This parent workflow trail is no longer available.");
      return;
    }
    navigateSubflowTrail({ ...destination, activation });
  }, [navigateSubflowTrail]);

  const interceptStudioNavigation = useCallback((
    event: React.MouseEvent<HTMLAnchorElement>,
    path: string,
  ): void => {
    event.preventDefault();
    if (!isUnmodifiedPrimaryStudioNavigation(event)) {
      setCommandAnnouncement(STUDIO_ALTERNATE_NAVIGATION_MESSAGE);
      return;
    }
    handleStudioNavigation(path);
  }, [handleStudioNavigation]);

  const selectedNode = useMemo<FlowNode | FlowNodeV2 | null>(() => {
    if (!graph || !selection.primaryNodeId) return null;
    return graph.nodes.find((n) => n.id === selection.primaryNodeId) ?? null;
  }, [graph, selection.primaryNodeId]);

  const resolveAuthoringPorts = useMemo<ValidatedNodePortResolver | null>(
    () => graph ? createStudioOperationPortResolver(
      graph,
      operationClosureContextMatches && operationClosures.status === "ready" && operationClosures.graph === graph
        ? operationClosures.byNodeId
        : undefined,
    ) : null,
    [graph, operationClosureContextMatches, operationClosures],
  );

  const selectedOperationClosure = selectedNode?.type === "api.operation" &&
    operationClosureContextMatches && operationClosures.status === "ready" && operationClosures.graph === graph
    ? operationClosures.byNodeId.get(selectedNode.id) ?? null
    : null;
  const selectedOperationConnection = selectedOperationClosure
    ? boundCompatibleApiOperationConnection(
        selectedOperationClosure.authentication,
        selectedOperationClosure.reference.readinessBinding,
        visibleConnectionMetadataState.choices,
      )
    : null;
  const apiOperationContextKey = useMemo(() => JSON.stringify([
    graphContextId(graph),
    graph ? flowSaveFingerprint(graph) : null,
    ownerScopeHash,
    persistedId,
    selectedNode?.id ?? null,
    testEnvironment?.id ?? null,
    testScope?.kind ?? null,
    testScope?.nodeId ?? null,
    operationClosureContextMatches ? operationClosures.status : "context-loading",
    selectedOperationClosure?.lifecycleRevision ?? null,
  ]), [graph, operationClosureContextMatches, operationClosures.status, ownerScopeHash, persistedId,
    selectedNode?.id, selectedOperationClosure?.lifecycleRevision,
    testEnvironment?.id, testScope?.kind, testScope?.nodeId]);
  const apiOperationReadinessContextKey = useMemo(() => JSON.stringify([
    apiOperationContextKey,
    visibleConnectionMetadataState.status,
    selectedOperationConnection?.lifecycleRevision ?? null,
    selectedOperationConnection?.slots.test ?? null,
  ]), [apiOperationContextKey, selectedOperationConnection?.lifecycleRevision,
    selectedOperationConnection?.slots.test, visibleConnectionMetadataState.status]);
  const apiOperationContextKeyRef = useRef(apiOperationContextKey);
  apiOperationContextKeyRef.current = apiOperationContextKey;
  const apiOperationReadinessContextKeyRef = useRef(apiOperationReadinessContextKey);
  apiOperationReadinessContextKeyRef.current = apiOperationReadinessContextKey;
  const visibleSimulationState = projectContextualStudioValue(
    apiOperationContextKey, simulationState, { status: "idle" as const });
  const visibleReadinessState = projectContextualStudioValue(
    apiOperationReadinessContextKey, readinessState, { status: "idle" as const });
  const visiblePinValues = projectContextualStudioValue(
    apiOperationContextKey,
    { contextKey: apiOperationPinValues.contextKey, value: apiOperationPinValues.values },
    EMPTY_STRING_RECORD,
  );
  useEffect(() => {
    simulationGenerationRef.current += 1;
    simulationAbortRef.current?.abort();
    simulationAbortRef.current = null;
    setSimulationState({ contextKey: apiOperationContextKey, value: { status: "idle" } });
    setApiOperationPinValues({ contextKey: apiOperationContextKey, values: {} });
    return () => {
      simulationAbortRef.current?.abort();
    };
  }, [apiOperationContextKey]);
  useEffect(() => {
    readinessGenerationRef.current += 1;
    readinessAbortRef.current?.abort();
    readinessAbortRef.current = null;
    setReadinessState({ contextKey: apiOperationReadinessContextKey, value: { status: "idle" } });
    return () => {
      readinessAbortRef.current?.abort();
    };
  }, [apiOperationReadinessContextKey]);
  const apiOperationSimulationPlan = useMemo(() =>
    graph && "schemaVersion" in graph && graph.schemaVersion === 2 && selectedNode?.type === "api.operation"
      ? createTestRunUiPlan(graph, { kind: "from-node", nodeId: selectedNode.id }, resolveAuthoringPorts ?? undefined)
      : null,
  [graph, resolveAuthoringPorts, selectedNode]);
  const effectiveApiOperationPinValues = useMemo<Readonly<Record<string, string>>>(() =>
    apiOperationSimulationPlan?.status === "ready"
      ? Object.freeze(Object.fromEntries(apiOperationSimulationPlan.pins.map((pin) => [
          pin.key,
          visiblePinValues[pin.key] ?? (pin.control === "boolean" ? "false" : "null"),
        ])))
      : Object.freeze({}),
  [apiOperationSimulationPlan, visiblePinValues]);
  const apiOperationAuthorityReason = selectedNode?.type !== "api.operation"
    ? null
    : !CONNECTOR_LAB_ENABLED
      ? "Connector Lab is unavailable."
      : !operationClosureContextMatches || operationClosures.graph !== graph || operationClosures.status === "loading"
        ? "Loading exact API operation details."
        : operationClosures.status === "repair" || !selectedOperationClosure
          ? API_OPERATION_REPAIR_MESSAGE
          : null;
  const apiOperationSimulationReason = apiOperationAuthorityReason ?? (!persistedId
    ? "Save this workflow before simulating."
    : !testEnvironment
      ? "Create a Test environment before simulating."
      : apiOperationSimulationPlan?.status !== "ready"
        ? "This workflow cannot be simulated safely until its boundary inputs are repaired."
        : null);
  const apiOperationReadinessReason = apiOperationAuthorityReason ?? (
    selectedOperationClosure?.authentication.kind === "none"
      ? null
      : visibleConnectionMetadataState.status === "loading"
        ? "Loading Test connection metadata."
        : visibleConnectionMetadataState.status === "error"
          ? "Test connection metadata could not be loaded."
          : visibleConnectionMetadataState.status === "unavailable"
            ? "Test connection metadata is unavailable."
            : selectedOperationConnection === null
              ? "Choose a compatible Test connection before checking readiness."
              : null
  );

  const handleApiOperationBindingChange = useCallback((binding: ApiOperationReference["readinessBinding"]): void => {
    if (!isCurrentStudioContext(apiOperationReadinessContextKey, apiOperationReadinessContextKeyRef.current) ||
        !selectedOperationClosure || selectedNode?.type !== "api.operation") return;
    if (binding !== undefined && boundCompatibleApiOperationConnection(
      selectedOperationClosure.authentication,
      binding,
      visibleConnectionMetadataState.choices,
    ) === null) return;
    const current = historyRef.current?.graph;
    const nodeId = selectionRef.current.primaryNodeId;
    const node = current?.nodes.find((candidate) => candidate.id === nodeId);
    if (!current || !node || node.type !== "api.operation" || node.id !== selectedNode.id) return;
    const exists = Object.hasOwn(node.params, "readinessBinding");
    if (binding === undefined && !exists) return;
    dispatch({
      v: 1,
      id: genCommandId("api-operation-binding"),
      kind: "node.patch",
      nodeId: node.id,
      patch: [binding === undefined
        ? { op: "remove", path: "/readinessBinding" }
        : { op: exists ? "replace" : "add", path: "/readinessBinding", value: binding }],
    }, { label: "Updated Test connection binding" });
  }, [apiOperationReadinessContextKey, dispatch, selectedNode, selectedOperationClosure, visibleConnectionMetadataState.choices]);

  const handleApiOperationPinChange = useCallback((key: string, value: string): void => {
    if (!isCurrentStudioContext(apiOperationContextKey, apiOperationContextKeyRef.current)) return;
    invalidateStudioSimulationForPinChange({
      contextKey: apiOperationContextKey,
      key,
      value,
      generation: simulationGenerationRef,
      controller: simulationAbortRef,
      setSimulation: setSimulationState,
      setPins: setApiOperationPinValues,
    });
  }, [apiOperationContextKey]);

  const handleApiOperationSimulation = useCallback(async (): Promise<void> => {
    if (!isCurrentStudioContext(apiOperationContextKey, apiOperationContextKeyRef.current) ||
        !isCurrentStudioContext(operationClosureContextKey, operationClosureContextKeyRef.current) ||
        !CONNECTOR_LAB_ENABLED || !persistedId || !testEnvironment || !selectedNode ||
        selectedNode.type !== "api.operation" || !selectedOperationClosure || apiOperationSimulationReason ||
        apiOperationSimulationPlan?.status !== "ready") return;
    const parsedPins = parseTestRunPinValues(apiOperationSimulationPlan.pins, effectiveApiOperationPinValues);
    if (!parsedPins.ok) {
      setSimulationState({ contextKey: apiOperationContextKey, value: { status: "error", message: "Enter valid values for every required simulation boundary input." } });
      return;
    }
    simulationGenerationRef.current += 1;
    const generation = simulationGenerationRef.current;
    simulationAbortRef.current?.abort();
    const controller = new AbortController();
    simulationAbortRef.current = controller;
    if (simulationClientRef.current === null) simulationClientRef.current = createApiOperationSimulationClient();
    const graphSnapshot = graph;
    const nodeId = selectedNode.id;
    setSimulationState({ contextKey: apiOperationContextKey, value: { status: "busy" } });
    try {
      const receipt = await simulationClientRef.current.simulate(persistedId, {
        environmentId: testEnvironment.id,
        nodeId,
        pinnedInputs: parsedPins.pinnedInputs,
        scope: "from-node",
      }, controller.signal);
      if (controller.signal.aborted || generation !== simulationGenerationRef.current ||
          historyRef.current?.graph !== graphSnapshot || selectionRef.current.primaryNodeId !== nodeId ||
          persistedIdRef.current !== persistedId || apiOperationContextKeyRef.current !== apiOperationContextKey) return;
      setSimulationState({ contextKey: apiOperationContextKey, value: { status: "success", receipt } });
    } catch {
      if (!controller.signal.aborted && generation === simulationGenerationRef.current &&
          historyRef.current?.graph === graphSnapshot && selectionRef.current.primaryNodeId === nodeId &&
          apiOperationContextKeyRef.current === apiOperationContextKey) {
        setSimulationState({ contextKey: apiOperationContextKey, value: { status: "error", message: "Simulation could not be completed safely." } });
      }
    } finally {
      if (simulationAbortRef.current === controller) simulationAbortRef.current = null;
    }
  }, [
    apiOperationSimulationPlan,
    apiOperationContextKey,
    apiOperationSimulationReason,
    effectiveApiOperationPinValues,
    graph,
    operationClosureContextKey,
    persistedId,
    selectedNode,
    selectedOperationClosure,
    testEnvironment,
  ]);

  const handleApiOperationReadiness = useCallback(async (): Promise<void> => {
    if (!isCurrentStudioContext(apiOperationReadinessContextKey, apiOperationReadinessContextKeyRef.current) ||
        !isCurrentStudioContext(operationClosureContextKey, operationClosureContextKeyRef.current) ||
        !CONNECTOR_LAB_ENABLED || !selectedNode || selectedNode.type !== "api.operation" ||
        !selectedOperationClosure || apiOperationReadinessReason) return;
    readinessGenerationRef.current += 1;
    const generation = readinessGenerationRef.current;
    readinessAbortRef.current?.abort();
    const controller = new AbortController();
    readinessAbortRef.current = controller;
    if (readinessClientRef.current === null) readinessClientRef.current = createConnectorReadinessClient();
    const graphSnapshot = graph;
    const nodeId = selectedNode.id;
    setReadinessState({ contextKey: apiOperationReadinessContextKey, value: { status: "busy" } });
    try {
      const result = await readinessClientRef.current.check({
        reference: selectedOperationClosure.reference,
        ...(selectedOperationConnection === null
          ? {}
          : { expectedLifecycleRevision: selectedOperationConnection.lifecycleRevision }),
      }, controller.signal);
      if (controller.signal.aborted || generation !== readinessGenerationRef.current ||
          historyRef.current?.graph !== graphSnapshot || selectionRef.current.primaryNodeId !== nodeId ||
          apiOperationReadinessContextKeyRef.current !== apiOperationReadinessContextKey) return;
      setReadinessState({ contextKey: apiOperationReadinessContextKey, value: { status: "success", receipt: result.readiness } });
    } catch {
      if (!controller.signal.aborted && generation === readinessGenerationRef.current &&
          historyRef.current?.graph === graphSnapshot && selectionRef.current.primaryNodeId === nodeId &&
          apiOperationReadinessContextKeyRef.current === apiOperationReadinessContextKey) {
        setReadinessState({ contextKey: apiOperationReadinessContextKey, value: { status: "error", message: "Test readiness is unavailable. Authentication remains unverified." } });
      }
    } finally {
      if (readinessAbortRef.current === controller) readinessAbortRef.current = null;
    }
  }, [apiOperationReadinessContextKey, apiOperationReadinessReason, graph, operationClosureContextKey, selectedNode, selectedOperationClosure, selectedOperationConnection]);

  const handleApiOperationPick = useCallback((closure: ApiOperationBrowserClosureProjection): void => {
    if (!CONNECTOR_LAB_ENABLED || closure.archivedAt !== null ||
        apiOperationPickerContextRef.current !== operationClosureContextKey ||
        !isCurrentStudioContext(operationClosureContextKey, operationClosureContextKeyRef.current)) return;
    const current = historyRef.current?.graph;
    if (!current) return;
    const offset = current.nodes.length * 28;
    dispatch(commandForApiOperationPick({
      closure,
      position: { x: 160 + offset, y: 120 + offset },
      commandId: genCommandId("api-operation-picker"),
      nodeId: genNodeId(),
    }), { label: "Added API operation" });
    apiOperationPickerContextRef.current = null;
    setApiOperationPickerOpen(false);
  }, [dispatch, operationClosureContextKey]);

  const handleOpenApiOperationPicker = useCallback((): void => {
    if (!CONNECTOR_LAB_ENABLED || ownerScopeHash === null) return;
    apiOperationPickerContextRef.current = operationClosureContextKey;
    setApiOperationPickerOpen(true);
  }, [operationClosureContextKey, ownerScopeHash]);

  const handleCloseApiOperationPicker = useCallback((): void => {
    apiOperationPickerContextRef.current = null;
    setApiOperationPickerOpen(false);
  }, []);

  const flowVariables = graph && "schemaVersion" in graph ? graph.variables : [];
  const upstreamPorts = useMemo(() => {
    if (!graph || !resolveAuthoringPorts || !selection.primaryNodeId) return [];
    const upstreamIds = new Set<string>();
    const pending = graph.edges.filter((edge) => edge.target === selection.primaryNodeId).map((edge) => edge.source);
    while (pending.length > 0) {
      const nodeId = pending.pop();
      if (!nodeId || upstreamIds.has(nodeId)) continue;
      upstreamIds.add(nodeId);
      for (const edge of graph.edges) if (edge.target === nodeId) pending.push(edge.source);
    }
    return graph.nodes
      .filter((node) => upstreamIds.has(node.id))
      .flatMap((node) => resolveAuthoringPorts(node).outputPorts.map((port) => ({
        nodeId: node.id,
        nodeLabel: getNodeDefinition(node.type).label,
        portId: port.id,
        portLabel: port.label,
        schema: port.schema,
      })))
      .sort((left, right) => `${left.nodeId}\0${left.portId}`.localeCompare(`${right.nodeId}\0${right.portId}`));
  }, [graph, resolveAuthoringPorts, selection.primaryNodeId]);

  const selectedNodePortIssues = useMemo(() => {
    if (!graph || !selectedNode) return [];
    try {
      assertGraphPortReferences(graph, undefined, resolveAuthoringPorts ?? undefined);
      return [];
    } catch (error) {
      return [error instanceof Error ? error.message : "This graph contains an invalid port reference."];
    }
  }, [graph, resolveAuthoringPorts, selectedNode]);

  // Sample trigger input for the run dock, built from the Input node's
  // declared default fields (if any) so a test run doesn't start from `{}`.
  const sampleTriggerInput = useMemo<Record<string, unknown> | null>(() => {
    if (!graph) return null;
    const inputNode = graph.nodes.find((n) => n.type === "input");
    const fields = inputNode?.params.fields;
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      return fields as Record<string, unknown>;
    }
    return null;
  }, [graph]);

  if (!graph) {
    return (
      <main
        style={{
          height: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "var(--space-4)",
          padding: "var(--space-6)",
          textAlign: "center",
          background: "var(--ink-deep)",
        }}
      >
        <span
          className="eyebrow"
          role={loadError || ownerLoadError ? "alert" : "status"}
        >
          {loadError ?? ownerLoadError ?? (recoveryUi?.state === "conflict" ? "Choose a workflow to continue." : "Loading flow…")}
        </span>
        {ownerLoadError ? (
          <button
            type="button"
            className="lp-btn lp-btn--ghost lp-btn--sm"
            onClick={() => {
              setOwnerLoadError(null);
              setOwnerLoadRetry((retry) => retry + 1);
            }}
          >
            Retry owner check
          </button>
        ) : null}
        {/* A failed load used to render one line of 12px text on a blank page
            with nothing interactive — the root layout renders no nav here, so
            the browser's back button was the only way out. */}
        {loadError ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", justifyContent: "center" }}>
            <button
              type="button"
              className="lp-btn lp-btn--primary lp-btn--sm"
              onClick={() => {
                setLoadError(null);
                setFlowLoadRetry((retry) => retry + 1);
              }}
            >
              Try again
            </button>
            <Link href="/flows" className="lp-btn lp-btn--ghost lp-btn--sm">
              Back to workspace
            </Link>
          </div>
        ) : null}
        {recoveryUi ? (
          <StudioRecoveryBanner
            state={recoveryUi.state}
            message={recoveryUi.message}
            onSaveRecovered={handleSaveRecovered}
            onDiscardRecovered={handleDiscardRecovered}
            onRecoverConflict={handleRecoverConflict}
            onKeepSaved={handleKeepSaved}
            busy={saving}
          />
        ) : null}
      </main>
    );
  }

  const impactBlockedMessage = impactActionBlocker();
  const launchActionBlocker = impactBlockedMessage ?? referenceBlocker("launch")?.message ?? null;
  const versionActionBlockedMessage = impactBlockedMessage ?? referenceBlocker("version")?.message ?? null;
  const promotionReceiptBlockedMessage = deploymentHistory.status === "ready"
    ? null
    : deploymentHistory.status === "loading"
      ? "Wait for environment receipts to finish checking."
      : "Environment receipts are unavailable. Retry version history.";
  const testPromotionDisabledReason = versionActionBlockedMessage ?? promotionReceiptBlockedMessage ??
    (testEnvironment ? null : "The Test environment is unavailable.");
  const livePromotionDisabledReason = versionActionBlockedMessage ?? promotionReceiptBlockedMessage ??
    (liveEnvironment
      ? activeTestDeployment
        ? selectedVersionId === activeTestDeployment.flowVersionId
          ? null
          : "The active Test receipt is a different version."
        : "Promote this exact version to Test before Live is available."
      : "The Live environment is unavailable.");

  return (
    <main
      className={forceCompactCanvas ? "studio-shell studio-force-canvas" : "studio-shell"}
      style={{
        height: "100dvh",
        display: "grid",
        // Row 1 holds the optional Guided arrival banner and collapses to 0
        // when absent; rows 2-5 are pinned in site.css (header, context stack,
        // editor body, run dock) so the banner can never displace them.
        gridTemplateRows: "auto auto auto minmax(0, 1fr) auto",
        background: "var(--ink-deep)",
        overflow: "hidden",
      }}
    >
      <p
        id="studio-reference-save-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {/* launchError sits ahead of impactBlockedMessage: the latter is
            recomputed every render and would mask a fresh launch failure,
            leaving the page's primary action with no non-visual outcome. */}
        {commandAnnouncement || launchError || impactBlockedMessage || referenceSaveBlocked ||
          saveError || (saving ? "Saving the current draft." : "Current draft saved.")}
      </p>
      {recoveryUi ? (
        <StudioRecoveryBanner
          state={recoveryUi.state}
          message={recoveryUi.message}
          onSaveRecovered={handleSaveRecovered}
          onDiscardRecovered={handleDiscardRecovered}
          onRecoverConflict={handleRecoverConflict}
          onKeepSaved={handleKeepSaved}
          busy={saving}
        />
      ) : null}
      {fromGuided && !guidedBannerDismissed ? (
        <div
          className="mono"
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 16px",
            background: "color-mix(in srgb, var(--primary) 8%, var(--ink-panel))",
            borderBottom: "1px solid var(--hairline)",
            fontSize: "var(--text-xs)",
            color: "var(--text-primary)",
          }}
        >
          <span style={{ flex: 1 }}>
            Built from your description. This is the same agent, as a canvas.
            Each card you approved is a node here; click one to see its
            settings. Nothing changes until you save.
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setGuidedBannerDismissed(true)}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: "var(--text-sm)",
            }}
          >
            ✕
          </button>
        </div>
      ) : null}
      {/* Header bar */}
      <header
        className="studio-desktop-only studio-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "10px 16px",
          borderBottom: "1px solid var(--hairline)",
          background: "var(--ink-panel)",
        }}
      >
        <Link
          href="/"
          onClick={(event) => interceptStudioNavigation(event, "/")}
          onAuxClick={(event) => interceptStudioNavigation(event, "/")}
          className="eyebrow"
          style={{ color: "var(--primary)", textDecoration: "none" }}
        >
          Suede Agent Studio
        </Link>
        <input
          value={graph.name}
          onChange={(e) => handleNameChange(e.target.value)}
          aria-label="Flow name"
          style={{
            flex: 1,
            maxWidth: 420,
            background: "transparent",
            border: "1px solid transparent",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-primary)",
            fontFamily: "var(--font-display)",
            fontSize: "var(--text-h3)",
            minHeight: "var(--control-h)",
            padding: "2px 8px",
          }}
          onFocus={(e) => {
            nameGroupRef.current = genCommandId("name-focus");
            e.currentTarget.style.borderColor = "var(--hairline)";
          }}
          onBlur={(e) => {
            nameGroupRef.current = null;
            e.currentTarget.style.borderColor = "transparent";
          }}
        />
        <span
          className="mono"
          title={impactBlockedMessage ?? referenceSaveBlocked ?? undefined}
          style={{ fontSize: "var(--text-label)", color: "var(--text-muted)" }}
        >
          {saving
            ? "saving…"
            : impactBlockedMessage
              ? "impact review · not saved"
              : referenceSaveBlocked
              ? "verification needed · not saved"
              : saveError
                ? "save error"
                : "saved"}
        </span>
        <Link
          href="/flows"
          onClick={(event) => interceptStudioNavigation(event, "/flows")}
          onAuxClick={(event) => interceptStudioNavigation(event, "/flows")}
          className="mono"
          style={{
            fontSize: "var(--text-label)",
            color: "var(--text-muted)",
            textDecoration: "none",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Workspace
        </Link>
        <ModeSwitch
          active="studio"
          flowId={persistedId ?? undefined}
          onNavigate={(href, event) => interceptStudioNavigation(event, href)}
        />
        <details className="studio-publish-settings">
          <summary>
            <span>Publish</span>
            <strong>
              {priceUsdc.trim() === "" ? "set a price" : `$${priceUsdc.trim()} / call`}
            </strong>
          </summary>
          <div className="studio-publish-settings__panel">
            <label>
              Price per call
              <span className="studio-publish-settings__price">
                $
                <input
                  value={priceUsdc}
                  onChange={(e) => setPriceUsdc(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.05"
                  aria-label="Per-call price in USDC"
                  title="Required before launch. Enter 0 to serve calls free."
                />
                USDC
              </span>
            </label>
            {launch && (typeof launch.floorUsdc === "number" || typeof launch.suggestedUsdc === "number") ? (
              <p
                className="mono"
                style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}
              >
                {typeof launch.floorUsdc === "number"
                  ? `Cost floor $${launch.floorUsdc.toFixed(3)} per call. `
                  : ""}
                {typeof launch.suggestedUsdc === "number"
                  ? `Suggested $${launch.suggestedUsdc.toFixed(3)}.`
                  : ""}
              </p>
            ) : null}
            <label>
              Payout wallet on Base
              <input
                value={payoutAddress}
                onChange={(e) => setPayoutAddress(e.target.value)}
                placeholder="0x payout wallet"
                aria-label="Payout wallet address (USDC on Base)"
                title="Where paid calls route: your wallet on Base. Saved with the workspace on launch."
                spellCheck={false}
              />
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={collectOnLaunch}
                onChange={(e) => setCollectOnLaunch(e.target.checked)}
                aria-describedby="studio-collect-on-launch-note"
              />
              Start collecting payment on launch
            </label>
            <p
              id="studio-collect-on-launch-note"
              className="mono"
              style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}
            >
              Unchecked, launched calls run as free previews until you turn on
              Settle from your Workspace.
            </p>
          </div>
        </details>
        {/* State-aware primary: the header always promotes the next safe
            action (Run test → Save version → Launch → View endpoint) instead
            of a permanent Launch. Launch stays reachable as a quiet action in
            the earlier states, so a returning owner is never gated. */}
        {studioPrimaryAction !== "launch" && studioPrimaryAction !== "view-endpoint" && (
          <button
            type="button"
            onClick={() => void handleLaunch()}
            aria-disabled={Boolean(launchActionBlocker)}
            aria-describedby={launchActionBlocker ? "studio-reference-save-status" : undefined}
            title={launchActionBlocker ?? "Launch this flow as a paid endpoint."}
            style={{
              minHeight: "var(--control-h)",
              padding: "0 14px",
              background: "transparent",
              color: "var(--text-muted)",
              border: "1px solid var(--hairline)",
              borderRadius: "var(--radius)",
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              fontSize: "var(--text-eyebrow)",
              cursor: "pointer",
            }}
          >
            Launch
          </button>
        )}
        {studioPrimaryAction === "view-endpoint" && launch ? (
          <Link
            href={`/a/${launch.slug}`}
            title="Open the public page for this launched agent."
            style={{
              display: "inline-flex",
              alignItems: "center",
              minHeight: "var(--control-h)",
              padding: "0 18px",
              background: "var(--primary)",
              color: "var(--on-primary)",
              border: "1px solid var(--primary)",
              borderRadius: "var(--radius)",
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              fontSize: "var(--text-eyebrow)",
              textDecoration: "none",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            View endpoint
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (studioPrimaryAction === "run-test") {
                // Clear any scoped test first so the dock's guarded run path
                // executes the full flow, then trigger it after re-render.
                setTestScope(null);
                requestAnimationFrame(() => runDockControlRef.current?.click());
                return;
              }
              if (studioPrimaryAction === "save-version") {
                void handleSaveVersion();
                return;
              }
              void handleLaunch();
            }}
            aria-disabled={
              studioPrimaryAction === "run-test"
                ? runDockBusy || testRunDisabledReason !== null
                : studioPrimaryAction === "save-version"
                  ? versionSaving
                  : Boolean(launchActionBlocker)
            }
            aria-describedby={
              studioPrimaryAction === "launch" && launchActionBlocker
                ? "studio-reference-save-status"
                : undefined
            }
            title={
              studioPrimaryAction === "run-test"
                ? testRunDisabledReason ??
                  "Run the flow in Test first: watch every node stream its result and cost."
                : studioPrimaryAction === "save-version"
                  ? "The test passed. Save an immutable version of this flow before launching."
                  : launchActionBlocker ?? undefined
            }
            style={{
              minHeight: "var(--control-h)",
              padding: "0 18px",
              background: "var(--primary)",
              color: "var(--on-primary)",
              border: "1px solid var(--primary)",
              borderRadius: "var(--radius)",
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              fontSize: "var(--text-eyebrow)",
              cursor: "pointer",
              boxShadow: "var(--shadow-sm)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--primary-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--primary)";
            }}
          >
            {studioPrimaryAction === "run-test"
              ? runDockBusy
                ? "Running…"
                : "Run test"
              : studioPrimaryAction === "save-version"
                ? versionSaving
                  ? "Saving…"
                  : "Save version"
                : "Launch"}
          </button>
        )}
      </header>

      <div className="studio-desktop-only studio-context-stack">
        <WorkbookTabs
          tabs={workbookTabs}
          activeFlowId={flowId}
          busyFlowId={busyFlowId}
          error={workbookTabError}
          focusHandoff={pendingTabFocusRef}
          onActivate={handleWorkbookTabActivate}
        />
        <div className="studio-subflow-context">
          <SubflowBreadcrumbs
            state={subflowBreadcrumbState}
            onNavigate={handleSubflowBreadcrumbNavigate}
          />
          {subflowBreadcrumbState.kind === "error" ? <button
            type="button"
            className="btn btn-secondary task6-target"
            onClick={() => setSubflowBreadcrumbRetry((value) => value + 1)}
          >Retry trail</button> : null}
          <PinnedReferenceBanner state={pinnedReferenceBannerState} />
        </div>
      </div>

      <FlowImpactDialog
        open={impactDialogOpen}
        busy={impactConfirming}
        impact={impactPending?.impact ?? null}
        onConfirm={() => void handleConfirmImpact()}
        onDismiss={() => setImpactDialogOpen(false)}
      />

      <VersionReviewDialog
        open={selectedVersionId !== null}
        readOnly={false}
        busyAction={versionReviewBusy}
        version={selectedVersion}
        diffState={versionReviewDiff}
        activeTestVersionId={activeTestDeployment?.flowVersionId ?? null}
        livePhrase={livePromotionPhrase}
        onLivePhraseChange={setLivePromotionPhrase}
        onDismiss={handleDismissVersionReview}
        onRestore={() => void handleReviewRestore()}
        onPromoteTest={() => void handlePromoteVersionToTest()}
        onPromoteLive={() => void handlePromoteVersionToLive()}
        triggerRef={versionReviewTriggerRef}
        restoreDisabledReason={versionActionBlockedMessage}
        testDisabledReason={testPromotionDisabledReason}
        liveDisabledReason={livePromotionDisabledReason}
      />

      {impactPending && !impactDialogOpen && (
        <div
          style={{
            position: "fixed",
            top: 88,
            left: 12,
            right: 12,
            zIndex: 30,
          }}
        >
          <Banner tone="info">
            <span>This exact save affects reusable-flow dependents and still needs review.</span>{" "}
            <button
              type="button"
              onClick={() => setImpactDialogOpen(true)}
              disabled={impactConfirming}
            >
              Review impact
            </button>
          </Banner>
        </div>
      )}

      {pasteResolutionError && (
        <div
          style={{
            position: "fixed",
            top: impactPending && !impactDialogOpen ? 146 : 88,
            left: 12,
            right: 12,
            zIndex: 30,
          }}
        >
          <Banner tone="error">
            <span>{pasteResolutionError}</span>{" "}
            <button
              type="button"
              onClick={handleRetryPendingPaste}
              disabled={pasteResolving || retryPasteIntentRef.current === null}
            >
              Retry paste
            </button>
          </Banner>
        </div>
      )}

      {/* Editor body */}
      <div
        className="studio-desktop-only studio-editor-body"
        style={{
          minHeight: 0,
          height: "100%",
        }}
      >
        <NodePalette
          onAdd={handleAddNode}
          apiOperationTriggerRef={apiOperationPickerTriggerRef}
          {...(CONNECTOR_LAB_ENABLED ? { onBrowseApiOperations: handleOpenApiOperationPicker } : {})}
        />
        {CONNECTOR_LAB_ENABLED && apiOperationPickerOpen &&
        apiOperationPickerContextRef.current === operationClosureContextKey ? <ConnectorBrowser
          key={operationClosureContextKey}
          mode="pick"
          onPick={handleApiOperationPick}
          onClose={handleCloseApiOperationPicker}
          returnFocusRef={apiOperationPickerTriggerRef}
        /> : null}
        <div
          ref={canvasColumnRef}
          style={{ position: "relative", minWidth: 0, height: "100%" }}
        >
          {(loadError || saveError || launchError || launch) && (
            <div
              style={{
                position: "absolute",
                top: 12,
                left: 12,
                right: 12,
                zIndex: 10,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                pointerEvents: "none",
              }}
            >
              {loadError && (
                <Banner tone="error">{loadError}</Banner>
              )}
              {saveError && !impactPending && !impactConfirming && (
                <Banner tone="error">
                  <span>{saveError}</span>{" "}
                  <button
                    type="button"
                    onClick={() => void handleRetrySave()}
                    style={{ pointerEvents: "auto" }}
                  >
                    Retry save
                  </button>
                </Banner>
              )}
              {launchError && (
                <Banner tone="error">{launchError}</Banner>
              )}
              {launch && (
                <LaunchPanel
                  info={launch}
                  onClose={() => setLaunch(null)}
                  onSettlementLive={() =>
                    setLaunch((prev) => (prev ? { ...prev, settlementLive: true } : prev))
                  }
                  onWebhookRotated={(secret) =>
                    setLaunch((prev) =>
                      prev && prev.webhook
                        ? { ...prev, webhook: { ...prev.webhook, secret } }
                        : prev,
                    )
                  }
                  onWebhookRevoked={() =>
                    setLaunch((prev) => (prev ? { ...prev, webhook: null } : prev))
                  }
                />
              )}
            </div>
          )}
          <FlowCanvas
            key={forceCompactCanvas ? "compact-canvas-open" : "canvas"}
            graph={graph}
            resolvePorts={resolveAuthoringPorts ?? undefined}
            selection={selection}
            onCommand={dispatch}
            onSelectionChange={handleCanvasSelection}
            onMeasuredBoundsChange={replaceMeasuredBounds}
            focusRequest={canvasFocusRequest}
            focusNodeRequest={canvasFocusNodeRequest}
            statuses={statuses}
            onAnnounce={setCommandAnnouncement}
            initialViewport={initialCanvasViewport}
            onViewportChange={(viewport) => {
              canvasViewportRef.current = viewport;
            }}
          />
          <BuilderCommandBar
            ref={commandsTriggerRef}
            context={commandContext}
            onCommand={executeBuilderCommand}
          />
          <CommandPalette
            open={commandPaletteOpen}
            context={commandContext}
            onClose={() => setCommandPaletteOpen(false)}
            onCommand={executeBuilderCommand}
            triggerRef={commandsTriggerRef}
          />
          <p
            className="builder-command-announcement"
          >
            {commandAnnouncement}
          </p>
        </div>
        <div className="studio-inspector-rail">
          <ProjectContext
            context={projectContext}
            versionCount={versionHistory.status === "ready" ? versionHistory.versions.length : 0}
            loading={contextLoading}
            error={contextError}
            showEnvironment
            versions={versionHistory.status === "ready" ? versionHistory.versions : []}
            deploymentHistory={deploymentHistory}
          />
          <VersionPanel
            state={versionHistory}
            readOnly={false}
            canSave={Boolean(graph && persistedId && versionHistory.status === "ready" && !saving && !impactBlockedMessage && !referenceBlocker("version"))}
            saving={versionSaving}
            announcement={versionAnnouncement}
            onSave={() => void handleSaveVersion()}
            onRetry={() => void loadProjectState()}
            onReview={(version, trigger) => handleOpenVersionReview(version.id, trigger)}
          />
          <div className="studio-variables-slot">
            <FlowVariablesPanel
              variables={flowVariables}
              onAdd={handleVariableAdd}
              onPatch={handleVariablePatch}
              onRemove={handleVariableRemove}
            />
          </div>
          <div className="studio-inspector-slot">
            <Inspector
              node={selectedNode}
              graph={graph}
              resolvePorts={resolveAuthoringPorts ?? undefined}
              graphVersion={"schemaVersion" in graph ? 2 : 1}
              variables={flowVariables}
              upstreamPorts={upstreamPorts}
              validationIssues={selectedNodePortIssues}
              onPatch={handleParamsPatch}
              onSetBinding={handleBindingSet}
              onRemoveBinding={handleBindingRemove}
              onCallableInterfaceSet={handleCallableInterfaceSet}
              onCallableInterfaceRemove={handleCallableInterfaceRemove}
              parentFlowId={sessionParentFlowId}
              referenceResolutionStatus={selectedNode && (selectedNode.type === "subflow" || selectedNode.type === "loop") &&
                Object.hasOwn(selectedNode.params, "reference") &&
                !referenceBlocker("save")?.nodeIds.includes(selectedNode.id) ? "resolved" : undefined}
              onSubflowReferenceResolved={handleSubflowReferenceResolved}
              onOpenResolvedSubflow={handleOpenResolvedSubflow}
              onRunTestScope={handleRunTestScope}
              testRunDisabledReason={testRunDisabledReason}
              testRunBusy={runDockBusy}
              connectionChoices={visibleConnectionMetadataState.choices}
              connectionChoicesStatus={visibleConnectionMetadataState.status}
              apiOperationAuthoringEnabled={CONNECTOR_LAB_ENABLED}
              apiOperation={CONNECTOR_LAB_ENABLED && selectedNode?.type === "api.operation" ? {
                closure: selectedOperationClosure,
                readinessBinding: selectedOperationClosure?.reference.readinessBinding,
                connectionChoices: visibleConnectionMetadataState.choices,
                connectionChoicesStatus: visibleConnectionMetadataState.status,
                disabledReason: apiOperationAuthorityReason,
                simulationDisabledReason: apiOperationSimulationReason,
                readinessDisabledReason: apiOperationReadinessReason,
                simulation: visibleSimulationState,
                readiness: visibleReadinessState,
                simulationPins: apiOperationSimulationPlan?.status === "ready"
                  ? apiOperationSimulationPlan.pins.map((pin) => ({
                      key: pin.key,
                      label: pin.label,
                      control: pin.control,
                      value: effectiveApiOperationPinValues[pin.key] ?? (pin.control === "boolean" ? "false" : "null"),
                    }))
                  : [],
                onSimulationPinChange: handleApiOperationPinChange,
                onReadinessBindingChange: handleApiOperationBindingChange,
                onSimulate: () => { void handleApiOperationSimulation(); },
                onCheckReadiness: () => { void handleApiOperationReadiness(); },
              } : undefined}
            />
          </div>
        </div>
      </div>

      {/* Run dock */}
      <div className="studio-desktop-only studio-run-dock" style={{ height: 220, minHeight: 0 }}>
        {(
          <RunDock
            flowId={persistedId ?? graph.id}
            prepareRun={persistedId ? undefined : async () => {
              await persist(graph);
              const rowId = persistedIdRef.current;
              if (!rowId) throw new Error("The draft was not assigned a saved flow id.");
              return rowId;
            }}
            immutableVersionStatus={versionHistory.status}
            immutableVersion={latestImmutableVersion ? { id: latestImmutableVersion.id, versionNumber: latestImmutableVersion.versionNumber } : null}
            graph={v2TestGraph}
            testEnvironment={testEnvironment ? { id: testEnvironment.id, name: testEnvironment.name } : null}
            testScope={effectiveTestScope}
            onTestScopeClear={() => setTestScope(null)}
            onRunningChange={handleRunDockRunning}
            onStatuses={setStatuses}
            runControlRef={runDockControlRef}
            defaultTriggerInput={sampleTriggerInput}
            runBlocker={() => impactActionBlocker() ?? referenceBlocker("run")?.message ?? null}
            apiOperationSimulation={CONNECTOR_LAB_ENABLED && selectedNode?.type === "api.operation"
              ? visibleSimulationState
              : undefined}
          />
        )}
      </div>

      {/* The canvas needs a pointer + room; compact widths hand off gracefully. */}
      <div className="studio-mobile-guard">
        <nav className="studio-mobile-topbar" aria-label="Studio">
          <Link
            href="/"
            onClick={(event) => interceptStudioNavigation(event, "/")}
            onAuxClick={(event) => interceptStudioNavigation(event, "/")}
          >
            Suede Agent Studio
          </Link>
          <Link
            href="/flows"
            onClick={(event) => interceptStudioNavigation(event, "/flows")}
            onAuxClick={(event) => interceptStudioNavigation(event, "/flows")}
          >
            Workspace
          </Link>
        </nav>
        <h2>The studio wants a bigger canvas.</h2>
        <p>
          Widen this window or open it on a larger display to wire nodes.
          Guided mode can build the agent for you here, and the directory
          stays ready for browsing and running live agents.
        </p>
        <div className="studio-mobile-actions">
          <Link
            href="/start"
            className="lp-btn lp-btn--primary"
            onClick={(event) => interceptStudioNavigation(event, "/start")}
            onAuxClick={(event) => interceptStudioNavigation(event, "/start")}
          >
            Build with Guided mode →
          </Link>
          <Link
            href="/agents"
            className="lp-btn lp-btn--ghost"
            onClick={(event) => interceptStudioNavigation(event, "/agents")}
            onAuxClick={(event) => interceptStudioNavigation(event, "/agents")}
          >
            Browse the directory →
          </Link>
          <button
            type="button"
            className="lp-btn lp-btn--ghost studio-compact-canvas-override"
            onClick={() => setForceCompactCanvas(true)}
          >
            Open compact canvas anyway
          </button>
        </div>
        <span className="studio-compact-canvas-note">
          Compact canvas is available here; 1280px or wider is recommended.
        </span>
        {persistedId ? (
          <>
            <ProjectContext
              context={projectContext}
              versionCount={versionHistory.status === "ready" ? versionHistory.versions.length : 0}
              loading={contextLoading}
              error={contextError}
              showEnvironment
              versions={versionHistory.status === "ready" ? versionHistory.versions : []}
              deploymentHistory={deploymentHistory}
            />
            <VersionPanel
              state={versionHistory}
              readOnly
              canSave={false}
              saving={false}
              announcement={versionAnnouncement}
              defaultOpen
              onRetry={() => void loadProjectState()}
            />
          </>
        ) : null}
      </div>
    </main>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "error" | "info";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className="mono"
      style={{
        pointerEvents: "auto",
        background: "var(--ink-control)",
        border: `1px solid ${
          tone === "error" ? "var(--rights-red)" : "var(--hairline-cyan)"
        }`,
        borderRadius: "var(--radius)",
        padding: "8px 12px",
        fontSize: "var(--text-xs)",
        color:
          tone === "error"
            ? "var(--rights-red)"
            : "var(--text-primary)",
      }}
    >
      {children}
    </div>
  );
}

function LaunchPanel({
  info,
  onClose,
  onSettlementLive,
  onWebhookRotated,
  onWebhookRevoked,
}: {
  info: LaunchInfo;
  onClose: () => void;
  onSettlementLive: () => void;
  onWebhookRotated: (secret: string) => void;
  onWebhookRevoked: () => void;
}): React.JSX.Element {
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [settling, setSettling] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const handleEnableSettlement = useCallback(async (): Promise<void> => {
    if (settling) return;
    setSettleError(null);
    setSettling(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(info.slug)}/settlement`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ live: true }),
      });
      if (!res.ok) {
        throw new Error("Couldn't turn on settlement. You can also flip Settle from your Workspace.");
      }
      onSettlementLive();
    } catch (err: unknown) {
      setSettleError(
        err instanceof Error
          ? err.message
          : "Couldn't turn on settlement. You can also flip Settle from your Workspace.",
      );
    } finally {
      setSettling(false);
    }
  }, [info.slug, settling, onSettlementLive]);

  // The panel appears after Launch and carries the shown-once webhook signing
  // secret; move focus here so it is reachable without hunting for it.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const handleRotate = useCallback(async (): Promise<void> => {
    if (!info.agentId || rotating) return;
    setRotateError(null);
    setRotating(true);
    try {
      const res = await fetch(`/api/agents/${info.agentId}/webhook/rotate`, {
        method: "POST",
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const serverError =
          typeof data === "object" && data !== null
            ? (data as { error?: unknown }).error
            : undefined;
        throw new Error(
          typeof serverError === "string" ? serverError : `Rotation failed (${res.status})`,
        );
      }
      const secret =
        typeof data === "object" && data !== null
          ? (data as { secret?: unknown }).secret
          : undefined;
      if (typeof secret !== "string") {
        throw new Error("Rotation response missing secret.");
      }
      onWebhookRotated(secret);
    } catch (err: unknown) {
      setRotateError(err instanceof Error ? err.message : "Rotation failed.");
    } finally {
      setRotating(false);
    }
  }, [info.agentId, rotating, onWebhookRotated]);

  const handleRevoke = useCallback(async (): Promise<void> => {
    if (!info.agentId || revoking) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Disable inbound webhooks for this agent? Any sender using the current secret will stop working. You can re-enable it by relaunching.",
      )
    ) {
      return;
    }
    setRotateError(null);
    setRevoking(true);
    try {
      const res = await fetch(`/api/agents/${info.agentId}/webhook`, {
        method: "DELETE",
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const serverError =
          typeof data === "object" && data !== null
            ? (data as { error?: unknown }).error
            : undefined;
        throw new Error(
          typeof serverError === "string" ? serverError : `Revoke failed (${res.status})`,
        );
      }
      onWebhookRevoked();
    } catch (err: unknown) {
      setRotateError(err instanceof Error ? err.message : "Revoke failed.");
    } finally {
      setRevoking(false);
    }
  }, [info.agentId, revoking, onWebhookRevoked]);
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-label={`Agent live at /a/${info.slug}`}
      style={{
        pointerEvents: "auto",
        background: "var(--ink-control)",
        border: "1px solid var(--hairline-cyan)",
        borderRadius: "var(--radius)",
        padding: "12px 14px",
        boxShadow: "0 0 0 1px var(--glow-cyan)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <span className="eyebrow" style={{ color: "var(--text-success)" }}>
          Agent live
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="mono"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
          }}
        >
          ✕
        </button>
      </div>
      <a
        className="mono"
        href={`/a/${info.slug}`}
        target="_blank"
        rel="noreferrer"
        style={{
          display: "inline-block",
          marginTop: 6,
          fontSize: "var(--text-sm)",
          color: "var(--primary)",
          textDecoration: "none",
        }}
      >
        /a/{info.slug} ↗
      </a>
      <button
        type="button"
        className="mono"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(`${window.location.origin}/a/${info.slug}`)
            .then(() => {
              setShareCopied(true);
              window.setTimeout(() => setShareCopied(false), 1600);
            })
            .catch(() => {});
        }}
        style={{
          marginLeft: 10,
          padding: "1px 8px",
          fontSize: "var(--text-label)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: shareCopied ? "var(--text-success)" : "var(--text-muted)",
          background: "transparent",
          border: "1px solid var(--hairline-visible)",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
        }}
      >
        {shareCopied ? "Copied" : "Copy link"}
      </button>
      {info.schedule && (
        <div
          className="mono"
          style={{
            marginTop: 6,
            fontSize: "var(--text-xs)",
            color: "var(--text-success)",
          }}
        >
          ⏱ runs {info.schedule.description}; fires on its own from here.
        </div>
      )}
      {info.payout && (
        <div
          className="mono"
          style={{
            marginTop: 4,
            fontSize: "var(--text-xs)",
            color:
              info.payout.source === "creator"
                ? "var(--text-success)"
                : "var(--text-muted)",
          }}
        >
          {info.payout.source === "creator"
            ? `→ pays your wallet ${info.payout.payTo.slice(0, 6)}…${info.payout.payTo.slice(-4)}`
            : "→ no payout wallet yet; add one above and relaunch to route earnings to you."}
        </div>
      )}
      {info.payoutWarning && (
        <div
          className="mono"
          role="status"
          style={{ marginTop: 4, fontSize: "var(--text-xs)", color: "var(--text-warning)" }}
        >
          {info.payoutWarning}
        </div>
      )}
      {(typeof info.floorUsdc === "number" || typeof info.suggestedUsdc === "number") && (
        <div
          className="mono"
          style={{ marginTop: 4, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}
        >
          {typeof info.floorUsdc === "number" ? `Cost floor $${info.floorUsdc.toFixed(3)} per call.` : ""}
          {typeof info.floorUsdc === "number" && typeof info.suggestedUsdc === "number" ? " " : ""}
          {typeof info.suggestedUsdc === "number" ? `Suggested $${info.suggestedUsdc.toFixed(3)}.` : ""}
        </div>
      )}
      {info.settlementLive === true ? (
        <div
          className="mono"
          style={{ marginTop: 4, fontSize: "var(--text-xs)", color: "var(--text-success)" }}
        >
          Collecting payment: every paid call settles USDC to the payout wallet.
        </div>
      ) : info.settlementLive === false ? (
        <div style={{ marginTop: 6 }}>
          <div className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
            Calls are free previews until you turn on settlement.
          </div>
          <button
            type="button"
            className="mono"
            onClick={() => void handleEnableSettlement()}
            disabled={settling}
            style={{
              marginTop: 4,
              padding: "2px 8px",
              fontSize: "var(--text-label)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-success)",
              background: "transparent",
              border: "1px solid var(--hairline-visible)",
              borderRadius: "var(--radius-sm)",
              cursor: settling ? "default" : "pointer",
              opacity: settling ? 0.6 : 1,
            }}
          >
            {settling ? "Turning on…" : "Start collecting payment"}
          </button>
          {settleError && (
            <div
              className="mono"
              role="alert"
              style={{ marginTop: 4, fontSize: "var(--text-xs)", color: "var(--rights-red)" }}
            >
              {settleError}
            </div>
          )}
        </div>
      ) : (
        <div
          className="mono"
          style={{ marginTop: 4, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}
        >
          Check the Settle switch on your Workspace to confirm whether this
          agent is collecting payment.
        </div>
      )}
      {info.endpoints && info.endpoints.length > 0 && (
        <ul
          className="mono"
          style={{
            margin: "8px 0 0",
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 3,
            fontSize: "var(--text-xs)",
          }}
        >
          {info.endpoints.map((e) => (
            <li key={e}>
              <a
                href={e}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--text-info)", textDecoration: "none" }}
              >
                {e}
              </a>
            </li>
          ))}
        </ul>
      )}
      {info.agentId ? (
        <div className="mono" style={{ marginTop: 8, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
          Get it discovered by other agents:{" "}
          <a href={`/portfolio/${info.agentId}#discovery`} style={{ color: "var(--text-info)", textDecoration: "none" }}>
            Discovery console
          </a>
          {" "}· Watch it earn:{" "}
          <a href={`/portfolio/${info.agentId}`} style={{ color: "var(--text-info)", textDecoration: "none" }}>
            Earnings
          </a>.
        </div>
      ) : null}
      {info.webhook && (
        <div
          className="mono"
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px solid var(--hairline)",
          }}
        >
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
            Webhook URL
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-info)", wordBreak: "break-all" }}>
            {info.webhook.url}
          </div>
          {info.webhook.secret ? (
            <>
              <div
                style={{
                  marginTop: 6,
                  fontSize: "var(--text-xs)",
                  color: "var(--text-warning)",
                }}
              >
                Save your webhook signing secret
              </div>
              <div
                style={{
                  marginTop: 2,
                  fontSize: "var(--text-xs)",
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                }}
              >
                Shown once. Configure the sender to sign each request with
                HMAC-SHA256 over {"{timestamp}"}.{"{raw body}"} and send it
                as x-suede-webhook-signature and x-suede-webhook-timestamp.
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontSize: "var(--text-xs)",
                  color: "var(--text-primary)",
                  wordBreak: "break-all",
                }}
              >
                {info.webhook.secret}
              </div>
            </>
          ) : (
            <div
              style={{
                marginTop: 4,
                fontSize: "var(--text-xs)",
                color: "var(--text-muted)",
              }}
            >
              Signing secret was generated on an earlier launch and cannot be shown again.
            </div>
          )}
          {info.agentId && (
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void handleRotate()}
                disabled={rotating}
                className="mono"
                style={{
                  background: "transparent",
                  border: "1px solid var(--hairline)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-info)",
                  fontSize: "var(--text-xs)",
                  padding: "4px 10px",
                  cursor: rotating ? "default" : "pointer",
                  opacity: rotating ? 0.6 : 1,
                }}
              >
                {rotating ? "Rotating…" : "Rotate webhook secret"}
              </button>
              <button
                type="button"
                onClick={() => void handleRevoke()}
                disabled={revoking}
                className="mono"
                style={{
                  background: "transparent",
                  border: "1px solid var(--hairline)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-muted)",
                  fontSize: "var(--text-xs)",
                  padding: "4px 10px",
                  cursor: revoking ? "default" : "pointer",
                  opacity: revoking ? 0.6 : 1,
                }}
              >
                {revoking ? "Disabling…" : "Disable inbound webhooks"}
              </button>
            </div>
          )}
          {rotateError && (
            <div
              className="mono"
              style={{
                marginTop: 6,
                fontSize: "var(--text-xs)",
                color: "var(--rights-red)",
              }}
            >
              {rotateError}
            </div>
          )}
        </div>
      )}
      <WorkspaceKeyCallout variant="studio" />
    </div>
  );
}
