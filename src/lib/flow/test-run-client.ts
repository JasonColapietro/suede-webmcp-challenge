import type { TestRunResult } from "./test-runner-contract";
import {
  TEST_RUN_UI_LIMITS,
  parseTestRunResultEnvelope,
} from "./test-run-ui";

export interface ReadBoundedTestRunResponseOptions {
  readonly signal?: AbortSignal;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort and never delays the caller.
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // A locked or hostile body is treated as unusable.
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

function canonicalContentLength(value: string | null): number | null | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function readBoundedTestRunResponse(
  response: Response,
  options: ReadBoundedTestRunResponseOptions = {},
): Promise<TestRunResult | null> {
  try {
    const contentType = response.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const declared = canonicalContentLength(response.headers.get("content-length"));
    if (contentType !== "application/json" || declared === null ||
        (declared !== undefined && declared > TEST_RUN_UI_LIMITS.responseBytes)) {
      cancelBody(response.body);
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    if (options.signal?.aborted) {
      cancelReader(reader);
      return null;
    }

    const bytes = new Uint8Array(declared ?? TEST_RUN_UI_LIMITS.responseBytes);
    let total = 0;
    let chunks = 0;
    while (true) {
      const part = await readOrAbort(reader, options.signal);
      if (part === null) return null;
      if (part.done) break;
      chunks += 1;
      const chunkBytes = part.value.byteLength;
      const remaining = bytes.byteLength - total;
      if (chunkBytes === 0 || chunks > TEST_RUN_UI_LIMITS.responseChunks || chunkBytes > remaining) {
        cancelReader(reader);
        return null;
      }
      bytes.set(part.value, total);
      total += chunkBytes;
    }
    if (declared !== undefined && total !== declared) {
      cancelReader(reader);
      return null;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
    const envelope: unknown = JSON.parse(text) as unknown;
    return parseTestRunResultEnvelope(envelope);
  } catch {
    return null;
  }
}
