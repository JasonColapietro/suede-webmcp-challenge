import { z } from "zod";

export const MAX_DATA_ROWS = 10_000;
export const MAX_DATA_COLUMNS = 100;
export const MAX_DATA_KEY_LENGTH = 128;
export const MAX_DATA_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_DATA_ENTRIES = 100_000;
export const MAX_DATA_STRING_BYTES = 32_000;
export const MAX_DATA_NESTING = 24;

export const rowSchema = z.record(z.string().min(1).max(MAX_DATA_KEY_LENGTH), z.unknown());
export const rowsSchema = z.array(rowSchema).max(MAX_DATA_ROWS);

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function auditValue(
  value: unknown,
  budget: { bytes: number; entries: number },
  ancestors: Set<object>,
  depth: number,
): void {
  if (depth > MAX_DATA_NESTING) throw new Error(`Data exceeds the ${MAX_DATA_NESTING}-level nesting cap`);
  budget.entries += 1;
  if (budget.entries > MAX_DATA_ENTRIES) throw new Error(`Data exceeds the ${MAX_DATA_ENTRIES}-entry cap`);
  if (value === null || value === undefined) {
    budget.bytes += 4;
  } else if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MAX_DATA_STRING_BYTES) throw new Error(`A data string exceeds the ${MAX_DATA_STRING_BYTES}-byte cap`);
    budget.bytes += bytes;
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Data numbers must be finite");
    budget.bytes += 8;
  } else if (typeof value === "boolean") {
    budget.bytes += 1;
  } else if (typeof value === "bigint") {
    budget.bytes += Buffer.byteLength(value.toString(), "utf8");
  } else if (typeof value === "object") {
    if (ancestors.has(value)) throw new Error("Data must not contain cyclic values");
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (const item of value) auditValue(item, budget, ancestors, depth + 1);
    } else {
      const record = plainRecord(value);
      if (!record) throw new Error("Data values must contain only plain JSON objects and arrays");
      for (const [key, item] of Object.entries(record)) {
        budget.bytes += Buffer.byteLength(key, "utf8");
        auditValue(item, budget, ancestors, depth + 1);
      }
    }
    ancestors.delete(value);
  } else {
    throw new Error(`Unsupported data value type: ${typeof value}`);
  }
  if (budget.bytes > MAX_DATA_INPUT_BYTES) throw new Error(`Data exceeds the ${MAX_DATA_INPUT_BYTES}-byte cap`);
}

export function auditRows(rows: readonly Record<string, unknown>[]): void {
  const budget = { bytes: 0, entries: 0 };
  auditValue(rows, budget, new Set<object>(), 0);
}

export function resolveRows(
  configured: readonly Record<string, unknown>[] | undefined,
  inputs: Record<string, unknown>,
): Record<string, unknown>[] {
  if (configured !== undefined) {
    const rows = rowsSchema.parse(configured);
    auditRows(rows);
    return rows;
  }
  const upstream = inputs.in;
  if (Array.isArray(upstream)) {
    const rows = rowsSchema.parse(upstream);
    auditRows(rows);
    return rows;
  }
  const record = plainRecord(upstream);
  if (!record) throw new Error("rows are required (or an upstream { rows } result)");
  const rows = rowsSchema.parse(record.rows);
  auditRows(rows);
  return rows;
}

export function orderedColumns(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
      if (columns.length > MAX_DATA_COLUMNS) {
        throw new Error(`Rows exceed the ${MAX_DATA_COLUMNS}-column cap`);
      }
    }
  }
  return columns;
}

export function stableJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error("Data exceeds the nesting limit");
  if (value === undefined) return "null";
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, depth + 1)).join(",")}]`;
  const record = plainRecord(value);
  if (!record) return JSON.stringify(String(value));
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key], depth + 1)}`).join(",")}}`;
}
