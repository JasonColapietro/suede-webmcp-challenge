import { NextResponse } from "next/server";
import type { z } from "zod";
import { UnauthenticatedOwnerError } from "@/lib/auth";
import { ProjectStoreUnavailableError } from "./provider";
import { mutationValueWithinBudget } from "@/lib/flow/flow-mutation-service";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
} as const;

export function privateJson(
  body: Readonly<object>,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): NextResponse {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", PRIVATE_HEADERS["Cache-Control"]);
  return NextResponse.json(body, { status, headers: responseHeaders });
}

export function notFoundResponse(): NextResponse {
  return privateJson({ error: "not found" }, 404);
}

export function invalidRequestResponse(): NextResponse {
  return privateJson({ error: "invalid request" }, 400);
}

export function projectApiErrorResponse(error: unknown): NextResponse {
  if (error instanceof UnauthenticatedOwnerError) {
    return privateJson({ error: "Authentication required" }, 401);
  }
  if (error instanceof ProjectStoreUnavailableError) {
    return privateJson({ error: "project store unavailable" }, 503);
  }
  return privateJson({ error: "internal server error" }, 500);
}

export type ParsedRequest<Value> =
  | { readonly ok: true; readonly data: Value }
  | { readonly ok: false };

export interface ReadJsonRequestOptions {
  readonly signal?: AbortSignal;
}

export async function parseJsonRequest<Value>(
  request: Request,
  schema: z.ZodType<Value>,
): Promise<ParsedRequest<Value>> {
  const read = await readBoundedJsonRequest(request);
  if (!read.ok) return read;
  const parsed = schema.safeParse(read.data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
}

export async function readBoundedJsonRequest(
  request: Request,
  options: ReadJsonRequestOptions = {},
): Promise<ParsedRequest<unknown>> {
  const read = await readCappedJsonRequest(request, options);
  if (!read.ok || !parsedJsonWithinBudget(read.data)) return { ok: false };
  return read;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort; the caller must not wait on a hostile body source.
  }
}

async function readOrAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array> | null> {
  if (!signal) return reader.read();
  if (signal.aborted) {
    cancelReader(reader);
    return null;
  }
  const pending = reader.read();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([pending, aborted]);
    if (result === null) {
      void pending.catch(() => undefined);
      cancelReader(reader);
    }
    return result;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Byte-capped JSON decode for privacy-ordered routes that must owner-check before deep validation. */
export async function readCappedJsonRequest(
  request: Request,
  options: ReadJsonRequestOptions = {},
): Promise<ParsedRequest<unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { ok: false };
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PRIVATE_JSON_BYTES)) {
    return { ok: false };
  }
  let body: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) return { ok: false };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const part = await readOrAbort(reader, options.signal);
      if (part === null) return { ok: false };
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_PRIVATE_JSON_BYTES) {
        cancelReader(reader);
        return { ok: false };
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false };
  }
  return { ok: true, data: body };
}

export function parsedJsonWithinBudget(value: unknown): boolean {
  return mutationValueWithinBudget(value);
}

const MAX_PRIVATE_JSON_BYTES = 2 * 1024 * 1024;
