/**
 * Generates a PDF invoice from structured line items. Local computation
 * only, same threat model as the docs/ extraction nodes: no URL fetch, no
 * external API, no new paid service. This is the one genuine self-contained
 * Finance & Ops action found in this pass — everything else in that
 * category (expense policy checks, transaction categorization, bank-rec)
 * is already covered by the existing LLM-template business flows and
 * doesn't need a dedicated executor.
 */
import { z } from "zod";
import PDFDocument from "pdfkit";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage, upstreamRecord } from "../_util";

const lineItemSchema = z.object({
  description: z.string().min(1).max(1_000),
  quantity: z.number().finite().nonnegative(),
  unitPrice: z.number().finite().nonnegative(),
});

export const generateInvoicePdfParamsSchema = z.object({
  invoiceNumber: z.string().min(1, "invoiceNumber is required").max(120),
  sellerName: z.string().min(1, "sellerName is required").max(200),
  buyerName: z.string().min(1, "buyerName is required").max(200),
  lineItems: z.array(lineItemSchema).min(1, "at least one line item is required").max(200),
  currency: z.string().min(1).max(12).default("USD"),
  dueDate: z.string().max(120).optional(),
  notes: z.string().max(5_000).optional(),
});

export type GenerateInvoicePdfParams = z.infer<typeof generateInvoicePdfParamsSchema>;

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

function invoiceFileName(invoiceNumber: string): string {
  const safe = invoiceNumber.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, "-").trim();
  return `invoice-${(safe || "document").slice(0, 140)}.pdf`;
}

async function renderInvoicePdf(params: GenerateInvoicePdfParams): Promise<{ buffer: Buffer; total: number }> {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", reject);
  });

  doc.fontSize(20).text("Invoice", { align: "right" });
  doc.fontSize(10).text(`Invoice #${params.invoiceNumber}`, { align: "right" });
  if (params.dueDate) doc.text(`Due ${params.dueDate}`, { align: "right" });
  doc.moveDown(2);

  doc.fontSize(12).text(`From: ${params.sellerName}`);
  doc.text(`To: ${params.buyerName}`);
  doc.moveDown(1.5);

  doc.fontSize(10);
  const colX = { desc: 50, qty: 300, price: 370, total: 450 };
  doc.text("Description", colX.desc, doc.y, { continued: false });
  doc.text("Qty", colX.qty, doc.y - 12);
  doc.text("Unit price", colX.price, doc.y - 12);
  doc.text("Total", colX.total, doc.y - 12);
  doc.moveTo(50, doc.y + 4).lineTo(545, doc.y + 4).stroke();
  doc.moveDown(0.5);

  let total = 0;
  for (const item of params.lineItems) {
    const lineTotal = item.quantity * item.unitPrice;
    total += lineTotal;
    const rowY = doc.y;
    doc.text(item.description, colX.desc, rowY, { width: 240 });
    doc.text(String(item.quantity), colX.qty, rowY);
    doc.text(formatMoney(item.unitPrice, params.currency), colX.price, rowY);
    doc.text(formatMoney(lineTotal, params.currency), colX.total, rowY);
    doc.moveDown(0.75);
  }

  doc.moveDown(1);
  doc.fontSize(12).text(`Total: ${formatMoney(total, params.currency)}`, { align: "right" });

  if (params.notes) {
    doc.moveDown(2);
    doc.fontSize(9).text(params.notes);
  }

  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), total };
}

export const createGenerateInvoicePdfExecutor = (): NodeExecutor => async (_ctx, rawParams, inputs) => {
  let params: GenerateInvoicePdfParams;
  try {
    const defaults = rawParams !== null && typeof rawParams === "object" && !Array.isArray(rawParams)
      ? rawParams as Record<string, unknown>
      : {};
    params = generateInvoicePdfParamsSchema.parse({ ...defaults, ...upstreamRecord(inputs) });
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }

  try {
    const { buffer, total } = await renderInvoicePdf(params);
    return {
      ok: true,
      outputs: { result: {
        fileBase64: buffer.toString("base64"),
        fileName: invoiceFileName(params.invoiceNumber),
        mimeType: "application/pdf",
        byteCount: buffer.byteLength,
        totalAmount: total,
      } },
      costUsdc: 0,
    };
  } catch (e) {
    return { ok: false, error: `Failed to generate invoice: ${errMessage(e)}`, costUsdc: 0 };
  }
};

export const generateInvoicePdfNode = defineExecutableNode(getNodeDefinition("finance.generateInvoicePdf"), {
  paramsSchema: generateInvoicePdfParamsSchema,
  executor: createGenerateInvoicePdfExecutor(),
});
