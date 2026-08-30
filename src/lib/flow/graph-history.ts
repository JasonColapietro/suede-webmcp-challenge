import { applyGraphCommand } from "./graph-command-reducer";
import type { GraphCommand } from "./graph-command-types";
import type { SupportedFlowGraph } from "./types";

export interface GraphHistoryEntry {
  readonly forward: GraphCommand;
  readonly inverse: GraphCommand;
  readonly affectedIds: readonly string[];
  readonly label: string;
  readonly groupId?: string;
}

export interface GraphHistoryState {
  readonly graph: SupportedFlowGraph;
  readonly past: readonly GraphHistoryEntry[];
  readonly future: readonly GraphHistoryEntry[];
  readonly limit: number;
}

export interface GraphHistoryOptions {
  readonly limit?: number;
}

export interface GraphDispatchOptions {
  readonly label?: string;
  readonly groupId?: string;
}

const DEFAULT_HISTORY_LIMIT = 100;

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Graph history limit must be a positive safe integer");
  }
}

export function createGraphHistory(
  graph: SupportedFlowGraph,
  options: GraphHistoryOptions = {},
): GraphHistoryState {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  assertLimit(limit);
  return { graph, past: [], future: [], limit };
}

export function dispatchGraphCommand(
  state: GraphHistoryState,
  command: GraphCommand,
  options: GraphDispatchOptions = {},
): GraphHistoryState {
  const result = applyGraphCommand(state.graph, command);
  const entry: GraphHistoryEntry = {
    forward: command,
    inverse: result.inverse,
    affectedIds: result.affectedIds,
    label: options.label ?? command.kind,
    ...(options.groupId === undefined ? {} : { groupId: options.groupId }),
  };
  const previous = state.past.at(-1);
  const past = options.groupId && previous?.groupId === options.groupId
    ? [...state.past.slice(0, -1), { ...entry, inverse: previous.inverse }]
    : [...state.past, entry].slice(-state.limit);
  return { ...state, graph: result.graph, past, future: [] };
}

export function undoGraphCommand(state: GraphHistoryState): GraphHistoryState {
  const entry = state.past.at(-1);
  if (!entry) return state;
  const result = applyGraphCommand(state.graph, entry.inverse);
  return {
    ...state,
    graph: result.graph,
    past: state.past.slice(0, -1),
    future: [entry, ...state.future],
  };
}

export function redoGraphCommand(state: GraphHistoryState): GraphHistoryState {
  const entry = state.future[0];
  if (!entry) return state;
  const result = applyGraphCommand(state.graph, entry.forward);
  return {
    ...state,
    graph: result.graph,
    past: [...state.past, entry].slice(-state.limit),
    future: state.future.slice(1),
  };
}

export function resetGraphHistory(
  state: GraphHistoryState,
  graph: SupportedFlowGraph = state.graph,
): GraphHistoryState {
  return { ...state, graph, past: [], future: [] };
}
