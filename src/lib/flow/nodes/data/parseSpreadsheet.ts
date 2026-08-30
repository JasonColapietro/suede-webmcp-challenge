/**
 * CSV/XLSX -> JSON row objects. Local computation only, same scope line as
 * the docs/ extraction nodes: bytes given directly, no URL fetch.
 *
 * XLSX parsing uses exceljs, not the more common `xlsx` (SheetJS) package —
 * SheetJS carries an unpatched high-severity prototype-pollution/ReDoS
 * advisory triggered by parsing exactly the untrusted input this node
 * exists to parse. exceljs has no advisory on that class of issue.
 */
import { z } from "zod";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage, upstreamFileBase64 } from "../_util";
import { csvToRowObjects } from "./csv";

export const parseSpreadsheetParamsSchema = z.object({
  fileBase64: z.string().optional(),
  format: z.enum(["csv", "xlsx"]).default("csv"),
  sheetName: z.string().optional(),
});

export type ParseSpreadsheetParams = z.infer<typeof parseSpreadsheetParamsSchema>;

/** 10 MB decoded — bounded against memory abuse. */
export const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;

function cellValueToPlain(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  // Rich text / formula-result cells: exceljs surfaces these as objects
  // ({ richText: [...] } or { result: ... }); fall back to a string form
  // rather than emitting an opaque object a downstream node can't use.
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("result" in record) return cellValueToPlain(record.result);
    if ("text" in record && typeof record.text === "string") return record.text;
    return JSON.stringify(value);
  }
  return String(value);
}

async function parseXlsx(
  buffer: Buffer,
  sheetName: string | undefined,
): Promise<Record<string, unknown>[]> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const worksheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!worksheet) {
    throw new Error(sheetName ? `Sheet "${sheetName}" not found` : "Workbook has no sheets");
  }

  let header: string[] = [];
  const rows: Record<string, unknown>[] = [];
  worksheet.eachRow((row, rowNumber) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    if (rowNumber === 1) {
      header = values.map((v, idx) => {
        const plain = cellValueToPlain(v);
        return plain === null || plain === "" ? `column_${idx + 1}` : String(plain);
      });
      return;
    }
    const obj: Record<string, unknown> = {};
    header.forEach((key, idx) => {
      obj[key] = cellValueToPlain(values[idx]);
    });
    rows.push(obj);
  });
  return rows;
}

export const createParseSpreadsheetExecutor = (): NodeExecutor => async (_ctx, rawParams, inputs) => {
  let params: ParseSpreadsheetParams;
  try {
    params = parseSpreadsheetParamsSchema.parse(rawParams ?? {});
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }

  const source = params.fileBase64 ?? upstreamFileBase64(inputs);
  if (!source) {
    return { ok: false, error: "fileBase64 is required (or an upstream string output)", costUsdc: 0 };
  }

  if (params.format === "csv") {
    // CSV bytes are just text; decode as UTF-8, no binary size ceiling needed
    // beyond the same byte cap applied uniformly below.
    let buffer: Buffer;
    try {
      buffer = Buffer.from(source, "base64");
    } catch (e) {
      return { ok: false, error: `Invalid base64: ${errMessage(e)}`, costUsdc: 0 };
    }
    if (buffer.byteLength > MAX_SPREADSHEET_BYTES) {
      return { ok: false, error: `File exceeds the ${MAX_SPREADSHEET_BYTES}-byte size cap`, costUsdc: 0 };
    }
    try {
      const rows = csvToRowObjects(buffer.toString("utf8"));
      return { ok: true, outputs: { result: { rows, rowCount: rows.length } }, costUsdc: 0 };
    } catch (e) {
      return { ok: false, error: `Failed to parse CSV: ${errMessage(e)}`, costUsdc: 0 };
    }
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(source, "base64");
  } catch (e) {
    return { ok: false, error: `Invalid base64: ${errMessage(e)}`, costUsdc: 0 };
  }
  if (buffer.byteLength === 0) {
    return { ok: false, error: "Decoded file is empty", costUsdc: 0 };
  }
  if (buffer.byteLength > MAX_SPREADSHEET_BYTES) {
    return { ok: false, error: `File exceeds the ${MAX_SPREADSHEET_BYTES}-byte size cap`, costUsdc: 0 };
  }
  try {
    const rows = await parseXlsx(buffer, params.sheetName);
    return { ok: true, outputs: { result: { rows, rowCount: rows.length } }, costUsdc: 0 };
  } catch (e) {
    return { ok: false, error: `Failed to parse XLSX: ${errMessage(e)}`, costUsdc: 0 };
  }
};

export const parseSpreadsheetNode = defineExecutableNode(getNodeDefinition("data.parseSpreadsheet"), {
  paramsSchema: parseSpreadsheetParamsSchema,
  executor: createParseSpreadsheetExecutor(),
});
