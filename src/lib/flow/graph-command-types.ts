import type {
  FlowEdge,
  FlowEdgeV2,
  FlowCallableInterface,
  FlowNode,
  FlowNodeV2,
  FlowVariable,
  SupportedFlowGraph,
  SubflowReference,
  ValueBinding,
} from "./types";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonPatchOp =
  | { readonly op: "add" | "replace"; readonly path: string; readonly value: JsonValue }
  | { readonly op: "remove"; readonly path: string };

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface NodeBounds extends Point {
  readonly width: number;
  readonly height: number;
}

export interface GraphSelection {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly primaryNodeId: string | null;
}

export type GraphCommand =
  | { readonly v: 1; readonly id: string; readonly kind: "node.add"; readonly node: FlowNode | FlowNodeV2; readonly index?: number }
  | { readonly v: 1; readonly id: string; readonly kind: "node.remove"; readonly nodeId: string }
  | { readonly v: 1; readonly id: string; readonly kind: "node.patch"; readonly nodeId: string; readonly patch: readonly JsonPatchOp[] }
  | { readonly v: 1; readonly id: string; readonly kind: "edge.add"; readonly edge: FlowEdge | FlowEdgeV2; readonly index?: number }
  | { readonly v: 1; readonly id: string; readonly kind: "edge.remove"; readonly edgeId: string }
  | { readonly v: 1; readonly id: string; readonly kind: "selection.move"; readonly positions: Readonly<Record<string, Point>> }
  | {
      readonly v: 1;
      readonly id: string;
      readonly kind: "selection.duplicate";
      readonly nodeIds: readonly string[];
      readonly offset: Point;
      readonly nodeIdMap: Readonly<Record<string, string>>;
      readonly edgeIdMap: Readonly<Record<string, string>>;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly kind: "selection.align";
      readonly nodeIds: readonly string[];
      readonly bounds: Readonly<Record<string, NodeBounds>>;
      readonly axis: "x" | "y";
      readonly mode: "start" | "center" | "end";
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly kind: "selection.distribute";
      readonly nodeIds: readonly string[];
      readonly bounds: Readonly<Record<string, NodeBounds>>;
      readonly axis: "x" | "y";
    }
  | { readonly v: 1; readonly id: string; readonly kind: "layout.apply"; readonly positions: Readonly<Record<string, Point>> }
  | { readonly v: 1; readonly id: string; readonly kind: "graph.rename"; readonly name: string }
  | { readonly v: 1; readonly id: string; readonly kind: "callable-interface.set"; readonly interface: FlowCallableInterface }
  | { readonly v: 1; readonly id: string; readonly kind: "callable-interface.remove" }
  | { readonly v: 1; readonly id: string; readonly kind: "subflow-reference.set"; readonly nodeId: string; readonly reference: SubflowReference }
  | { readonly v: 1; readonly id: string; readonly kind: "variable.add"; readonly variable: FlowVariable; readonly index?: number }
  | { readonly v: 1; readonly id: string; readonly kind: "variable.patch"; readonly variableId: string; readonly patch: readonly JsonPatchOp[] }
  | { readonly v: 1; readonly id: string; readonly kind: "variable.remove"; readonly variableId: string }
  | { readonly v: 1; readonly id: string; readonly kind: "binding.set"; readonly nodeId: string; readonly key: string; readonly binding: ValueBinding }
  | { readonly v: 1; readonly id: string; readonly kind: "binding.remove"; readonly nodeId: string; readonly key: string }
  | { readonly v: 1; readonly id: string; readonly kind: "graph.batch"; readonly commands: readonly GraphCommand[] }
  | { readonly v: 1; readonly id: string; readonly kind: "graph.replace"; readonly graph: SupportedFlowGraph };

export interface CommandResult {
  readonly graph: SupportedFlowGraph;
  readonly inverse: GraphCommand;
  readonly affectedIds: readonly string[];
}

export class GraphCommandError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GraphCommandError";
  }
}
