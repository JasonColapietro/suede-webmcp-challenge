import { z } from "zod";
import type { FlowImpactSummary } from "./flow-mutation-service";
import { sha256Utf8 } from "./subflow-reference";
import type { SupportedFlowGraph } from "./types";

function boundedJsonPayload(value: unknown, maximumBytes: number): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 4_096 || current.depth > 12) return false;
    if (current.value === null || typeof current.value !== "object") {
      let encoded: string | undefined;
      try { encoded = JSON.stringify(current.value); } catch { return false; }
      if (encoded === undefined) return false;
      bytes += new TextEncoder().encode(encoded).byteLength;
    } else {
      if (seen.has(current.value) || Object.getOwnPropertySymbols(current.value).length > 0) return false;
      const prototype = Object.getPrototypeOf(current.value);
      if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
      seen.add(current.value);
      const descriptors = Object.getOwnPropertyDescriptors(current.value);
      const entries = Object.entries(descriptors).filter(([key]) => !Array.isArray(current.value) || key !== "length");
      if (Array.isArray(current.value) && entries.length !== current.value.length) return false;
      bytes += 2 + Math.max(0, entries.length - 1);
      for (const [key, descriptor] of entries) {
        if (!("value" in descriptor) || !descriptor.enumerable) return false;
        if (!Array.isArray(current.value)) bytes += new TextEncoder().encode(JSON.stringify(key)).byteLength + 1;
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }
    if (bytes > maximumBytes) return false;
  }
  return true;
}

const ImpactReceiptSchema = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/);

const ImpactPayloadSchema = z.object({
  error: z.literal("impact confirmation required"),
  receipt: ImpactReceiptSchema,
  impact: z.object({
    dependents: z.array(z.object({
      flowId: z.string().min(1).max(512),
      name: z.string().max(200),
      nodeIds: z.array(z.string().min(1).max(128)).max(50),
    }).strict()).max(50),
    truncated: z.boolean(),
    total: z.number().int().safe().nonnegative().max(1_000),
  }).strict().superRefine((impact, context) => {
    if (impact.total < impact.dependents.length ||
        (!impact.truncated && impact.total !== impact.dependents.length)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid impact total", path: ["total"] });
    }
  }),
}).strict();

export class ImpactRequiredError extends Error {
  readonly status = 409;

  private constructor(
    readonly receipt: string,
    readonly impact: FlowImpactSummary,
  ) {
    super("Impact confirmation required");
    this.name = "ImpactRequiredError";
  }

  static parse(status: number, value: unknown): ImpactRequiredError | null {
    if (status !== 409 || !boundedJsonPayload(value, 64 * 1024)) return null;
    const parsed = ImpactPayloadSchema.safeParse(value);
    return parsed.success
      ? new ImpactRequiredError(parsed.data.receipt, parsed.data.impact)
      : null;
  }
}

export class FlowSaveBlockedError extends Error {
  constructor(readonly failedRevision: number, options?: ErrorOptions) {
    super("A previous save attempt failed before this revision could be saved", options);
    this.name = "FlowSaveBlockedError";
  }
}

export interface FlowSaveTransport {
  create(graph: SupportedFlowGraph): Promise<string>;
  update(rowId: string, graph: SupportedFlowGraph, impactReceipt?: string): Promise<void>;
}

export interface SaveRecord {
  readonly revision: number;
  readonly graph: SupportedFlowGraph;
  readonly fingerprint: string;
  readonly impactReceipt?: string;
}

export interface ImpactPendingState {
  readonly revision: number;
  readonly fingerprint: string;
  readonly receipt: string;
  readonly impact: FlowImpactSummary;
}

function cloneImpactPending(state: ImpactPendingState | null): ImpactPendingState | null {
  if (state === null) return null;
  return {
    ...state,
    impact: {
      ...state.impact,
      dependents: state.impact.dependents.map((dependent) => ({
        ...dependent,
        nodeIds: [...dependent.nodeIds],
      })),
    },
  };
}

/**
 * Deterministic JSON: object keys sorted by code point, arrays left alone
 * (node and edge order is meaningful), `undefined` members dropped exactly as
 * JSON.stringify drops them.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/**
 * Identity of a graph's content, independent of key order.
 *
 * The studio compares this against fingerprints of graphs that have been
 * through the server, and the server stores `parseSupportedFlowGraph(graph)` —
 * a zod-rebuilt object whose keys follow the schema's declaration order, not
 * the order the editor produced. Hashing raw `JSON.stringify` output therefore
 * reported every saved graph as different from itself, which left the studio
 * permanently "dirty" and made the recovery dialog claim a conflict on every
 * load. Canonical ordering makes equal graphs hash equal.
 */
export function flowSaveFingerprint(graph: SupportedFlowGraph): string {
  return sha256Utf8(canonicalJson(graph));
}

export interface FlowSaveCoordinatorCallbacks {
  onCreated?: (rowId: string) => void;
  onSavingChange?: (saving: boolean) => void;
  onError?: (error: unknown | null) => void;
  onImpactPendingChange?: (pending: ImpactPendingState | null) => void;
  onPersisted?: (event: FlowPersistedEvent) => void;
}

export interface FlowPersistedEvent {
  readonly rowId: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly current: boolean;
}

export interface FlowSaveRecoveryState {
  readonly scheduled: boolean;
  readonly inflight: boolean;
  readonly retryable: boolean;
  readonly impact: boolean;
}

export class FlowSaveQueue {
  private persistedId: string | null;
  private pending: QueueEntry[] = [];
  private draining: Promise<void> | null = null;

  constructor(
    persistedId: string | null,
    private readonly transport: FlowSaveTransport,
    private readonly onCreated?: (rowId: string) => void,
  ) {
    this.persistedId = persistedId;
  }

  getPersistedId(): string | null {
    return this.persistedId;
  }

  enqueue(record: SaveRecord): Promise<SaveRecord> {
    const graph = structuredClone(record.graph);
    if (!Number.isSafeInteger(record.revision) || record.revision < 1 ||
        flowSaveFingerprint(graph) !== record.fingerprint ||
        (record.impactReceipt !== undefined &&
          (this.persistedId === null || !ImpactReceiptSchema.safeParse(record.impactReceipt).success))) {
      return Promise.reject(new Error("Invalid save record"));
    }
    const accepted: SaveRecord = { ...record, graph };
    const last = this.pending.at(-1);
    let resolveAttempt!: (saved: SaveRecord) => void;
    let rejectAttempt!: (error: unknown) => void;
    const outcome = new Promise<SaveRecord>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const waiter = { resolve: resolveAttempt, reject: rejectAttempt };
    if (last !== undefined && accepted.impactReceipt === undefined && last.record.impactReceipt === undefined) {
      last.record = accepted;
      last.waiters.push(waiter);
    } else {
      this.pending.push({ record: accepted, waiters: [waiter] });
    }
    this.ensureDraining();
    return outcome;
  }

  async waitForIdle(): Promise<void> {
    while (this.draining !== null) await this.draining;
  }

  private ensureDraining(): void {
    if (this.draining !== null || !this.pending.some((entry) => entry.waiters.length > 0)) return;
    const tracked: Promise<void> = this.drain().finally(() => {
      if (this.draining !== tracked) return;
      this.draining = null;
      this.ensureDraining();
    });
    this.draining = tracked;
    void tracked.catch(() => undefined);
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const entry = this.pending.shift()!;
      const next = entry.record;
      try {
        if (this.persistedId === null) {
          const rowId = await this.transport.create(next.graph);
          this.persistedId = rowId;
          this.onCreated?.(rowId);
        } else {
          if (next.impactReceipt === undefined) {
            await this.transport.update(this.persistedId, next.graph);
          } else {
            await this.transport.update(this.persistedId, next.graph, next.impactReceipt);
          }
        }
        for (const waiter of entry.waiters) waiter.resolve(next);
      } catch (error) {
        const failure = new SaveAttemptFailure(next, error);
        for (const waiter of entry.waiters) waiter.reject(failure);
        for (const blocked of this.pending) {
          const blockedFailure = new SaveAttemptFailure(
            blocked.record,
            new FlowSaveBlockedError(next.revision, { cause: error }),
          );
          for (const waiter of blocked.waiters) waiter.reject(blockedFailure);
          blocked.waiters = [];
        }
        this.pending = [];
        throw failure;
      }
    }
  }
}

interface QueueWaiter {
  readonly resolve: (saved: SaveRecord) => void;
  readonly reject: (error: unknown) => void;
}

interface QueueEntry {
  record: SaveRecord;
  waiters: QueueWaiter[];
}

class SaveAttemptFailure extends Error {
  constructor(readonly record: SaveRecord, readonly reason: unknown) {
    super("Save attempt failed", { cause: reason });
    this.name = "SaveAttemptFailure";
  }
}

export class FlowSaveCoordinator {
  private readonly queue: FlowSaveQueue;
  private pending: SaveRecord | null = null;
  private latest: SaveRecord | null = null;
  private retryable: SaveRecord | null = null;
  private impactPending: ImpactPendingState | null = null;
  private impactConfirmation: { readonly revision: number; readonly fingerprint: string; readonly promise: Promise<void> } | null = null;
  private impactPublications: Array<ImpactPendingState | null> = [];
  private publishingImpact = false;
  private revision = 0;
  private activeSaveRequests = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private mounted = true;

  constructor(
    persistedId: string | null,
    transport: FlowSaveTransport,
    private readonly callbacks: FlowSaveCoordinatorCallbacks = {},
    private readonly debounceMs = 800,
  ) {
    this.queue = new FlowSaveQueue(persistedId, transport, (rowId) => {
      this.flushScheduled();
      if (this.mounted) {
        this.callbacks.onCreated?.(rowId);
      }
    });
  }

  saveNow(graph: SupportedFlowGraph): Promise<void> {
    const record = this.register(graph);
    this.clearScheduled();
    const saving = this.enqueue(record);
    this.flushImpactPublications();
    return saving;
  }

  schedule(graph: SupportedFlowGraph): void {
    this.pending = this.register(graph);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushScheduled();
    }, this.debounceMs);
    this.flushImpactPublications();
  }

  supersedeWithoutSaving(graph: SupportedFlowGraph): void {
    const record = this.register(graph);
    this.clearScheduled();
    this.retryable = record;
    this.flushImpactPublications();
  }

  acceptAuthoritative(graph: SupportedFlowGraph): boolean {
    if (this.activeSaveRequests > 0) return false;
    const snapshot = structuredClone(graph);
    this.clearScheduled();
    this.revision += 1;
    this.latest = {
      revision: this.revision,
      graph: snapshot,
      fingerprint: flowSaveFingerprint(snapshot),
    };
    this.retryable = null;
    this.setImpactPending(null);
    this.impactConfirmation = null;
    this.flushImpactPublications();
    return true;
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.setImpactPending(this.impactPending, true);
    this.flushImpactPublications();
  }

  async waitForIdle(): Promise<void> {
    await this.queue.waitForIdle();
  }

  async dispose(): Promise<void> {
    this.mounted = false;
    this.impactPublications = [];
    this.flushScheduled();
    try {
      await this.queue.waitForIdle();
    } catch {
      // The queue's attached rejection handler consumes this after UI teardown.
    }
  }

  hasRetryableGraph(): boolean {
    return this.retryable !== null;
  }

  recoveryState(): FlowSaveRecoveryState {
    return {
      scheduled: this.pending !== null || this.timer !== null,
      inflight: this.activeSaveRequests > 0,
      retryable: this.retryable !== null,
      impact: this.impactPending !== null,
    };
  }

  getImpactPending(): ImpactPendingState | null {
    return cloneImpactPending(this.impactPending);
  }

  retryLatest(): Promise<void> {
    const record = this.retryable;
    if (record === null) return Promise.resolve();
    this.clearScheduled();
    return this.enqueue(record);
  }

  confirmImpact(): Promise<void> {
    const pending = this.impactPending;
    const latest = this.latest;
    if (pending === null || latest === null ||
        pending.revision !== latest.revision || pending.fingerprint !== latest.fingerprint) {
      return Promise.resolve();
    }
    if (this.impactConfirmation?.revision === pending.revision &&
        this.impactConfirmation.fingerprint === pending.fingerprint) {
      return this.impactConfirmation.promise;
    }
    this.clearScheduled();
    const confirmed: SaveRecord = { ...latest, impactReceipt: pending.receipt };
    const promise = this.enqueue(confirmed).finally(() => {
      if (this.impactConfirmation?.promise === promise) this.impactConfirmation = null;
    });
    this.impactConfirmation = { revision: pending.revision, fingerprint: pending.fingerprint, promise };
    return promise;
  }

  private register(graph: SupportedFlowGraph): SaveRecord {
    const snapshot = structuredClone(graph);
    const record = { revision: ++this.revision, graph: snapshot, fingerprint: flowSaveFingerprint(snapshot) };
    this.setImpactPending(null);
    this.impactConfirmation = null;
    this.latest = record;
    if (this.retryable !== null) this.retryable = record;
    return record;
  }

  private clearScheduled(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  private flushScheduled(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const next = this.pending;
    this.pending = null;
    if (next !== null) {
      void this.enqueue(next).catch(() => undefined);
    }
  }

  private enqueue(record: SaveRecord): Promise<void> {
    this.activeSaveRequests += 1;
    if (this.mounted) {
      this.callbacks.onError?.(null);
      if (this.activeSaveRequests === 1) this.callbacks.onSavingChange?.(true);
    }
    const queued = this.queue.enqueue(record);
    const saving = queued.then(
      () => undefined,
      (error: unknown) => { throw error instanceof SaveAttemptFailure ? error.reason : error; },
    );
    void queued.then(
      (saved) => {
        if (saved.revision === record.revision && saved.fingerprint === record.fingerprint) {
          if (this.impactPending?.revision === saved.revision &&
              this.impactPending.fingerprint === saved.fingerprint) {
            this.setImpactPending(null);
          }
          if (
            this.retryable !== null &&
            this.retryable.revision <= saved.revision &&
            (this.latest?.revision ?? 0) <= saved.revision
          ) {
            this.retryable = null;
          }
          const latest = this.latest;
          const rowId = this.queue.getPersistedId();
          if (this.mounted && rowId !== null) {
            try {
              this.callbacks.onPersisted?.({
                rowId,
                revision: saved.revision,
                fingerprint: saved.fingerprint,
                current: latest?.revision === saved.revision && latest.fingerprint === saved.fingerprint,
              });
            } catch {
              // Recovery observers cannot interrupt successful persistence.
            }
          }
        }
        this.finishSavingRequest();
        this.flushImpactPublications();
      },
      (error: unknown) => {
        const failure = error instanceof SaveAttemptFailure ? error : new SaveAttemptFailure(record, error);
        if (failure.record.revision !== record.revision || failure.record.fingerprint !== record.fingerprint) {
          this.finishSavingRequest();
          return;
        }
        const reason = failure.reason;
        if (reason instanceof ImpactRequiredError) {
          const latest = this.latest;
          if (latest?.revision === failure.record.revision && latest.fingerprint === failure.record.fingerprint) {
            this.setImpactPending({
              revision: failure.record.revision,
              fingerprint: failure.record.fingerprint,
              receipt: reason.receipt,
              impact: reason.impact,
            });
            this.retryable = null;
          } else {
            this.retryable = latest ?? null;
          }
        } else if (failure.record.impactReceipt !== undefined) {
          if (this.impactPending?.revision === failure.record.revision &&
              this.impactPending.fingerprint === failure.record.fingerprint) {
            this.setImpactPending(null);
          }
          const latest = this.latest;
          if (latest?.revision === failure.record.revision &&
              latest.fingerprint === failure.record.fingerprint) {
            this.retryable = latest;
          } else if (this.retryable?.revision !== latest?.revision ||
              this.retryable?.fingerprint !== latest?.fingerprint) {
            this.retryable = null;
          }
        } else {
          this.retryable = this.latest ?? failure.record;
        }
        if (this.mounted) {
          this.callbacks.onError?.(reason);
        }
        this.finishSavingRequest();
        this.flushImpactPublications();
      },
    );
    return saving;
  }

  private finishSavingRequest(): void {
    this.activeSaveRequests = Math.max(0, this.activeSaveRequests - 1);
    if (this.mounted && this.activeSaveRequests === 0) this.callbacks.onSavingChange?.(false);
  }

  private setImpactPending(next: ImpactPendingState | null, forcePublication = false): void {
    const previous = this.impactPending;
    this.impactPending = cloneImpactPending(next);
    if (this.mounted && (forcePublication || previous !== null || next !== null)) {
      this.impactPublications.push(cloneImpactPending(this.impactPending));
    }
  }

  private flushImpactPublications(): void {
    if (!this.mounted || this.publishingImpact) return;
    this.publishingImpact = true;
    try {
      while (this.mounted && this.impactPublications.length > 0) {
        const pending = this.impactPublications.shift() ?? null;
        try {
          this.callbacks.onImpactPendingChange?.(cloneImpactPending(pending));
        } catch {
          // UI observers cannot interrupt coordinator state transitions.
        }
      }
    } finally {
      this.publishingImpact = false;
    }
  }
}
