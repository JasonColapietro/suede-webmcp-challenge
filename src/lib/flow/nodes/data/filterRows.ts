import { z } from "zod";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage } from "../_util";
import { MAX_DATA_KEY_LENGTH, orderedColumns, resolveRows, rowSchema, stableJson } from "./_rows";

const fieldSchema = z.string().min(1).max(MAX_DATA_KEY_LENGTH);
const filterSchema = z.object({
  field: fieldSchema,
  operator: z.enum([
    "equals",
    "notEquals",
    "contains",
    "notContains",
    "gt",
    "gte",
    "lt",
    "lte",
    "isEmpty",
    "isNotEmpty",
  ]),
  value: z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]).optional(),
}).superRefine((filter, context) => {
  if (filter.operator !== "isEmpty" && filter.operator !== "isNotEmpty" && filter.value === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: `${filter.operator} requires a value` });
  }
});

export const filterRowsParamsSchema = z.object({
  rows: z.array(rowSchema).max(10_000).optional(),
  filters: z.array(filterSchema).max(20).default([]),
  dropEmptyRows: z.boolean().default(true),
  dedupe: z.boolean().default(false),
  dedupeBy: z.array(fieldSchema).max(20).default([]),
  selectFields: z.array(fieldSchema).max(100).default([]),
  sortBy: fieldSchema.optional(),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
  limit: z.number().int().positive().max(10_000).default(10_000),
});

export type FilterRowsParams = z.infer<typeof filterRowsParamsSchema>;

function assertKnownFields(params: FilterRowsParams, columns: readonly string[]): void {
  const known = new Set(columns);
  const requested = [
    ...params.filters.map((filter) => filter.field),
    ...params.dedupeBy,
    ...params.selectFields,
    ...(params.sortBy ? [params.sortBy] : []),
  ];
  const unknown = [...new Set(requested.filter((field) => !known.has(field)))];
  if (unknown.length > 0) throw new Error(`Unknown row field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

function empty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function matches(actual: unknown, filter: z.infer<typeof filterSchema>): boolean {
  switch (filter.operator) {
    case "isEmpty": return empty(actual);
    case "isNotEmpty": return !empty(actual);
    case "equals": return stableJson(actual) === stableJson(filter.value);
    case "notEquals": return stableJson(actual) !== stableJson(filter.value);
    case "contains": return String(actual ?? "").toLowerCase().includes(String(filter.value ?? "").toLowerCase());
    case "notContains": return !String(actual ?? "").toLowerCase().includes(String(filter.value ?? "").toLowerCase());
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = numeric(actual);
      const right = numeric(filter.value);
      if (left === null || right === null) return false;
      if (filter.operator === "gt") return left > right;
      if (filter.operator === "gte") return left >= right;
      if (filter.operator === "lt") return left < right;
      return left <= right;
    }
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (empty(left)) return empty(right) ? 0 : 1;
  if (empty(right)) return -1;
  const leftNumber = numeric(left);
  const rightNumber = numeric(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
  const leftText = String(left);
  const rightText = String(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

export const createFilterRowsExecutor = (): NodeExecutor => async (_ctx, rawParams, inputs) => {
  try {
    const params = filterRowsParamsSchema.parse(rawParams ?? {});
    const sourceRows = resolveRows(params.rows, inputs);
    const columns = orderedColumns(sourceRows);
    assertKnownFields(params, columns);

    let emptyCount = 0;
    let filteredCount = 0;
    let duplicateCount = 0;
    const filtered: Record<string, unknown>[] = [];
    for (const row of sourceRows) {
      if (params.dropEmptyRows && Object.values(row).every(empty)) {
        emptyCount += 1;
        continue;
      }
      if (!params.filters.every((filter) => matches(row[filter.field], filter))) {
        filteredCount += 1;
        continue;
      }
      filtered.push(row);
    }

    let processed = filtered;
    if (params.dedupe) {
      const seen = new Set<string>();
      processed = filtered.filter((row) => {
        const key = params.dedupeBy.length > 0
          ? stableJson(params.dedupeBy.map((field) => row[field]))
          : stableJson(row);
        if (seen.has(key)) {
          duplicateCount += 1;
          return false;
        }
        seen.add(key);
        return true;
      });
    }

    if (params.sortBy) {
      const direction = params.sortDirection === "desc" ? -1 : 1;
      processed = processed.map((row, index) => ({ row, index })).sort((left, right) => {
        const compared = compareValues(left.row[params.sortBy!], right.row[params.sortBy!]);
        return compared === 0 ? left.index - right.index : compared * direction;
      }).map(({ row }) => row);
    }

    if (params.selectFields.length > 0) {
      processed = processed.map((row) => Object.fromEntries(
        params.selectFields.map((field) => [field, row[field] ?? null]),
      ));
    }
    processed = processed.slice(0, params.limit);

    return {
      ok: true,
      outputs: {
        result: {
          rows: processed,
          rowCount: processed.length,
          sourceRowCount: sourceRows.length,
          filteredCount,
          duplicateCount,
          emptyCount,
          truncatedCount: Math.max(0, filtered.length - duplicateCount - processed.length),
          appliedRules: {
            filters: params.filters,
            dropEmptyRows: params.dropEmptyRows,
            dedupe: params.dedupe,
            dedupeBy: params.dedupeBy,
            selectFields: params.selectFields,
            sortBy: params.sortBy ?? null,
            sortDirection: params.sortDirection,
            limit: params.limit,
          },
        },
      },
      costUsdc: 0,
    };
  } catch (error) {
    return { ok: false, error: errMessage(error), costUsdc: 0 };
  }
};

export const filterRowsNode = defineExecutableNode(getNodeDefinition("data.filterRows"), {
  paramsSchema: filterRowsParamsSchema,
  executor: createFilterRowsExecutor(),
});
