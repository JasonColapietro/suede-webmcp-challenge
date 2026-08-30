"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlowProvider,
  MarkerType,
  SelectionMode,
  SmoothStepEdge,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas-theme.css";
import type {
  GraphCommand,
  GraphSelection,
  NodeBounds,
  Point,
} from "@/lib/flow/graph-command-types";
import {
  validateTypedConnection,
  type PortCompatibilityVerdict,
  type TypedConnectionCandidate,
} from "@/lib/flow/port-compatibility";
import type {
  FlowEdge,
  FlowEdgeV2,
  FlowNode,
  FlowNodeV2,
  NodeType,
  SupportedFlowGraph,
} from "@/lib/flow/types";
import { getNodeDefinition, NODE_TYPE_SET } from "@/lib/flow/node-definitions";
import {
  createAuthoringNodePortResolver,
  resolveNodePorts,
  type ResolvedNodePorts,
  type ValidatedNodePortResolver,
} from "@/lib/flow/node-ports";
import type { CanvasViewport } from "@/lib/studio/first-save-session-handoff";
import SuedeNode, {
  suedeNodeStatusLabel,
  type SuedeRfNode,
  type SuedeNodeData,
  type SuedeNodeStatus,
} from "./SuedeNode";

export interface FlowCanvasProps {
  graph: SupportedFlowGraph;
  /** Exact resolver for this graph snapshot. Dynamic nodes must never fall back to static ports. */
  resolvePorts?: ValidatedNodePortResolver;
  selection: GraphSelection;
  onCommand: (command: GraphCommand) => void;
  onSelectionChange: (
    selection: GraphSelection,
    measuredBounds: Readonly<Record<string, NodeBounds>>,
  ) => void;
  onMeasuredBoundsChange: (bounds: Readonly<Record<string, NodeBounds>>) => void;
  focusRequest?: number;
  focusNodeRequest?: { readonly nodeId: string; readonly token: number };
  statuses?: Record<string, SuedeNodeStatus>;
  /** Routes canvas feedback through the builder's persistent live region. */
  onAnnounce?: (message: string) => void;
  /** One-use viewport restored after the `/build/new` first-save remount. */
  initialViewport?: CanvasViewport;
  /** Publishes the latest settled viewport for the first-save handoff. */
  onViewportChange?: (viewport: CanvasViewport) => void;
}

export interface PositionedNodeLike {
  readonly id: string;
  readonly position: Point;
  readonly measured?: { readonly width?: number; readonly height?: number };
}

const DRAG_MIME = "application/suede-node-type";
const NODE_TYPES: NodeTypes = { suede: SuedeNode };

/** Shared fit for the init-time fitView prop and the async first-load fit:
    breathing room around the graph, and never zoomed past 100% — a loaded
    template should read whole, not blow four nodes up to fill the screen. */
const LOAD_FIT_OPTIONS = { padding: 0.18, maxZoom: 1 } as const;

/** Smoothstep wire with rounded elbows matching the landing org-chart vocabulary. */
function SuedeWire(props: EdgeProps): React.JSX.Element {
  return <SmoothStepEdge {...props} pathOptions={{ borderRadius: 14 }} />;
}
const EDGE_TYPES: EdgeTypes = { suede: SuedeWire };

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function compareNodeIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function normalizeGraphSelection(
  nodeIds: readonly string[],
  edgeIds: readonly string[],
  preferredPrimary: string | null = null,
): GraphSelection {
  const nodes = sortedUnique(nodeIds);
  const edges = sortedUnique(edgeIds);
  return {
    nodeIds: nodes,
    edgeIds: edges,
    primaryNodeId: preferredPrimary && nodes.includes(preferredPrimary)
      ? preferredPrimary
      : (nodes[0] ?? null),
  };
}

export function graphSelectionsEqual(left: GraphSelection, right: GraphSelection): boolean {
  return left.primaryNodeId === right.primaryNodeId &&
    left.nodeIds.length === right.nodeIds.length &&
    left.edgeIds.length === right.edgeIds.length &&
    left.nodeIds.every((id, index) => id === right.nodeIds[index]) &&
    left.edgeIds.every((id, index) => id === right.edgeIds[index]);
}

export function nodeBoundsRecordsEqual(
  left: Readonly<Record<string, NodeBounds>>,
  right: Readonly<Record<string, NodeBounds>>,
): boolean {
  const leftIds = Object.keys(left).sort();
  const rightIds = Object.keys(right).sort();
  return leftIds.length === rightIds.length && leftIds.every((id, index) => {
    if (id !== rightIds[index]) return false;
    const a = left[id];
    const b = right[id];
    return Boolean(a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
  });
}

export function pruneGraphSelection(
  selection: GraphSelection,
  graph: SupportedFlowGraph,
): GraphSelection {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  return normalizeGraphSelection(
    selection.nodeIds.filter((id) => nodeIds.has(id)),
    selection.edgeIds.filter((id) => edgeIds.has(id)),
    selection.primaryNodeId,
  );
}

export function resolveFocusNodeId(
  graph: SupportedFlowGraph,
  request: FlowCanvasProps["focusNodeRequest"],
): string | null {
  return request && graph.nodes.some(({ id }) => id === request.nodeId) ? request.nodeId : null;
}

export function retryExactNodeFocus<T extends { readonly id: string }>(input: {
  readonly nodeId: string;
  readonly getNode: (nodeId: string) => T | null | undefined;
  readonly focus: () => void;
  readonly fit: (node: T) => void;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly maxFrames?: number;
  readonly onSuccess?: () => void;
}): () => void {
  let cancelled = false;
  let handle = 0;
  let attempts = 0;
  const maxFrames = input.maxFrames ?? 12;
  const step: FrameRequestCallback = () => {
    if (cancelled) return;
    attempts += 1;
    const node = input.getNode(input.nodeId);
    if (node) {
      input.focus();
      input.fit(node);
      input.onSuccess?.();
      return;
    }
    if (attempts < maxFrames) handle = input.requestFrame(step);
  };
  handle = input.requestFrame(step);
  return () => {
    cancelled = true;
    if (handle) input.cancelFrame(handle);
  };
}

/**
 * Retry-until-measured fit for the first non-empty graph: templates and
 * persisted flows arrive async, after ReactFlow already initialized on an
 * empty graph, so the built-in `fitView` prop (init-time only) never runs on
 * them and the nodes rendered un-fitted in a corner. Waits up to `maxFrames`
 * for every node to report measured bounds so the fit uses real card sizes,
 * then fits best-effort with whatever exists.
 */
export function retryFitAllNodes(input: {
  readonly nodeIds: readonly string[];
  readonly getNode: (
    nodeId: string,
  ) => { readonly measured?: { readonly width?: number; readonly height?: number } } | null | undefined;
  readonly fit: () => void;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly maxFrames?: number;
}): () => void {
  let cancelled = false;
  let handle = 0;
  let attempts = 0;
  const maxFrames = input.maxFrames ?? 24;
  const step: FrameRequestCallback = () => {
    if (cancelled) return;
    attempts += 1;
    const allMeasured = input.nodeIds.every((id) => {
      const width = input.getNode(id)?.measured?.width;
      return typeof width === "number" && width > 0;
    });
    if (allMeasured || attempts >= maxFrames) {
      input.fit();
      return;
    }
    handle = input.requestFrame(step);
  };
  handle = input.requestFrame(step);
  return () => {
    cancelled = true;
    if (handle) input.cancelFrame(handle);
  };
}

export function selectionForNodeClick(
  current: GraphSelection,
  nodeId: string,
  modifier: boolean,
): GraphSelection {
  if (!modifier) return normalizeGraphSelection([nodeId], [], nodeId);
  const alreadySelected = current.nodeIds.includes(nodeId);
  const nodeIds = alreadySelected
    ? current.nodeIds.filter((id) => id !== nodeId)
    : [...current.nodeIds, nodeId];
  return normalizeGraphSelection(
    nodeIds,
    current.edgeIds,
    alreadySelected ? current.primaryNodeId : nodeId,
  );
}

export function selectionForEdgeClick(
  current: GraphSelection,
  edgeId: string,
  modifier: boolean,
): GraphSelection {
  if (!modifier) return normalizeGraphSelection([], [edgeId], null);
  const alreadySelected = current.edgeIds.includes(edgeId);
  const edgeIds = alreadySelected
    ? current.edgeIds.filter((id) => id !== edgeId)
    : [...current.edgeIds, edgeId];
  return normalizeGraphSelection(current.nodeIds, edgeIds, current.primaryNodeId);
}

function createdNodeIds(command: GraphCommand): string[] {
  if (command.kind === "node.add") return [command.node.id];
  if (command.kind === "selection.duplicate") return Object.values(command.nodeIdMap);
  if (command.kind === "graph.batch") return command.commands.flatMap(createdNodeIds);
  return [];
}

export function selectionAfterCommand(
  current: GraphSelection,
  graph: SupportedFlowGraph,
  command: GraphCommand,
): GraphSelection {
  const created = sortedUnique(createdNodeIds(command));
  return created.length > 0
    ? normalizeGraphSelection(created, [], created[0] ?? null)
    : pruneGraphSelection(current, graph);
}

export function commandRequestsCanvasFocus(command: GraphCommand): boolean {
  if (command.kind === "node.remove" || command.kind === "edge.remove") return true;
  return command.kind === "graph.batch" && command.commands.some(commandRequestsCanvasFocus);
}

export function measuredBoundsForNodes(
  nodes: readonly PositionedNodeLike[],
): Readonly<Record<string, NodeBounds>> {
  const bounds: Record<string, NodeBounds> = {};
  for (const node of [...nodes].sort(compareNodeIds)) {
    const width = node.measured?.width;
    const height = node.measured?.height;
    if (
      Number.isFinite(node.position.x) && Number.isFinite(node.position.y) &&
      typeof width === "number" && Number.isFinite(width) && width >= 0 &&
      typeof height === "number" && Number.isFinite(height) && height >= 0
    ) {
      bounds[node.id] = { x: node.position.x, y: node.position.y, width, height };
    }
  }
  return bounds;
}

/**
 * Geometry commands need the canvas measurements for width and height, but
 * positions from the current graph. Selection measurements are published only
 * when selection changes, so their x/y values can lag a drag, undo, layout, or
 * paste nudge and otherwise snap nodes back to an earlier position.
 */
export function liveSelectionBounds(
  graph: SupportedFlowGraph,
  nodeIds: readonly string[],
  measuredBounds: Readonly<Record<string, NodeBounds>>,
): Readonly<Record<string, NodeBounds>> {
  const positions = new Map(graph.nodes.map((node) => [node.id, node.position]));
  const bounds: Record<string, NodeBounds> = {};
  for (const nodeId of nodeIds) {
    const measured = measuredBounds[nodeId];
    const position = positions.get(nodeId);
    if (!measured || !position) continue;
    bounds[nodeId] = { ...measured, x: position.x, y: position.y };
  }
  return bounds;
}

export function commandForConnection(
  connection: Pick<Connection, "source" | "target" | "sourceHandle" | "targetHandle">,
  commandId: string,
  edgeId: string,
): Extract<GraphCommand, { kind: "edge.add" }>;
export function commandForConnection(
  graph: SupportedFlowGraph,
  connection: Pick<Connection, "source" | "target" | "sourceHandle" | "targetHandle">,
  commandId: string,
  edgeId: string,
): Extract<GraphCommand, { kind: "edge.add" }>;
export function commandForConnection(
  graphOrConnection: SupportedFlowGraph | Pick<Connection, "source" | "target" | "sourceHandle" | "targetHandle">,
  connectionOrCommandId: Pick<Connection, "source" | "target" | "sourceHandle" | "targetHandle"> | string,
  commandIdOrEdgeId: string,
  maybeEdgeId?: string,
): Extract<GraphCommand, { kind: "edge.add" }> {
  const hasGraph = "nodes" in graphOrConnection;
  const graph = hasGraph ? graphOrConnection : null;
  const connection = (hasGraph ? connectionOrCommandId : graphOrConnection) as Pick<
    Connection,
    "source" | "target" | "sourceHandle" | "targetHandle"
  >;
  const commandId = hasGraph ? commandIdOrEdgeId : connectionOrCommandId as string;
  const edgeId = hasGraph ? maybeEdgeId : commandIdOrEdgeId;
  if (!edgeId) throw new Error("Connection edge ID is required");
  if (!connection.source || !connection.target) throw new Error("Connection endpoints are required");
  if (graph && "schemaVersion" in graph && graph.schemaVersion === 2) {
    if (!connection.sourceHandle || !connection.targetHandle) {
      throw new Error("Typed connections require both source and target handles");
    }
  }
  const edge: FlowEdge = { id: edgeId, source: connection.source, target: connection.target };
  if (connection.sourceHandle) edge.sourceHandle = connection.sourceHandle;
  if (connection.targetHandle) edge.targetHandle = connection.targetHandle;
  return { v: 1, id: commandId, kind: "edge.add", edge };
}

export function verdictForCanvasConnection(
  graph: SupportedFlowGraph,
  connection: TypedConnectionCandidate,
  resolvePorts?: ValidatedNodePortResolver,
): PortCompatibilityVerdict {
  return validateTypedConnection(graph, connection, undefined, resolvePorts);
}

export function decideCanvasConnectionForRenderedGraph(
  graph: SupportedFlowGraph,
  resolvePorts: ValidatedNodePortResolver,
  connection: Connection,
  commandId: string,
  edgeId: string,
): {
  readonly verdict: PortCompatibilityVerdict;
  readonly command: Extract<GraphCommand, { kind: "edge.add" }> | null;
} {
  const verdict = verdictForCanvasConnection(graph, connection, resolvePorts);
  // The reducer currently refuses every repeated target handle, including a
  // port whose runtime cardinality is "many". Stop the gesture here with an
  // honest reason instead of issuing a command that vanishes in the reducer.
  if (verdict.status !== "incompatible" && connection.target && connection.targetHandle) {
    const occupied = graph.edges.some(
      (edge) => edge.target === connection.target &&
        (edge.targetHandle ?? null) === connection.targetHandle,
    );
    if (occupied) {
      return {
        verdict: {
          status: "incompatible",
          message: `Target port "${connection.target}.${connection.targetHandle}" already has an incoming edge. Combining several inputs into one port is not supported yet.`,
        },
        command: null,
      };
    }
  }
  return {
    verdict,
    command: verdict.status === "incompatible"
      ? null
      : commandForConnection(graph, connection, commandId, edgeId),
  };
}

/** Validate an already-authored edge without letting it collide with itself. */
export function verdictForSavedCanvasEdge(
  graph: SupportedFlowGraph,
  edge: FlowEdge | FlowEdgeV2,
  resolvePorts?: ValidatedNodePortResolver,
): PortCompatibilityVerdict {
  const connection = {
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
  };
  if ("schemaVersion" in graph) {
    return verdictForCanvasConnection(
      { ...graph, edges: graph.edges.filter((candidate) => candidate.id !== edge.id) },
      connection,
      resolvePorts,
    );
  }
  return verdictForCanvasConnection(
    { ...graph, edges: graph.edges.filter((candidate) => candidate.id !== edge.id) },
    connection,
    resolvePorts,
  );
}

export function commandForNodeDrop(
  type: NodeType,
  position: Point,
  commandId: string,
  nodeId: string,
): Extract<GraphCommand, { kind: "node.add" }> | null {
  if (type === "api.operation") return null;
  return {
    v: 1,
    id: commandId,
    kind: "node.add",
    node: { id: nodeId, type, params: {}, position: { x: position.x, y: position.y } },
  };
}

export function commandForDragCompletion(
  graph: SupportedFlowGraph,
  movedNodes: readonly Pick<PositionedNodeLike, "id" | "position">[],
  commandId: string,
): Extract<GraphCommand, { kind: "selection.move" }> | null {
  const current = new Map(graph.nodes.map((node) => [node.id, node.position]));
  const positions: Record<string, Point> = {};
  for (const node of [...movedNodes].sort(compareNodeIds)) {
    const before = current.get(node.id);
    if (!before || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) continue;
    if (before.x !== node.position.x || before.y !== node.position.y) {
      positions[node.id] = { x: node.position.x, y: node.position.y };
    }
  }
  return Object.keys(positions).length > 0
    ? { v: 1, id: commandId, kind: "selection.move", positions }
    : null;
}

function genId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}`;
}

function labelFor(type: NodeType): string {
  return getNodeDefinition(type).label;
}

function priceFor(type: NodeType): number | undefined {
  const cost = getNodeDefinition(type).cost;
  return cost.kind === "estimated" ? cost.amount : undefined;
}

export function resolveCanvasNodePorts(
  graph: SupportedFlowGraph,
  node: FlowNode | FlowNodeV2,
  resolvePorts?: ValidatedNodePortResolver,
): ResolvedNodePorts {
  return resolvePorts ? resolvePorts(node) : resolveNodePorts(graph, node);
}

export function createCanvasNodePortResolver(
  graph: SupportedFlowGraph,
  resolvePorts?: ValidatedNodePortResolver,
): ValidatedNodePortResolver {
  return resolvePorts ?? createAuthoringNodePortResolver(graph);
}

function stableSchemaBytes(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(stableSchemaBytes).join(",")}]`;
  if (typeof value !== "object") return "null";
  const source = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(source).sort().map((key) =>
    `${JSON.stringify(key.normalize("NFC"))}:${stableSchemaBytes(source[key])}`).join(",")}}`;
}

function portSignature(ports: ResolvedNodePorts): string {
  const signature = (port: ResolvedNodePorts["inputPorts"][number]): string =>
    stableSchemaBytes([port.id, port.label, port.required, port.cardinality, port.schema]);
  return `${ports.inputPorts.map(signature).join("\u0000")}\u0001${ports.outputPorts.map(signature).join("\u0000")}`;
}

export function canvasNodePortSignature(
  graph: SupportedFlowGraph,
  node: FlowNode | FlowNodeV2,
  resolvePorts?: ValidatedNodePortResolver,
): string {
  return portSignature(resolveCanvasNodePorts(graph, node, resolvePorts));
}

function toRfNode(
  resolvePorts: ValidatedNodePortResolver,
  node: FlowNode | FlowNodeV2,
  graphVersion: 1 | 2,
  status: SuedeNodeStatus | undefined,
  selected: boolean,
  draftPosition?: Point,
): SuedeRfNode {
  const ports = resolvePorts(node);
  const label = labelFor(node.type);
  const data: SuedeNodeData = {
    nodeType: node.type,
    label,
    priceUsdc: priceFor(node.type),
    status,
    graphVersion,
    inputPorts: ports.inputPorts,
    outputPorts: ports.outputPorts,
  };
  return {
    id: node.id,
    type: "suede",
    position: draftPosition ?? node.position,
    selected,
    ariaLabel: `${label} node, ${suedeNodeStatusLabel(status)}${selected ? ", selected" : ""}`,
    data,
  };
}

function toRfEdge(
  graph: SupportedFlowGraph,
  edge: FlowEdge | FlowEdgeV2,
  selected: boolean,
  resolvePorts: ValidatedNodePortResolver,
  sourceRunning: boolean,
): Edge {
  const verdict = "schemaVersion" in graph
    ? verdictForSavedCanvasEdge(graph, edge, resolvePorts)
    : null;
  const isUntyped = verdict?.status === "untyped";
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    selected,
    /* Rounded elbows match the org-chart wire vocabulary on the landing page;
       the marching-dash animation runs only while the source node executes. */
    type: "suede",
    animated: sourceRunning,
    label: isUntyped ? "Unknown schema" : undefined,
    ariaLabel: isUntyped ? `Unknown schema connection. ${verdict.message}` : undefined,
    style: selected
      ? { stroke: "var(--primary)", strokeWidth: 3 }
      : isUntyped
        ? { stroke: "var(--warning-amber)", strokeWidth: 2, strokeDasharray: "5 4" }
        : { stroke: "var(--edge-stroke)", strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--primary)" },
  };
}

function FlowCanvasInner({
  graph,
  resolvePorts,
  selection,
  onCommand,
  onSelectionChange,
  onMeasuredBoundsChange,
  onAnnounce,
  focusRequest = 0,
  focusNodeRequest,
  statuses,
  initialViewport,
  onViewportChange,
}: FlowCanvasProps): React.JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<string | null>(selection.primaryNodeId);
  const publishedSelectionRef = useRef<GraphSelection>(selection);
  const modifierSelectionRef = useRef<GraphSelection | null>(null);
  const graphRef = useRef(graph);
  const rf = useReactFlow<SuedeRfNode, Edge>();
  const updateNodeInternals = useUpdateNodeInternals();
  const portSignaturesRef = useRef<ReadonlyMap<string, string>>(new Map());
  const handledFocusNodeTokenRef = useRef<number | null>(null);
  const [draftPositions, setDraftPositions] = useState<Record<string, Point>>({});
  /** True while a pointer drag is in flight, so keyboard-move commits stay out of its way. */
  const pointerDragRef = useRef(false);
  const [measuredDims, setMeasuredDims] = useState<Record<string, { width: number; height: number }>>({});
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const connectionErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* One-shot fit for the first non-empty graph (template / persisted flow
     arriving after mount). A restored first-save viewport always wins, and
     any pointer interaction before the load lands cancels the fit so we
     never yank the viewport out from under the user. */
  const loadFitDoneRef = useRef(initialViewport !== undefined);
  const resolveCanvasPorts = useMemo(
    () => createCanvasNodePortResolver(graph, resolvePorts),
    [graph, resolvePorts],
  );

  useEffect(() => {
    graphRef.current = graph;
    setDraftPositions({});
    const next = new Map(graph.nodes.map((node) => {
      return [node.id, canvasNodePortSignature(graph, node, resolveCanvasPorts)];
    }));
    for (const [nodeId, signature] of next) {
      if (portSignaturesRef.current.get(nodeId) !== signature) updateNodeInternals(nodeId);
    }
    portSignaturesRef.current = next;
  }, [graph, resolveCanvasPorts, updateNodeInternals]);
  useEffect(() => {
    primaryRef.current = selection.primaryNodeId;
    publishedSelectionRef.current = selection;
  }, [selection]);
  useEffect(() => () => {
    if (connectionErrorTimer.current) clearTimeout(connectionErrorTimer.current);
  }, []);
  useEffect(() => {
    if (focusRequest > 0) wrapperRef.current?.focus();
  }, [focusRequest]);
  useEffect(() => {
    if (!focusNodeRequest || handledFocusNodeTokenRef.current === focusNodeRequest.token) return;
    const nodeId = resolveFocusNodeId(graph, focusNodeRequest);
    if (!nodeId) return;
    return retryExactNodeFocus({
      nodeId,
      getNode: (id) => rf.getNode(id),
      focus: () => wrapperRef.current?.focus(),
      fit: (exactNode) => {
        // CSS reduced-motion coverage can't reach this JS-driven viewport
        // animation, so honor the preference here with a zero-duration jump.
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        void rf.fitView({ nodes: [exactNode], padding: 0.4, duration: reduceMotion ? 0 : 220 });
      },
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      onSuccess: () => { handledFocusNodeTokenRef.current = focusNodeRequest.token; },
    });
  }, [focusNodeRequest, graph, rf]);

  useEffect(() => {
    if (loadFitDoneRef.current || graph.nodes.length === 0) return;
    loadFitDoneRef.current = true;
    // An exact-node focus request (subflow breadcrumb return) outranks the
    // whole-graph load fit — don't run two competing viewport animations.
    if (focusNodeRequest && handledFocusNodeTokenRef.current !== focusNodeRequest.token) return;
    return retryFitAllNodes({
      nodeIds: graph.nodes.map((node) => node.id),
      getNode: (id) => rf.getNode(id),
      fit: () => { void rf.fitView(LOAD_FIT_OPTIONS); },
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    });
  }, [graph, rf, focusNodeRequest]);

  const showConnectionError = useCallback((message: string) => {
    setConnectionError(message);
    onAnnounce?.(message);
    if (connectionErrorTimer.current) clearTimeout(connectionErrorTimer.current);
    connectionErrorTimer.current = setTimeout(() => setConnectionError(null), 4000);
  }, [onAnnounce]);

  const selectedNodes = useMemo(() => new Set(selection.nodeIds), [selection.nodeIds]);
  const selectedEdges = useMemo(() => new Set(selection.edgeIds), [selection.edgeIds]);
  const rfNodes = useMemo<SuedeRfNode[]>(
    () => graph.nodes.map((node) => {
      const rfNode = toRfNode(
        resolveCanvasPorts,
        node,
        "schemaVersion" in graph ? 2 : 1,
        statuses?.[node.id],
        selectedNodes.has(node.id),
        draftPositions[node.id],
      );
      // The MiniMap reads dimensions from the app-owned node objects, so the
      // measurements collected in onNodesChange must be stamped back on —
      // without them every minimap rect is skipped and the map renders empty.
      const measured = measuredDims[node.id];
      return measured ? { ...rfNode, measured } : rfNode;
    }),
    [graph, resolveCanvasPorts, statuses, selectedNodes, draftPositions, measuredDims],
  );
  const rfEdges = useMemo<Edge[]>(
    () => graph.edges.map((edge) => toRfEdge(
      graph,
      edge,
      selectedEdges.has(edge.id),
      resolveCanvasPorts,
      statuses?.[edge.source] === "running",
    )),
    [graph, resolveCanvasPorts, selectedEdges, statuses],
  );

  const publishSelection = useCallback((next: GraphSelection) => {
    if (graphSelectionsEqual(publishedSelectionRef.current, next)) return;
    publishedSelectionRef.current = next;
    primaryRef.current = next.primaryNodeId;
    const selectedRfNodes = next.nodeIds.flatMap((id): PositionedNodeLike[] => {
      const internal = rf.getInternalNode(id);
      if (!internal) return [];
      return [{
        id,
        position: internal.internals.positionAbsolute,
        measured: internal.measured,
      }];
    });
    const bounds = measuredBoundsForNodes(selectedRfNodes);
    onMeasuredBoundsChange(bounds);
    onSelectionChange(next, bounds);
  }, [onMeasuredBoundsChange, onSelectionChange, rf]);

  const onNodesChange = useCallback((changes: NodeChange<SuedeRfNode>[]) => {
    const selectionChanges = changes.filter(
      (change): change is Extract<NodeChange<SuedeRfNode>, { type: "select" }> => change.type === "select",
    );
    if (selectionChanges.length > 0) {
      const nodeIds = new Set(publishedSelectionRef.current.nodeIds);
      let preferred = publishedSelectionRef.current.primaryNodeId;
      for (const change of selectionChanges) {
        if (change.selected) {
          nodeIds.add(change.id);
          preferred = change.id;
        } else {
          nodeIds.delete(change.id);
        }
      }
      const next = normalizeGraphSelection(
        [...nodeIds],
        publishedSelectionRef.current.edgeIds,
        preferred,
      );
      publishSelection(next);
    }
    const dimensions = changes.filter(
      (change): change is Extract<NodeChange<SuedeRfNode>, { type: "dimensions" }> =>
        change.type === "dimensions" && change.dimensions !== undefined,
    );
    if (dimensions.length > 0) {
      setMeasuredDims((current) => {
        let changed = false;
        const next = { ...current };
        for (const change of dimensions) {
          const dims = change.dimensions;
          if (!dims) continue;
          const prev = next[change.id];
          if (!prev || prev.width !== dims.width || prev.height !== dims.height) {
            next[change.id] = { width: dims.width, height: dims.height };
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }
    const positions = changes.filter(
      (change): change is Extract<NodeChange<SuedeRfNode>, { type: "position" }> =>
        change.type === "position" && change.position !== undefined,
    );
    if (positions.length === 0) return;
    // A pointer drag streams `dragging: true` changes and is committed by
    // onNodeDragStop. A keyboard move (arrow keys on a focused node) emits a
    // single change with no drag lifecycle at all, so staging it into
    // draftPositions meant the node snapped back the next time the graph
    // re-rendered — the move was never committed. Commit those directly.
    // The ref guard matters: xyflow's drag end also emits a non-dragging
    // position change just before onNodeDragStop, which would otherwise
    // commit every mouse drag twice and push two undo entries.
    const keyboardMoves = positions.filter((change) => change.dragging !== true);
    if (keyboardMoves.length > 0 && !pointerDragRef.current) {
      const command = commandForDragCompletion(
        graphRef.current,
        keyboardMoves.map((change) => ({ id: change.id, position: change.position as Point })),
        genId("key-move"),
      );
      if (command) onCommand(command);
      return;
    }
    setDraftPositions((current) => {
      const next = { ...current };
      for (const change of positions) next[change.id] = change.position as Point;
      return next;
    });
  }, [publishSelection, onCommand]);

  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    const selectionChanges = changes.filter(
      (change): change is Extract<EdgeChange<Edge>, { type: "select" }> => change.type === "select",
    );
    if (selectionChanges.length === 0) return;
    const edgeIds = new Set(publishedSelectionRef.current.edgeIds);
    for (const change of selectionChanges) {
      if (change.selected) edgeIds.add(change.id);
      else edgeIds.delete(change.id);
    }
    const next = normalizeGraphSelection(
      publishedSelectionRef.current.nodeIds,
      [...edgeIds],
      publishedSelectionRef.current.primaryNodeId,
    );
    publishSelection(next);
  }, [publishSelection]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const decision = decideCanvasConnectionForRenderedGraph(
      graph,
      resolveCanvasPorts,
      connection,
      genId("connect"),
      genId("edge"),
    );
    if (decision.verdict.status === "incompatible" || !decision.command) {
      showConnectionError(decision.verdict.message);
      return;
    }
    if (decision.verdict.status === "untyped") showConnectionError(decision.verdict.message);
    onCommand(decision.command);
  }, [graph, onCommand, resolveCanvasPorts, showConnectionError]);

  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    // A hand-placed node is exactly where the user dropped it — never refit.
    loadFitDoneRef.current = true;
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!NODE_TYPE_SET.has(raw as NodeType)) return;
    const position = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const command = commandForNodeDrop(raw as NodeType, position, genId("drop"), genId("node"));
    if (command) onCommand(command);
  }, [onCommand, rf]);

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  return (
    <div
      ref={wrapperRef}
      tabIndex={-1}
      aria-label="Flow builder canvas"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onPointerDownCapture={(event) => {
        loadFitDoneRef.current = true;
        modifierSelectionRef.current = event.metaKey || event.ctrlKey || event.shiftKey
          ? publishedSelectionRef.current
          : null;
      }}
      style={{ width: "100%", height: "100%" }}
    >
      <ReactFlow<SuedeRfNode, Edge>
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(event, node) => {
          if (!(event.metaKey || event.ctrlKey || event.shiftKey)) return;
          const before = modifierSelectionRef.current ?? publishedSelectionRef.current;
          modifierSelectionRef.current = null;
          publishSelection(selectionForNodeClick(before, node.id, true));
        }}
        onEdgeClick={(event, edge) => {
          if (!(event.metaKey || event.ctrlKey || event.shiftKey)) return;
          const before = modifierSelectionRef.current ?? publishedSelectionRef.current;
          modifierSelectionRef.current = null;
          publishSelection(selectionForEdgeClick(before, edge.id, true));
        }}
        onConnect={onConnect}
        onPaneClick={() => {
          const next = normalizeGraphSelection([], [], null);
          if (graphSelectionsEqual(publishedSelectionRef.current, next)) return;
          publishedSelectionRef.current = next;
          primaryRef.current = null;
          onMeasuredBoundsChange({});
          onSelectionChange(next, {});
        }}
        onNodeDragStart={() => { pointerDragRef.current = true; }}
        onNodeDragStop={(_, node, movedNodes) => {
          const moved = movedNodes.length > 0 ? movedNodes : [node];
          const command = commandForDragCompletion(graphRef.current, moved, genId("drag"));
          if (command) onCommand(command);
          setDraftPositions({});
          pointerDragRef.current = false;
        }}
        onInit={(instance) => onViewportChange?.(instance.getViewport())}
        onMoveEnd={(_event, viewport: Viewport) => onViewportChange?.(viewport)}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={["Meta", "Control"]}
        selectionOnDrag={false}
        selectionMode={SelectionMode.Partial}
        connectOnClick
        defaultViewport={initialViewport}
        fitView={initialViewport === undefined}
        fitViewOptions={LOAD_FIT_OPTIONS}
        proOptions={{ hideAttribution: true }}
        style={{ background: "var(--canvas-bg)" }}
        defaultEdgeOptions={{
          style: { stroke: "var(--edge-stroke)" },
          markerEnd: { type: MarkerType.ArrowClosed, color: "var(--primary)" },
        }}
      >
        {rfNodes.length === 0 && (
          <Panel position="top-left" className="canvas-empty-state">
            <strong>Add your first node</strong>
            <span>Drag a node from the library onto the canvas to begin.</span>
            <span className="canvas-empty-state__hint">
              Wire nodes by dragging between their port dots.{" "}
              <kbd>⌘/Ctrl+Z</kbd> undoes any step.
            </span>
          </Panel>
        )}
        {connectionError && (
          <div aria-hidden="true" className="canvas-connection-toast">
            <span aria-hidden="true">⚠</span>
            {connectionError}
          </div>
        )}
        <Background color="var(--canvas-dot)" gap={22} size={1} />
        {/* Zoom controls and the minimap have nothing to operate on until a
            node exists, and on short or compact viewports they collide with
            the empty-state onboarding card — so they appear with the first
            node, exactly when the card disappears. */}
        {rfNodes.length > 0 && (
          <Controls
            style={{
              background: "var(--ink-panel)",
              border: "1px solid var(--hairline)",
              borderRadius: "var(--radius)",
            }}
          />
        )}
        {rfNodes.length > 0 && (
          <MiniMap
            pannable
            zoomable
            style={{
              background: "var(--ink-panel)",
              border: "1px solid var(--hairline)",
            }}
            maskColor="color-mix(in srgb, var(--canvas-bg) 70%, transparent)"
            nodeColor="var(--canvas-minimap-node)"
            nodeStrokeColor="var(--primary)"
          />
        )}
      </ReactFlow>
    </div>
  );
}

export default function FlowCanvas(props: FlowCanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
