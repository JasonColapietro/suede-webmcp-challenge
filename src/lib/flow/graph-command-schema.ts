import { z } from "zod";
import { NODE_TYPE_SET } from "./node-definitions";
import { GraphCommandError, type GraphCommand } from "./graph-command-types";
import {
  JsonValueSchema,
  FlowVariableSchema,
  ValueBindingSchema,
  isFlowGraphV1,
  isFlowGraphV2,
  isFlowVariable,
  parseSupportedFlowGraph,
} from "./graph-schema";
import { assertJsonValue, assertSafeJsonPointer } from "./json-patch";
import type { NodeType } from "./types";
import { BoundedFlowCallableInterfaceSchema } from "./subflow-api";
import { ApiSubflowReferenceSchema } from "./subflow-api";

const MAX_BATCH_DEPTH = 10;
const MAX_BATCH_CHILDREN = 500;
const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, "ID must not be blank");
const finite = z.number().finite("Coordinate must be finite");
const index = z.number().int().nonnegative();
const point = z.object({ x: finite, y: finite }).strict();
const bounds = point.extend({ width: finite.nonnegative(), height: finite.nonnegative() }).strict();
const uniqueIds = z.array(nonBlank).min(1).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "IDs must be unique" });
  if (values.some((value, index) => index > 0 && (values[index - 1] as string) > value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Selection node IDs must be sorted" });
  }
});
const jsonObject = z.record(z.unknown());
const positions = z.record(nonBlank, point).superRefine((value, context) => {
  if (Object.keys(value).length === 0) context.addIssue({ code: z.ZodIssueCode.custom, message: "Positions must not be empty" });
});
const boundsRecord = z.record(nonBlank, bounds);
const nodeType = z.string().refine((value): value is NodeType => NODE_TYPE_SET.has(value as NodeType), "Unknown node type");
const flowNode = z.object({ id: nonBlank, type: nodeType, params: jsonObject, position: point }).passthrough();
const flowEdge = z.object({ id: nonBlank, source: nonBlank, target: nonBlank, sourceHandle: nonBlank.optional(), targetHandle: nonBlank.optional() }).passthrough();
const flowNodeV2 = z.object({
  id: nonBlank,
  type: nodeType,
  params: z.record(z.string(), JsonValueSchema),
  bindings: z.record(z.string(), ValueBindingSchema),
  implementationVersion: nonBlank.optional(),
  meta: z.record(z.string(), JsonValueSchema).optional(),
  position: point,
}).strict();
const flowEdgeV2 = z.object({
  id: nonBlank,
  source: nonBlank,
  sourceHandle: nonBlank,
  target: nonBlank,
  targetHandle: nonBlank,
  condition: ValueBindingSchema.optional(),
}).strict();
const preservingFlowVariable = z.unknown().transform((value, context) => {
  const result = FlowVariableSchema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue(issue);
    return z.NEVER;
  }
  return isFlowVariable(value) ? value : z.NEVER;
});
const preservingSupportedFlowGraph = z.unknown().transform((value, context) => {
  try {
    parseSupportedFlowGraph(value);
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
  return isFlowGraphV1(value) || isFlowGraphV2(value) ? value : z.NEVER;
});
const patchOperation = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["add", "replace"]), path: z.string(), value: z.unknown() }).strict(),
  z.object({ op: z.literal("remove"), path: z.string() }).strict(),
]).superRefine((operation, context) => {
  try {
    assertSafeJsonPointer(operation.path);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Unsafe JSON Pointer",
    });
  }
});
const commandBase = { v: z.literal(1), id: nonBlank } as const;

function exactCoverage(
  ids: readonly string[],
  record: Record<string, unknown>,
  label: string,
  context: z.RefinementCtx,
): void {
  const expected = [...ids].sort();
  const actual = Object.keys(record).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must exactly cover selected IDs` });
  }
}

const duplicateCommand = z.object({
  ...commandBase,
  kind: z.literal("selection.duplicate"),
  nodeIds: uniqueIds,
  offset: point,
  nodeIdMap: z.record(nonBlank, nonBlank),
  edgeIdMap: z.record(nonBlank, nonBlank),
}).strict().superRefine((command, context) => {
  exactCoverage(command.nodeIds, command.nodeIdMap, "nodeIdMap", context);
  const nodeValues = Object.values(command.nodeIdMap);
  if (new Set(nodeValues).size !== nodeValues.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "nodeIdMap values must be unique" });
  if (nodeValues.some((value) => command.nodeIds.includes(value))) context.addIssue({ code: z.ZodIssueCode.custom, message: "nodeIdMap values collide with source node IDs" });
  const edgeValues = Object.values(command.edgeIdMap);
  if (new Set(edgeValues).size !== edgeValues.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "edgeIdMap values must be unique" });
  if (new Set([...nodeValues, ...edgeValues]).size !== nodeValues.length + edgeValues.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Mapped node and edge IDs must be unique across maps" });
  }
  if (edgeValues.some((value) => Object.prototype.hasOwnProperty.call(command.edgeIdMap, value))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "edgeIdMap values collide with source edge IDs" });
  }
});

function selectionGeometrySchema(kind: "selection.align" | "selection.distribute") {
  const shape = {
    ...commandBase,
    kind: z.literal(kind),
    nodeIds: uniqueIds,
    bounds: boundsRecord,
    axis: z.enum(["x", "y"]),
  };
  const schema = kind === "selection.align"
    ? z.object({ ...shape, mode: z.enum(["start", "center", "end"]) }).strict()
    : z.object(shape).strict();
  return schema.superRefine((command, context) => exactCoverage(command.nodeIds, command.bounds, "bounds", context));
}

const leafSchemas = [
  z.object({ ...commandBase, kind: z.literal("node.add"), node: z.union([flowNodeV2, flowNode]), index: index.optional() }).strict(),
  z.object({ ...commandBase, kind: z.literal("node.remove"), nodeId: nonBlank }).strict(),
  z.object({ ...commandBase, kind: z.literal("node.patch"), nodeId: nonBlank, patch: z.array(patchOperation).min(1) }).strict(),
  z.object({ ...commandBase, kind: z.literal("edge.add"), edge: z.union([flowEdgeV2, flowEdge]), index: index.optional() }).strict(),
  z.object({ ...commandBase, kind: z.literal("edge.remove"), edgeId: nonBlank }).strict(),
  z.object({ ...commandBase, kind: z.literal("selection.move"), positions }).strict(),
  duplicateCommand,
  selectionGeometrySchema("selection.align"),
  selectionGeometrySchema("selection.distribute"),
  z.object({ ...commandBase, kind: z.literal("layout.apply"), positions }).strict(),
  z.object({ ...commandBase, kind: z.literal("graph.rename"), name: z.string() }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal("callable-interface.set"),
    interface: BoundedFlowCallableInterfaceSchema,
  }).strict(),
  z.object({ ...commandBase, kind: z.literal("callable-interface.remove") }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal("subflow-reference.set"),
    nodeId: nonBlank,
    reference: ApiSubflowReferenceSchema,
  }).strict(),
  z.object({ ...commandBase, kind: z.literal("variable.add"), variable: preservingFlowVariable, index: index.optional() }).strict(),
  z.object({ ...commandBase, kind: z.literal("variable.patch"), variableId: nonBlank, patch: z.array(patchOperation).min(1) }).strict()
    .superRefine((command, context) => {
      for (const operation of command.patch) {
        try {
          assertSafeJsonPointer(operation.path, ["id"]);
        } catch (error) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : "Variable ID patches are forbidden",
            path: ["patch"],
          });
        }
      }
    }),
  z.object({ ...commandBase, kind: z.literal("variable.remove"), variableId: nonBlank }).strict(),
  z.object({ ...commandBase, kind: z.literal("binding.set"), nodeId: nonBlank, key: nonBlank, binding: ValueBindingSchema }).strict(),
  z.object({ ...commandBase, kind: z.literal("binding.remove"), nodeId: nonBlank, key: nonBlank }).strict(),
  z.object({ ...commandBase, kind: z.literal("graph.replace"), graph: preservingSupportedFlowGraph }).strict(),
] as const;

const commandSchema: z.ZodType<GraphCommand> = z.lazy(() => z.union([
  ...leafSchemas,
  z.object({ ...commandBase, kind: z.literal("graph.batch"), commands: z.array(commandSchema).min(1) }).strict(),
]) as z.ZodType<GraphCommand>);

function auditBatch(
  command: GraphCommand,
  depth: number,
  commandIds: Set<string>,
): number {
  if (depth > MAX_BATCH_DEPTH) throw new GraphCommandError(`Graph command batch depth exceeds ${MAX_BATCH_DEPTH}`);
  if (commandIds.has(command.id)) throw new GraphCommandError("Graph command IDs must be unique within a batch");
  commandIds.add(command.id);
  if (command.kind !== "graph.batch") return 1;
  let descendants = 0;
  for (const child of command.commands) {
    descendants += auditBatch(child, depth + 1, commandIds);
    if (descendants > MAX_BATCH_CHILDREN) throw new GraphCommandError(`Graph command batch exceeds ${MAX_BATCH_CHILDREN} children`);
  }
  return 1 + descendants;
}

export function auditGraphCommandBatchLimits(command: GraphCommand): number {
  return auditBatch(command, 0, new Set<string>());
}

function auditRawBatchShape(
  value: unknown,
  depth = 0,
  counter = { children: 0 },
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
  const commandsDescriptor = Object.getOwnPropertyDescriptor(value, "commands");
  if (
    !kindDescriptor || !("value" in kindDescriptor) || kindDescriptor.value !== "graph.batch" ||
    !commandsDescriptor || !("value" in commandsDescriptor) || !Array.isArray(commandsDescriptor.value)
  ) return;
  if (depth >= MAX_BATCH_DEPTH) {
    throw new GraphCommandError(`Graph command batch depth exceeds ${MAX_BATCH_DEPTH}`);
  }
  const commands = commandsDescriptor.value;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(commands, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) return;
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const childDescriptor = Object.getOwnPropertyDescriptor(commands, String(index));
    if (!childDescriptor || !("value" in childDescriptor)) return;
    counter.children += 1;
    if (counter.children > MAX_BATCH_CHILDREN) {
      throw new GraphCommandError(`Graph command batch exceeds ${MAX_BATCH_CHILDREN} children`);
    }
    auditRawBatchShape(childDescriptor.value, depth + 1, counter);
  }
}

export function parseGraphCommand(value: unknown): GraphCommand {
  try {
    auditRawBatchShape(value);
    assertJsonValue(value, "$command");
  } catch (error) {
    if (error instanceof GraphCommandError) throw error;
    throw new GraphCommandError(error instanceof Error ? error.message : "Command must be JSON", { cause: error });
  }
  const result = commandSchema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    throw new GraphCommandError(`Invalid graph command: ${message}`, { cause: result.error });
  }
  auditGraphCommandBatchLimits(result.data);
  return result.data;
}
