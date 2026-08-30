/** The FlowGraph contract — the spine every other unit depends on. */
import type { PortSpec } from "./node-definition-types";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonSchema = Readonly<Record<string, JsonValue>>;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type NodeType =
  | "input"
  | "output"
  | "schedule"
  | "webhook"
  | "llm"
  | "ai.classify"
  | "ai.extract"
  | "http"
  | "branch"
  | "transform"
  | "subflow"
  | "loop"
  | "logic.switch"
  | "logic.aggregate"
  | "api.operation"
  | "resource.query"
  | "suede.styleCoach"
  | "suede.lyrics"
  | "suede.generateSong"
  | "suede.analyze"
  | "suede.stems"
  | "suede.midi"
  | "suede.mastering"
  | "suede.rightsLookup"
  | "suede.registerIp"
  | "suede.royaltySplit"
  | "suede.chainChat"
  | "suede.promo"
  | "suede.promoClaims"
  | "docs.extractText"
  | "docs.extractDocx"
  | "docs.knowledgeSearch"
  | "docs.generateReportPdf"
  | "data.parseSpreadsheet"
  | "data.filterRows"
  | "data.generateSpreadsheet"
  | "web.fetchUrl"
  | "comms.slackMessage"
  | "comms.crmWebhook"
  | "devops.githubRead"
  | "devops.githubIssue"
  | "devops.githubWorkflowDispatch"
  | "finance.generateInvoicePdf";

export type FlowNodeV1Type = Exclude<NodeType, "api.operation" | "resource.query">;

export interface ResourceQueryNodeParams {
  readonly resourceProductId: string;
  readonly packVersionId: string;
  readonly resourcePackContentHash: string;
  readonly filterFields: readonly string[];
  readonly returnFields: readonly string[];
  readonly limit?: number;
}

export interface FlowNode {
  id: string;
  type: NodeType;
  params: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
}

export interface FlowGraphV1 {
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  meta?: Record<string, unknown>;
}

export type ValueBinding =
  | { readonly kind: "literal"; readonly value: JsonValue }
  | {
      readonly kind: "port";
      readonly nodeId: string;
      readonly portId: string;
      readonly path?: string;
    }
  | { readonly kind: "variable"; readonly variableId: string; readonly path?: string }
  | { readonly kind: "secret"; readonly connectionId: string; readonly field: string };

export interface FlowVariable {
  readonly id: string;
  readonly name: string;
  readonly scope: "workflow" | "run";
  readonly schema: JsonSchema;
  readonly default?: JsonValue;
  readonly sensitive?: boolean;
}

export interface CallableInputPort extends PortSpec {
  readonly target: { readonly kind: "trigger"; readonly path: string };
}

export interface CallableOutputPort extends PortSpec {
  readonly source: {
    readonly nodeId: string;
    readonly portId: string;
    readonly path?: string;
  };
}

export interface FlowCallableInterface {
  readonly inputs: readonly CallableInputPort[];
  readonly outputs: readonly CallableOutputPort[];
}

export type SubflowReference =
  | {
      readonly kind: "draft";
      readonly flowId: string;
      readonly interface: FlowCallableInterface;
      readonly interfaceHash: string;
    }
  | {
      readonly kind: "pinned";
      readonly flowId: string;
      readonly versionId: string;
      readonly interface: FlowCallableInterface;
      readonly interfaceHash: string;
      readonly contentHash: string;
    };

export interface FlowNodeV2 extends Omit<FlowNode, "params"> {
  readonly params: Record<string, JsonValue>;
  readonly bindings: Readonly<Record<string, ValueBinding>>;
  readonly implementationVersion?: string;
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export interface FlowEdgeV2 {
  readonly id: string;
  readonly source: string;
  readonly sourceHandle: string;
  readonly target: string;
  readonly targetHandle: string;
  readonly condition?: ValueBinding;
}

export interface FlowGroup {
  readonly id: string;
  readonly label: string;
  readonly nodeIds: readonly string[];
}

export interface FlowAnnotation {
  readonly id: string;
  readonly text: string;
  readonly position: Point;
}

export interface FlowGraphV2 {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly FlowNodeV2[];
  readonly edges: readonly FlowEdgeV2[];
  readonly variables: readonly FlowVariable[];
  readonly groups: readonly FlowGroup[];
  readonly annotations: readonly FlowAnnotation[];
  readonly callableInterface?: FlowCallableInterface;
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export type SupportedFlowGraph = FlowGraphV1 | FlowGraphV2;

/** Compatibility aliases remain v1 until callers deliberately widen. */
export type FlowGraph = FlowGraphV1;

export type NodeStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface LedgerRow {
  nodeId: string;
  nodeType: NodeType;
  status: NodeStatus;
  costUsdc: number;
  settled: boolean;
}

export type RunEvent =
  | { kind: "run:start"; runId: string; at: number }
  | { kind: "node:start"; runId: string; nodeId: string; nodeType: NodeType }
  | { kind: "node:log"; runId: string; nodeId: string; level: "info" | "error"; msg: string }
  | {
      kind: "node:done";
      runId: string;
      nodeId: string;
      nodeType: NodeType;
      outputs: Record<string, unknown>;
      costUsdc: number;
    }
  | {
      kind: "node:error";
      runId: string;
      nodeId: string;
      nodeType: NodeType;
      error: string;
      /**
       * Set when this node:error is a run-cost-ceiling abort rather than an
       * ordinary node failure: the node was never executed (or, for a
       * loop/subflow node, was mid-execution when the ceiling was reached)
       * and no further cost was charged for it. Absent for a normal failure.
       */
      costCeilingExceeded?: true;
    }
  | {
      kind: "run:done";
      runId: string;
      totalCostUsdc: number;
      status: "done" | "error";
      /** Set when the run ended early because its in-run cost ceiling was reached. */
      abortedReason?: "cost-ceiling";
    };
