import type { JsonSchema, NodeType } from "./types";
import type {
  ConnectionKind,
  ConnectionSemanticField,
} from "../connections/types";

export type { JsonSchema } from "./types";
export type NodeEffect =
  "read" | "write" | "delete" | "send" | "spend" | "publish" | "settle";
export type NodeGroup =
  "Triggers" | "Music & IP" | "AI" | "Rails" | "Logic" | "I/O" |
  "Docs & Data" | "Comms & CRM" | "Finance & Ops" | "Dev & Infra";
export type NodeFieldKind =
  "string" | "number" | "boolean" | "json" | "select" | "textarea";

/** A select option whose displayed label differs from its stored value. */
export interface NodeFieldOption {
  readonly value: string;
  readonly label: string;
}

export interface NodeField {
  readonly key: string;
  readonly kind: NodeFieldKind;
  readonly options?: readonly string[] | readonly NodeFieldOption[];
  readonly label: string;
  readonly hint: string;
}

export interface PortSpec {
  readonly id: string;
  readonly label: string;
  readonly schema: JsonSchema;
  readonly required: boolean;
  readonly cardinality: "one" | "many";
}

export interface PermissionSpec {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly scope?: string;
}

export interface NodeConnectionSpec {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly field: ConnectionSemanticField;
  readonly required: boolean;
  readonly allowedKinds: readonly ConnectionKind[];
  readonly requiredHeaderNames: readonly string[];
}

export interface NodeDefinitionV2 {
  readonly definitionVersion: 1;
  readonly type: NodeType;
  readonly label: string;
  readonly category: NodeGroup;
  readonly description: string;
  readonly docsPath?: string;
  readonly configSchema: JsonSchema;
  readonly inputPorts: readonly PortSpec[];
  readonly outputPorts: readonly PortSpec[];
  readonly permissions: readonly PermissionSpec[];
  readonly connections?: readonly NodeConnectionSpec[];
  readonly effects: readonly NodeEffect[];
  readonly capabilityMode: "static" | "config-dependent" | "inherits-graph";
  readonly testMode: "native" | "stub" | "refuse";
  readonly retry: "safe" | "idempotency-required" | "unsafe";
  readonly cost: {
    readonly kind: "free" | "estimated" | "variable";
    readonly currency?: "USDC";
    readonly amount?: number;
  };
  readonly prototype?: {
    readonly enabled: boolean;
    readonly badge: "Prototype: simulation only";
  };
  readonly ui: {
    readonly icon: string;
    readonly searchableTerms: readonly string[];
    readonly featured?: boolean;
    readonly fields: readonly NodeField[];
  };
}
