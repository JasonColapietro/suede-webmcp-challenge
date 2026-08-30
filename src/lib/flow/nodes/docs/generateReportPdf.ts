import { z } from "zod";
import PDFDocument from "pdfkit";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage, upstreamRecord } from "../_util";
import { stableJson } from "../data/_rows";

export const MAX_REPORT_PDF_BYTES = 2 * 1024 * 1024;

const sectionSchema = z.object({
  heading: z.string().min(1).max(160),
  body: z.string().min(1).max(12_000),
});

export const generateReportPdfParamsSchema = z.object({
  title: z.string().min(1).max(200).default("Suede Report"),
  fileName: z.string().min(1).max(160).default("suede-report.pdf"),
  content: z.string().max(50_000).optional(),
  sections: z.array(sectionSchema).max(25).default([]),
});

export type GenerateReportPdfParams = z.infer<typeof generateReportPdfParamsSchema>;

function safeFileName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  const base = cleaned || "suede-report.pdf";
  const withoutExtension = base.toLocaleLowerCase().endsWith(".pdf") ? base.slice(0, -4) : base;
  return `${withoutExtension.slice(0, 156)}.pdf`;
}

function derivedContent(upstream: Readonly<Record<string, unknown>>): string | undefined {
  if (Object.keys(upstream).length === 0) return undefined;
  const rows = Array.isArray(upstream.rows) ? upstream.rows : null;
  const summarized = rows
    ? { ...upstream, rows: rows.slice(0, 25), omittedRowCount: Math.max(0, rows.length - 25) }
    : upstream;
  const encoded = stableJson(summarized);
  return encoded.length <= 50_000 ? encoded : `${encoded.slice(0, 49_900)}… [content truncated]`;
}

async function renderReport(params: GenerateReportPdfParams): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 54, info: { Title: params.title, Creator: "Suede Agent Studio", CreationDate: new Date(0) } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });

  doc.fontSize(22).fillColor("#111827").text(params.title);
  doc.moveDown(1.25);
  const sections = params.sections.length > 0
    ? params.sections
    : [{ heading: "Report", body: params.content ?? "" }];
  for (const section of sections) {
    doc.fontSize(13).fillColor("#111827").text(section.heading);
    doc.moveDown(0.35);
    doc.fontSize(10).fillColor("#374151").text(section.body, { lineGap: 2 });
    doc.moveDown(1.1);
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

export const createGenerateReportPdfExecutor = (): NodeExecutor => async (_ctx, rawParams, inputs) => {
  try {
    const defaults = rawParams !== null && typeof rawParams === "object" && !Array.isArray(rawParams)
      ? rawParams as Record<string, unknown>
      : {};
    const upstream = inputs.in;
    const upstreamFields = upstreamRecord(inputs);
    const fallbackContent = typeof upstream === "string"
      ? upstream
      : derivedContent(upstreamFields);
    const params = generateReportPdfParamsSchema.parse({
      ...upstreamFields,
      ...defaults,
      ...(!Object.hasOwn(defaults, "content") && !Object.hasOwn(upstreamFields, "content") && fallbackContent
        ? { content: fallbackContent }
        : {}),
    });
    if (params.sections.length === 0 && (!params.content || params.content.trim() === "")) {
      throw new Error("content or at least one report section is required");
    }
    const buffer = await renderReport(params);
    if (buffer.byteLength > MAX_REPORT_PDF_BYTES) {
      throw new Error(`Generated PDF exceeds the ${MAX_REPORT_PDF_BYTES}-byte cap`);
    }
    return {
      ok: true,
      outputs: {
        result: {
          fileBase64: buffer.toString("base64"),
          fileName: safeFileName(params.fileName),
          mimeType: "application/pdf",
          sectionCount: params.sections.length || 1,
          byteCount: buffer.byteLength,
        },
      },
      costUsdc: 0,
    };
  } catch (error) {
    return { ok: false, error: `Failed to generate report: ${errMessage(error)}`, costUsdc: 0 };
  }
};

export const generateReportPdfNode = defineExecutableNode(getNodeDefinition("docs.generateReportPdf"), {
  paramsSchema: generateReportPdfParamsSchema,
  executor: createGenerateReportPdfExecutor(),
});
