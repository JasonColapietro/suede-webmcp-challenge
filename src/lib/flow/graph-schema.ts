import { z } from "zod";
import {
  ApiOperationV1UnsupportedError,
  graphContainsApiOperation,
} from "./api-operation-contract";
import { NODE_TYPE_SET } from "./node-meta";
import type {
  FlowGraphV1,
  FlowGraphV2,
  FlowVariable,
  JsonSchema,
  JsonValue,
  NodeType,
  SupportedFlowGraph,
} from "./types";
import {
  FlowCallableInterfaceSchema,
  assertCallableOutputLineageSafe,
  normalizeSubflowReference,
} from "./subflow-reference";

const idSchema = z.string().trim().min(1);
const finiteNumberSchema = z.number().finite();
const pointSchema = z
  .object({ x: finiteNumberSchema, y: finiteNumberSchema })
  .strict();
const nodeTypeSchema = z.custom<NodeType>(
  (value) => typeof value === "string" && NODE_TYPE_SET.has(value),
  "unknown node type",
);
const flowNodeV1TypeSchema = z.custom<Exclude<NodeType, "api.operation" | "resource.query">>(
  (value) => typeof value === "string" && value !== "api.operation" && value !== "resource.query" && NODE_TYPE_SET.has(value),
  "unknown or unsupported v1 node type",
);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    finiteNumberSchema,
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonSchemaSchema: z.ZodType<JsonSchema> = z.record(
  z.string(),
  JsonValueSchema,
);

export const ValueBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: JsonValueSchema }).strict(),
  z
    .object({
      kind: z.literal("port"),
      nodeId: idSchema,
      portId: idSchema,
      path: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("variable"),
      variableId: idSchema,
      path: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("secret"),
      connectionId: idSchema,
      field: idSchema,
    })
    .strict(),
]);

const flowNodeV1Schema = z
  .object({
    id: z.string().min(1),
    type: flowNodeV1TypeSchema,
    params: z.record(z.string(), z.unknown()),
    position: pointSchema,
  })
  .passthrough();

const flowEdgeV1Schema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    sourceHandle: z.string().optional(),
    targetHandle: z.string().optional(),
  })
  .passthrough();

const flowGraphV1ValidationSchema = z
  .object({
    schemaVersion: z.never().optional(),
    id: z.string().min(1),
    name: z.string(),
    nodes: z.array(flowNodeV1Schema),
    edges: z.array(flowEdgeV1Schema),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const FlowGraphV1Schema: z.ZodType<FlowGraphV1, z.ZodTypeDef, unknown> = z
  .unknown()
  .transform((value, context) => {
    const result = flowGraphV1ValidationSchema.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) context.addIssue(issue);
      return z.NEVER;
    }
    return value as FlowGraphV1;
  });

export const FlowVariableSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    scope: z.enum(["workflow", "run"]),
    schema: JsonSchemaSchema,
    default: JsonValueSchema.optional(),
    sensitive: z.boolean().optional(),
  })
  .strict()
  .superRefine((variable, context) => {
    if (variable.sensitive === true && Object.hasOwn(variable, "default")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Sensitive variables cannot contain a default",
        path: ["default"],
      });
    }
  });

const flowNodeV2Schema = z
  .object({
    id: idSchema,
    type: nodeTypeSchema,
    params: z.record(z.string(), JsonValueSchema),
    bindings: z.record(z.string(), ValueBindingSchema),
    implementationVersion: z.string().trim().min(1).optional(),
    meta: z.record(z.string(), JsonValueSchema).optional(),
    position: pointSchema,
  })
  .strict();

const flowEdgeV2Schema = z
  .object({
    id: idSchema,
    source: idSchema,
    sourceHandle: idSchema,
    target: idSchema,
    targetHandle: idSchema,
    condition: ValueBindingSchema.optional(),
  })
  .strict();

const flowGroupSchema = z
  .object({
    id: idSchema,
    label: z.string(),
    nodeIds: z.array(idSchema),
  })
  .strict();

const flowAnnotationSchema = z
  .object({
    id: idSchema,
    text: z.string(),
    position: pointSchema,
  })
  .strict();

function requireUniqueIds(
  values: readonly { readonly id: string }[],
  path: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${path} ids must be unique`,
        path: [path, index, "id"],
      });
    }
    seen.add(value.id);
  });
}

export const FlowGraphV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: idSchema,
    name: z.string(),
    nodes: z.array(flowNodeV2Schema),
    edges: z.array(flowEdgeV2Schema),
    variables: z.array(FlowVariableSchema),
    groups: z.array(flowGroupSchema),
    annotations: z.array(flowAnnotationSchema),
    callableInterface: FlowCallableInterfaceSchema.optional(),
    meta: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict()
  .superRefine((graph, context) => {
    requireUniqueIds(graph.nodes, "nodes", context);
    requireUniqueIds(graph.edges, "edges", context);
    requireUniqueIds(graph.variables, "variables", context);
    requireUniqueIds(graph.groups, "groups", context);
    requireUniqueIds(graph.annotations, "annotations", context);

    graph.nodes.forEach((node, index) => {
      if (node.type !== "subflow" && node.type !== "loop") return;
      try {
        const normalized = normalizeSubflowReference(node.params);
        if (
          node.type === "loop" &&
          normalized.kind === "typed" &&
          normalized.reference.interface.outputs.some((port) => port.id === "errors")
        ) {
          throw new Error('Typed loop child callable output id "errors" is reserved');
        }
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : "Invalid subflow reference",
          path: ["nodes", index, "params"],
        });
      }
    });

    if (graph.callableInterface) {
      try {
        assertCallableOutputLineageSafe(graph, graph.callableInterface);
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : "Unsafe callable output lineage",
          path: ["callableInterface", "outputs"],
        });
      }
    }

    const names = new Set<string>();
    graph.variables.forEach((variable, index) => {
      const normalized = variable.name.toLowerCase();
      if (names.has(normalized)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Variable names must be unique (case-insensitive)",
          path: ["variables", index, "name"],
        });
      }
      names.add(normalized);
    });
  });

function numericSchemaVersion(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const version = (value as Record<string, unknown>).schemaVersion;
  return typeof version === "number" ? version : null;
}

export function parseSupportedFlowGraph(value: unknown): SupportedFlowGraph {
  const version = numericSchemaVersion(value);
  if (version !== null && version !== 2) {
    throw new Error(`Unsupported flow graph schemaVersion: ${version}`);
  }
  if (version === null && typeof value === "object" && value !== null &&
      Array.isArray((value as { nodes?: unknown }).nodes) &&
      graphContainsApiOperation(value as { nodes: readonly { type: unknown }[] })) {
    throw new ApiOperationV1UnsupportedError();
  }
  return (version === 2 ? FlowGraphV2Schema.parse(value) : FlowGraphV1Schema.parse(value)) as
    | FlowGraphV1
    | FlowGraphV2;
}

export const SupportedFlowGraphSchema: z.ZodType<SupportedFlowGraph, z.ZodTypeDef, unknown> = z
  .unknown()
  .transform((value, context) => {
    try {
      return parseSupportedFlowGraph(value);
    } catch (error) {
      if (error instanceof z.ZodError) {
        for (const issue of error.issues) context.addIssue(issue);
      } else {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : "Invalid flow graph",
        });
      }
      return z.NEVER;
    }
  });

export function isFlowGraphV1(value: unknown): value is FlowGraphV1 {
  return numericSchemaVersion(value) === null && FlowGraphV1Schema.safeParse(value).success;
}

export function isFlowGraphV2(value: unknown): value is FlowGraphV2 {
  return numericSchemaVersion(value) === 2 && FlowGraphV2Schema.safeParse(value).success;
}

export function isFlowVariable(value: unknown): value is FlowVariable {
  return FlowVariableSchema.safeParse(value).success;
}

export function requireFlowGraphV1(
  graph: SupportedFlowGraph,
  operation: string,
): FlowGraphV1 {
  if (isFlowGraphV1(graph)) return graph;
  if (graphContainsApiOperation(graph)) throw new ApiOperationV1UnsupportedError();
  throw new Error(`${operation} does not support flow graph schemaVersion 2 yet`);
}
