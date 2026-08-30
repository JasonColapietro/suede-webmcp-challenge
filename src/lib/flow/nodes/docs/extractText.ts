/**
 * PDF text extraction. Local computation only: the caller gives this node
 * the file's bytes directly (base64), it never fetches a URL, so it carries
 * none of http.ts's SSRF surface. That is a deliberate scope line, not an
 * oversight — see the "Falls back to the upstream node's output" hint on
 * the fileBase64 field in node-definitions.ts.
 */
import { z } from "zod";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage, upstreamFileBase64 } from "../_util";

export const extractTextParamsSchema = z.object({
  fileBase64: z.string().optional(),
});

export type ExtractTextParams = z.infer<typeof extractTextParamsSchema>;

/** 10 MB decoded — generous for a text-bearing PDF, bounded against memory abuse. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export const createExtractTextExecutor = (): NodeExecutor => async (_ctx, rawParams, inputs) => {
  let params: ExtractTextParams;
  try {
    params = extractTextParamsSchema.parse(rawParams ?? {});
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }

  const source = params.fileBase64 ?? upstreamFileBase64(inputs);
  if (!source) {
    return { ok: false, error: "fileBase64 is required (or an upstream string output)", costUsdc: 0 };
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
  if (buffer.byteLength > MAX_PDF_BYTES) {
    return { ok: false, error: `PDF exceeds the ${MAX_PDF_BYTES}-byte size cap`, costUsdc: 0 };
  }

  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text, totalPages } = await extractPdfText(pdf, { mergePages: true });
    return {
      ok: true,
      outputs: { result: { text, pageCount: totalPages } },
      costUsdc: 0,
    };
  } catch (e) {
    return { ok: false, error: `Failed to parse PDF: ${errMessage(e)}`, costUsdc: 0 };
  }
};

export const extractTextNode = defineExecutableNode(getNodeDefinition("docs.extractText"), {
  paramsSchema: extractTextParamsSchema,
  executor: createExtractTextExecutor(),
});
