import { z } from "zod";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage } from "../_util";
import { orderedColumns, resolveRows, rowSchema, stableJson } from "./_rows";

export const MAX_SPREADSHEET_OUTPUT_BYTES = 3 * 1024 * 1024;
const MAX_CELL_CHARACTERS = 32_000;

export const generateSpreadsheetParamsSchema = z.object({
  rows: z.array(rowSchema).max(10_000).optional(),
  fileName: z.string().min(1).max(160).default("suede-data.xlsx"),
  sheetName: z.string().min(1).max(31).default("Data"),
});

export type GenerateSpreadsheetParams = z.infer<typeof generateSpreadsheetParamsSchema>;

function safeFileName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  const base = cleaned || "suede-data.xlsx";
  const withoutExtension = base.toLocaleLowerCase().endsWith(".xlsx") ? base.slice(0, -5) : base;
  return `${withoutExtension.slice(0, 155)}.xlsx`;
}

function safeSheetName(value: string): string {
  return value.replace(/[\\/*?:\[\]]/g, "-").replace(/^'+|'+$/g, "").trim() || "Data";
}

function cellValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  let text = typeof value === "string" ? value : stableJson(value);
  if (text.length > MAX_CELL_CHARACTERS) {
    throw new Error(`A cell exceeds the ${MAX_CELL_CHARACTERS}-character cap`);
  }
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return text;
}

export const createGenerateSpreadsheetExecutor = (): NodeExecutor => async (_ctx, rawParams, inputs) => {
  try {
    const params = generateSpreadsheetParamsSchema.parse(rawParams ?? {});
    const rows = resolveRows(params.rows, inputs);
    const columns = orderedColumns(rows);
    if (columns.length === 0) throw new Error("At least one data column is required");

    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Suede Agent Studio";
    workbook.created = new Date(0);
    workbook.modified = new Date(0);
    const worksheet = workbook.addWorksheet(safeSheetName(params.sheetName));
    worksheet.columns = columns.map((key) => ({ header: key, key, width: Math.min(40, Math.max(10, key.length + 2)) }));
    worksheet.getRow(1).font = { bold: true };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of rows) {
      worksheet.addRow(Object.fromEntries(columns.map((column) => [column, cellValue(row[column])])));
    }
    worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: columns.length } };

    const encoded = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(encoded as ArrayBuffer);
    if (buffer.byteLength > MAX_SPREADSHEET_OUTPUT_BYTES) {
      throw new Error(`Generated workbook exceeds the ${MAX_SPREADSHEET_OUTPUT_BYTES}-byte cap`);
    }
    return {
      ok: true,
      outputs: {
        result: {
          fileBase64: buffer.toString("base64"),
          fileName: safeFileName(params.fileName),
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          rowCount: rows.length,
          columnCount: columns.length,
          byteCount: buffer.byteLength,
        },
      },
      costUsdc: 0,
    };
  } catch (error) {
    return { ok: false, error: `Failed to generate spreadsheet: ${errMessage(error)}`, costUsdc: 0 };
  }
};

export const generateSpreadsheetNode = defineExecutableNode(getNodeDefinition("data.generateSpreadsheet"), {
  paramsSchema: generateSpreadsheetParamsSchema,
  executor: createGenerateSpreadsheetExecutor(),
});
