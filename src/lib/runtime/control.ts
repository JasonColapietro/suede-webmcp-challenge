import { randomUUID } from "node:crypto";
import type { DurableRuntimeRepository, RetryExecutionResult } from "./repository";
import type { DurableExecutionEventV1, DurableExecutionProjection } from "./types";
import { sseEventFrame } from "./api-contract";

export type DurableControlResult =
  | Readonly<{ status: "applied" | "idempotent"; execution: DurableExecutionProjection }>
  | RetryExecutionResult
  | Readonly<{ status: "conflict" | "not-found" | "refused" }>;

export async function applyDurableAction(input: Readonly<{
  repository: DurableRuntimeRepository;
  ownerId: string;
  executionId: string;
  action: "cancel" | "pause" | "resume" | "retry";
  idempotencyKey?: string;
  idFactory?: () => string;
  expiresAt?: number;
}>): Promise<DurableControlResult> {
  if (input.action !== "retry") return input.repository.controlExecution(input.ownerId, input.executionId, input.action);
  if (!input.idempotencyKey || !Number.isSafeInteger(input.expiresAt)) return { status: "refused" };
  const id = input.idFactory ?? randomUUID;
  return input.repository.retryExecution({
    ownerId: input.ownerId, sourceExecutionId: input.executionId,
    executionId: id(), jobId: id(), idempotencyKey: input.idempotencyKey,
    expiresAt: input.expiresAt!,
  });
}

const TERMINAL = new Set<DurableExecutionProjection["state"]>(["succeeded", "failed", "cancelled", "dead"]);

export function createPersistedEventStream(input: Readonly<{
  repository: DurableRuntimeRepository;
  ownerId: string;
  executionId: string;
  after: number;
  signal: AbortSignal;
  pageSize?: number;
  maximumEvents?: number;
  maximumBytes?: number;
  maximumDurationMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>): ReadableStream<Uint8Array> {
  const pageSize = input.pageSize ?? 100;
  const maximumEvents = input.maximumEvents ?? 1_000;
  const maximumBytes = input.maximumBytes ?? 512 * 1024;
  const maximumDurationMs = input.maximumDurationMs ?? 25_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const now = input.now ?? Date.now;
  const wait = input.wait ?? ((milliseconds, signal) => new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, milliseconds);
    function done(): void { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  }));
  const encoder = new TextEncoder();
  const internal = new AbortController();
  const abortInternal = (): void => internal.abort();
  input.signal.addEventListener("abort", abortInternal, { once: true });
  if (input.signal.aborted) internal.abort();
  return new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      let closed = false;
      const close = (): void => { if (!closed) { closed = true; try { controller.close(); } catch {} } };
      if (internal.signal.aborted) { close(); input.signal.removeEventListener("abort", abortInternal); return; }
      let cursor = input.after; let eventCount = 0; let byteCount = 0;
      const startedAt = now();
      try {
        while (!internal.signal.aborted && eventCount < maximumEvents && now() - startedAt <= maximumDurationMs) {
          const limit = Math.min(pageSize, maximumEvents - eventCount);
          const page = await input.repository.listEvents(input.ownerId, input.executionId, cursor, limit);
          if (internal.signal.aborted) break;
          if (!orderedStoredEvents(page, cursor) || page.some((event) => event.executionId !== input.executionId)) break;
          for (const event of page) {
            const bytes = encoder.encode(sseEventFrame(event));
            if (byteCount + bytes.byteLength > maximumBytes) { close(); return; }
            controller.enqueue(bytes); byteCount += bytes.byteLength; eventCount += 1; cursor = event.sequence;
          }
          if (page.length === limit) continue;
          const view = await input.repository.getExecutionView(input.ownerId, input.executionId);
          if (internal.signal.aborted || !view) break;
          if (TERMINAL.has(view.projection.state) && view.projection.sequence === cursor) break;
          if (view.projection.sequence > cursor) continue;
          if (view.projection.sequence < cursor) break;
          await wait(pollIntervalMs, internal.signal);
        }
      } catch {
        // Private streams fail closed without reflecting repository details.
      } finally {
        input.signal.removeEventListener("abort", abortInternal);
        close();
      }
    },
    cancel(): void { internal.abort(); input.signal.removeEventListener("abort", abortInternal); },
  });
}

export function orderedStoredEvents(events: readonly DurableExecutionEventV1[], after: number): boolean {
  let expected = after + 1;
  for (const event of events) { if (event.sequence !== expected) return false; expected += 1; }
  return true;
}
