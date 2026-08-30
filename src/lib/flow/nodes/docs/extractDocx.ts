/**
 * DOCX text extraction. Local computation only, same scope line as
 * extractText.ts: bytes given directly, no URL fetch, no SSRF surface.
 */
import { z } from "zod";
import * as mammoth from "mammoth";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage, upstreamFileBase64 } from "../_util";

export const extractDocxParamsSchema = z.object({
  fileBase64: z.string().optional(),
});

export type ExtractDocxParams = z.infer<typeof extractDocxParamsSchema>;

/** 10 MB decoded — generous for a text-bearing document, bounded against memory abuse. */
export const MAX_DOCX_BYTES = 10 * 1024 * 1024;

export const createExtractDocxExecutor = (): NodeExecutor => async (_ctx, rawParams, inputs) => {
  let params: ExtractDocxParams;
  try {
    params = extractDocxParamsSchema.parse(rawParams ?? {});
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
  if (buffer.byteLength > MAX_DOCX_BYTES) {
    return { ok: false, error: `DOCX exceeds the ${MAX_DOCX_BYTES}-byte size cap`, costUsdc: 0 };
  }

  try {
    const result = await mammoth.extractRawText({ buffer });
    return { ok: true, outputs: { result: { text: result.value } }, costUsdc: 0 };
  } catch (e) {
    return { ok: false, error: `Failed to parse DOCX: ${errMessage(e)}`, costUsdc: 0 };
  }
};

export const extractDocxNode = defineExecutableNode(getNodeDefinition("docs.extractDocx"), {
  paramsSchema: extractDocxParamsSchema,
  executor: createExtractDocxExecutor(),
});
