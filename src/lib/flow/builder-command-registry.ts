export const BUILDER_COMMAND_IDS = [
  "history.undo",
  "history.redo",
  "selection.copy",
  "selection.paste",
  "selection.duplicate",
  "selection.delete",
  "selection.align-left",
  "selection.align-center-x",
  "selection.align-right",
  "selection.align-top",
  "selection.align-center-y",
  "selection.align-bottom",
  "selection.distribute-x",
  "selection.distribute-y",
  "graph.auto-layout",
  "palette.open",
] as const;

export type BuilderCommandId = (typeof BUILDER_COMMAND_IDS)[number];

export interface BuilderCommandContext {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canPaste: boolean;
  readonly selectedNodeIds: readonly string[];
  readonly selectedEdgeIds: readonly string[];
  readonly boundedNodeIds: readonly string[];
  readonly graphNodeCount: number;
}

export interface BuilderCommandState {
  readonly id: BuilderCommandId;
  readonly label: string;
  readonly description: string;
  readonly shortcutTokens: readonly string[];
  readonly shortcutLabel: string;
  readonly enabled: boolean;
  readonly reason: string | null;
}

export interface BuilderShortcutInput {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}

interface RegistryEntry {
  readonly id: BuilderCommandId;
  readonly label: string;
  readonly description: string;
  readonly shortcutTokens: readonly string[];
  readonly shortcutLabel: string;
  readonly unavailable: (context: BuilderCommandContext) => string | null;
}

const always = (): null => null;
const needsUndo = (context: BuilderCommandContext): string | null => context.canUndo ? null : "Nothing to undo.";
const needsRedo = (context: BuilderCommandContext): string | null => context.canRedo ? null : "Nothing to redo.";
const needsNodes = (context: BuilderCommandContext): string | null => context.selectedNodeIds.length > 0 ? null : "Select at least one node.";
const needsSelection = (context: BuilderCommandContext): string | null =>
  context.selectedNodeIds.length + context.selectedEdgeIds.length > 0 ? null : "Select at least one node or edge.";
const needsPaste = (context: BuilderCommandContext): string | null => context.canPaste ? null : "Clipboard does not contain a graph fragment yet.";
const needsLayout = (context: BuilderCommandContext): string | null => context.graphNodeCount > 0 ? null : "Add at least one node.";
const geometry = (minimum: 2 | 3) => (context: BuilderCommandContext): string | null => {
  if (context.selectedNodeIds.length < minimum) {
    return minimum === 2 ? "Select at least two nodes." : "Select at least three nodes.";
  }
  const bounded = new Set(context.boundedNodeIds);
  return context.selectedNodeIds.every((id) => bounded.has(id))
    ? null
    : "Wait for selected node sizes to be measured.";
};

const REGISTRY: readonly RegistryEntry[] = [
  { id: "history.undo", label: "Undo", description: "Undo the last graph edit.", shortcutTokens: ["Mod", "Z"], shortcutLabel: "⌘/Ctrl+Z", unavailable: needsUndo },
  { id: "history.redo", label: "Redo", description: "Redo the last undone graph edit.", shortcutTokens: ["Mod", "Shift", "Z"], shortcutLabel: "⌘/Ctrl+Shift+Z", unavailable: needsRedo },
  { id: "selection.copy", label: "Copy", description: "Copy selected nodes without credential values.", shortcutTokens: ["Mod", "C"], shortcutLabel: "⌘/Ctrl+C", unavailable: needsNodes },
  { id: "selection.paste", label: "Paste", description: "Paste a safe graph fragment.", shortcutTokens: ["Mod", "V"], shortcutLabel: "⌘/Ctrl+V", unavailable: needsPaste },
  { id: "selection.duplicate", label: "Duplicate", description: "Duplicate selected nodes and internal connections.", shortcutTokens: ["Mod", "D"], shortcutLabel: "⌘/Ctrl+D", unavailable: needsNodes },
  { id: "selection.delete", label: "Delete", description: "Delete selected nodes and edges.", shortcutTokens: ["Delete"], shortcutLabel: "Delete / Backspace", unavailable: needsSelection },
  { id: "selection.align-left", label: "Align left", description: "Align selected nodes by their left edges.", shortcutTokens: [], shortcutLabel: "", unavailable: geometry(2) },
  { id: "selection.align-center-x", label: "Align horizontal centers", description: "Align selected node centers horizontally.", shortcutTokens: [], shortcutLabel: "", unavailable: geometry(2) },
  { id: "selection.align-right", label: "Align right", description: "Align selected nodes by their right edges.", shortcutTokens: [], shortcutLabel: "", unavailable: geometry(2) },
  { id: "selection.align-top", label: "Align top", description: "Align selected nodes by their top edges.", shortcutTokens: [], shortcutLabel: "", unavailable: geometry(2) },
  { id: "selection.align-center-y", label: "Align vertical centers", description: "Align selected node centers vertically.", shortcutTokens: [], shortcutLabel: "", unavailable: geometry(2) },
  { id: "selection.align-bottom", label: "Align bottom", description: "Align selected nodes by their bottom edges.", shortcutTokens: [], shortcutLabel: "", unavailable: geometry(2) },
  { id: "selection.distribute-x", label: "Distribute horizontally", description: "Space selected nodes evenly from left to right.", shortcutTokens: [], shortcutLabel: "", unavailable: geometry(3) },
  { id: "selection.distribute-y", label: "Distribute vertically", description: "Space selected nodes evenly from top to bottom.", shortcutTokens: [], shortcutLabel: "", unavailable: geometry(3) },
  { id: "graph.auto-layout", label: "Auto-layout", description: "Arrange the graph deterministically.", shortcutTokens: ["Mod", "Shift", "L"], shortcutLabel: "⌘/Ctrl+Shift+L", unavailable: needsLayout },
  { id: "palette.open", label: "Commands", description: "Search all graph commands.", shortcutTokens: ["Mod", "K"], shortcutLabel: "⌘/Ctrl+K", unavailable: always },
];

const BY_ID = new Map(REGISTRY.map((entry) => [entry.id, entry]));

export function commandState(id: BuilderCommandId, context: BuilderCommandContext): BuilderCommandState {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error("Unknown builder command");
  const reason = entry.unavailable(context);
  return { ...entry, enabled: reason === null, reason };
}

export function builderCommandStates(context: BuilderCommandContext): readonly BuilderCommandState[] {
  return BUILDER_COMMAND_IDS.map((id) => commandState(id, context));
}

export function commandForShortcut(input: BuilderShortcutInput): BuilderCommandId | null {
  const key = input.key.toLowerCase();
  const modifier = input.metaKey || input.ctrlKey;
  if (modifier && key === "z") return input.shiftKey ? "history.redo" : "history.undo";
  if (input.ctrlKey && key === "y") return "history.redo";
  if (modifier && key === "c") return "selection.copy";
  if (modifier && key === "v") return "selection.paste";
  if (modifier && key === "d") return "selection.duplicate";
  if (modifier && key === "k") return "palette.open";
  if (modifier && input.shiftKey && key === "l") return "graph.auto-layout";
  if (input.key === "Delete" || input.key === "Backspace") return "selection.delete";
  return null;
}

export function commandForSelectionDuplicate(
  graph: SupportedFlowGraph,
  selection: GraphSelection,
  commandId: string,
): Extract<GraphCommand, { kind: "selection.duplicate" }> {
  const nodeIds = [...selection.nodeIds].sort();
  const selected = new Set(nodeIds);
  const internalEdges = graph.edges
    .filter((edge) => selected.has(edge.source) && selected.has(edge.target))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {
    v: 1,
    id: commandId,
    kind: "selection.duplicate",
    nodeIds,
    offset: { x: 40, y: 40 },
    nodeIdMap: Object.fromEntries(nodeIds.map((nodeId, index) => [nodeId, `node_${commandId}_${index}`])),
    edgeIdMap: Object.fromEntries(internalEdges.map((edge, index) => [edge.id, `edge_${commandId}_${index}`])),
  };
}

export function commandForSelectionDelete(
  graph: SupportedFlowGraph,
  selection: GraphSelection,
  commandId: string,
): Extract<GraphCommand, { kind: "graph.batch" }> {
  const nodeIds = [...selection.nodeIds].sort();
  const edgeIds = new Set(selection.edgeIds);
  const selectedNodes = new Set(nodeIds);
  const explicitEdges = graph.edges
    .filter((edge) => edgeIds.has(edge.id) && !selectedNodes.has(edge.source) && !selectedNodes.has(edge.target))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {
    v: 1,
    id: commandId,
    kind: "graph.batch",
    commands: [
      ...explicitEdges.map((edge, index) => ({ v: 1 as const, id: `${commandId}:edge:${index}`, kind: "edge.remove" as const, edgeId: edge.id })),
      ...nodeIds.map((nodeId, index) => ({ v: 1 as const, id: `${commandId}:node:${index}`, kind: "node.remove" as const, nodeId })),
    ],
  };
}
import type { GraphCommand, GraphSelection } from "./graph-command-types";
import type { SupportedFlowGraph } from "./types";
