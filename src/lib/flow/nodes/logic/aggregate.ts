/**
 * Reduces a list to one number. Counting rows, totalling an amount column or
 * averaging a score previously meant an LLM call for arithmetic the flow can
 * do exactly and for free.
 *
 * `count` counts every item. The value operations read `field` from each row
 * when the list holds objects, and skip items that are not finite numbers, so
 * one ragged row cannot turn a total into NaN. `count` in the result reports
 * how many items actually contributed.
 *
 * Local computation only, so it is free and runs natively in dry-run.
 */
import { z } from "zod";
import { defineExecutableNode } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";

export const aggregateParamsSchema = z.object({
  op: z.enum(["count", "sum", "avg", "min", "max"]).default("count"),
  field: z.string().default(""),
});

function asList(inputs: Record<string, unknown>): unknown[] {
  const value = "in" in inputs ? inputs.in : undefined;
  if (Array.isArray(value)) return [...value];
  return value === undefined ? [] : [value];
}

function numberFrom(item: unknown, field: string): number | null {
  const raw = field !== "" && typeof item === "object" && item !== null && !Array.isArray(item)
    ? (item as Record<string, unknown>)[field]
    : item;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  // Spreadsheet and CSV rows arrive as strings; accept a clean numeric string.
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export const aggregateNode = defineExecutableNode(getNodeDefinition("logic.aggregate"), {
  paramsSchema: aggregateParamsSchema,
  executor: async (_ctx, rawParams, inputs) => {
    const params = aggregateParamsSchema.parse(rawParams ?? {});
    const items = asList(inputs);

    if (params.op === "count") {
      return {
        ok: true,
        outputs: { result: { op: "count", value: items.length, count: items.length } },
        costUsdc: 0,
      };
    }

    const numbers = items
      .map((item) => numberFrom(item, params.field))
      .filter((value): value is number => value !== null);

    // An empty list has no meaningful sum or average; null says so honestly
    // instead of implying a real zero.
    if (numbers.length === 0) {
      return { ok: true, outputs: { result: { op: params.op, value: null, count: 0 } }, costUsdc: 0 };
    }

    const value = params.op === "sum"
      ? numbers.reduce((total, n) => total + n, 0)
      : params.op === "avg"
        ? numbers.reduce((total, n) => total + n, 0) / numbers.length
        : params.op === "min"
          ? Math.min(...numbers)
          : Math.max(...numbers);

    return {
      ok: true,
      outputs: { result: { op: params.op, value, count: numbers.length } },
      costUsdc: 0,
    };
  },
});
