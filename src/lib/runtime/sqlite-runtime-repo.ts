import Database from "better-sqlite3";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { parseDurableExecutionEvent } from "./event-schema";
import { foldExecutionEvents } from "./projection";
import type {
  AppendLeasedEventInput,
  ClaimNextJobInput,
  ClaimNextJobResult,
  ControlExecutionResult,
  CreateExecutionInput,
  CreateExecutionResult,
  DurableRuntimeRepository,
  DurableExecutionOwnerView,
  HeartbeatResult,
  LeaseIdentity,
  LeasedTransitionResult,
  RebuildProjectionResult,
  RetryExecutionResult,
} from "./repository";
import type { DurableExecutionEventV1, DurableExecutionProjection, DurableJsonValue } from "./types";
import { decideRetry, type FailureClassification } from "./retry-policy";
import { parseDurableInvocationJson } from "./invocation";

const MAX_DEFINITION_BYTES = 256 * 1024;
const MAX_ID_LENGTH = 512;
const MAX_EVENT_READ = 1_000;
const MAX_RECOVERY_BATCH = 100;
const MAX_TRANSITION_HISTORY = 10_514;
const MAX_NEW_EVENT_COUNT = 4_096;
const MAX_TRANSITION_HISTORY_BYTES = 8_960 * 1024;
const MAX_TOTAL_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_NODE_EVENT_BYTES = 48 * 1024;
const TERMINAL_EVENT_HEADROOM_BYTES = 256 * 1024;
const TERMINAL_EVENT_HEADROOM_COUNT = 512;
const SETTLEMENT_EVENT_TYPES = new Set<DurableExecutionEventV1["type"]>([
  "execution.paused", "execution.succeeded", "execution.failed", "execution.cancelled", "execution.dead_lettered",
]);
const POLICY_ERROR = "durable_policy_refused";
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

class DurableEventBudgetError extends Error {}

function keyMaterial(value: string | Uint8Array): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (bytes.byteLength < 32 || new Set(bytes).size < 8) throw new TypeError("A strong idempotency hash key is required");
  return bytes;
}

function validId(value: unknown, maximum = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) && !UNSAFE_KEYS.has(value);
}

function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function canonicalValue(value: unknown, depth: number, ancestors: Set<object>): DurableJsonValue {
  if (depth > 32) throw new Error("Invalid durable JSON");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid durable JSON");
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("Invalid durable JSON");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("Invalid durable JSON");
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || Reflect.ownKeys(value).length !== length + 1) throw new Error("Invalid durable JSON");
      const result: DurableJsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Invalid durable JSON");
        result.push(canonicalValue(descriptor.value, depth + 1, ancestors));
      }
      return result;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Invalid durable JSON");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || UNSAFE_KEYS.has(key))) throw new Error("Invalid durable JSON");
    const result: Record<string, DurableJsonValue> = {};
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Invalid durable JSON");
      result[key] = canonicalValue(descriptor.value, depth + 1, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown, maximumBytes: number): string {
  const result = JSON.stringify(canonicalValue(value, 0, new Set()));
  if (Buffer.byteLength(result, "utf8") > maximumBytes) throw new Error("Invalid durable JSON");
  return result;
}

interface EventRow {
  execution_id: string;
  seq: number;
  schema_version: number;
  attempt: number;
  type: DurableExecutionEventV1["type"];
  at: number;
  payload_json: string;
}

function eventFromRow(row: EventRow): DurableExecutionEventV1 {
  return parseDurableExecutionEvent({
    schemaVersion: row.schema_version,
    executionId: row.execution_id,
    sequence: row.seq,
    attempt: row.attempt,
    type: row.type,
    at: row.at,
    payload: JSON.parse(row.payload_json) as unknown,
  });
}

function projectionJson(projection: DurableExecutionProjection): string {
  return canonicalJson(projection, MAX_DEFINITION_BYTES);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function validLeaseIdentity(input: LeaseIdentity): boolean {
  return Boolean(input) && validId(input.jobId, 256) && validId(input.attemptId, 256) && /^[a-f0-9]{64}$/u.test(input.leaseToken);
}

interface LeasedRow {
  execution_id: string; attempt_number: number; max_attempts: number; projected_event_seq: number;
  desired_state: "running" | "paused" | "cancelled"; cost_micro_usdc: number; token_count: number;
  lease_expires_at: number; heartbeat_at: number;
  total_event_bytes: number; node_event_bytes: number;
}

function requestFingerprint(input: CreateExecutionInput, frozenDefinitionJson: string, invocationJson: string, invocationHash: string): string {
  const digest = createHash("sha256");
  digest.update("durable-runtime:create-request:v1\0", "utf8");
  const component = (label: string, value: string): void => {
    const labelBytes = Buffer.from(label, "utf8");
    const valueBytes = Buffer.from(value, "utf8");
    const frame = Buffer.alloc(16);
    frame.writeBigUInt64BE(BigInt(labelBytes.byteLength), 0);
    frame.writeBigUInt64BE(BigInt(valueBytes.byteLength), 8);
    digest.update(frame).update(labelBytes).update(valueBytes);
  };
  component("definition", frozenDefinitionJson);
  component("identity", canonicalJson({ definitionHash: input.definitionHash, flowId: input.flowId, flowVersionId: input.flowVersionId }, 8 * 1024));
  component("trigger", canonicalJson(input.trigger, 8 * 1024));
  component("queue", canonicalJson({ availableAt: input.availableAt, maxAttempts: input.maxAttempts, priority: input.priority }, 8 * 1024));
  component("limits", canonicalJson({ costBudgetMicroUsdc: input.costBudgetMicroUsdc, deadlineAt: input.deadlineAt ?? null, tokenBudget: input.tokenBudget }, 8 * 1024));
  component("invocation", invocationJson);
  component("invocation-hash", invocationHash);
  return digest.digest("hex");
}

function validCreateInput(input: CreateExecutionInput): boolean {
  return Boolean(input?.invocation) && typeof input.invocation.json === "string" && typeof input.invocation.hash === "string" &&
    validId(input.ownerId) && validId(input.executionId, 256) && validId(input.jobId, 256) &&
    validId(input.flowId) && validId(input.flowVersionId) && /^[a-f0-9]{64}$/u.test(input.definitionHash) &&
    validId(input.idempotency.namespace, 128) && validId(input.idempotency.key, 4096) &&
    safeInteger(input.priority) && safeInteger(input.availableAt) && safeInteger(input.maxAttempts, 1, 100) &&
    safeInteger(input.costBudgetMicroUsdc) && safeInteger(input.tokenBudget) && safeInteger(input.createdAt) &&
    safeInteger(input.idempotency.expiresAt, input.createdAt) && (input.deadlineAt === undefined || safeInteger(input.deadlineAt, input.createdAt)) &&
    ["api", "schedule", "webhook", "retry", "fork"].includes(input.trigger.type) && (input.trigger.id === undefined || validId(input.trigger.id));
}

export class SqliteDurableRuntimeRepository implements DurableRuntimeRepository {
  private readonly db: Database.Database;
  private readonly idempotencyHashKey: Buffer;
  private readonly ownsConnection: boolean;
  private readonly clock: () => number;

  constructor(source: string | Database.Database, options: Readonly<{ idempotencyHashKey: string | Uint8Array; clock?: () => number }>) {
    if (typeof source === "string" && !validId(source, 4096)) throw new TypeError("An explicit SQLite database path is required");
    if (options?.clock !== undefined && typeof options.clock !== "function") throw new TypeError("A trusted durable runtime clock is required");
    this.idempotencyHashKey = keyMaterial(options?.idempotencyHashKey);
    this.clock = options.clock ?? Date.now;
    this.ownsConnection = typeof source === "string";
    this.db = typeof source === "string" ? new Database(source) : source;
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    if (typeof source === "string") {
      const mode = this.db.pragma("journal_mode = WAL", { simple: true }) as unknown;
      const allowed = source === ":memory:" ? mode === "memory" : mode === "wal";
      if (!allowed) {
        this.db.close();
        throw new Error("SQLite WAL mode is required for persistent durable runtime repositories");
      }
    }
    runSqliteMigrations(this.db);
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  private keyHash(key: string): string {
    return createHmac("sha256", this.idempotencyHashKey).update("durable-runtime:idempotency-key:v1\0", "utf8").update(key, "utf8").digest("hex");
  }

  private leaseTokenHash(token: string): string {
    return createHash("sha256").update("durable-runtime:lease-token:v1\0", "utf8").update(token, "ascii").digest("hex");
  }

  private trustedNow(): number {
    const now = this.clock();
    if (!safeInteger(now)) throw new TypeError("Invalid trusted durable runtime clock");
    return now;
  }

  private appendProjectionEvents(executionId: string, events: readonly DurableExecutionEventV1[]): DurableExecutionProjection {
    const projection = foldExecutionEvents([...this.readAllEvents(executionId, MAX_TRANSITION_HISTORY, MAX_TRANSITION_HISTORY_BYTES), ...events]);
    let materialized: string;
    try { materialized = projectionJson(projection); } catch { throw new DurableEventBudgetError("Durable projection budget exhausted"); }
    const usage = this.db.prepare("SELECT total_event_bytes, node_event_bytes, total_event_limit, node_event_limit, event_count, event_count_limit FROM execution_event_usage WHERE execution_id = ? AND schema_version = 1").get(executionId) as { total_event_bytes: number; node_event_bytes: number; total_event_limit: number; node_event_limit: number; event_count: number; event_count_limit: number } | undefined;
    if (!usage) throw new Error("Durable event usage is unavailable");
    const payloads = events.map((event) => canonicalJson(event.payload, 256 * 1024));
    const addedTotal = payloads.reduce((total, payload) => total + Buffer.byteLength(payload, "utf8"), 0);
    const addedNode = events.reduce((total, event, index) => total + (event.type.startsWith("node.") ? Buffer.byteLength(payloads[index]!, "utf8") : 0), 0);
    const nextTotal = usage.total_event_bytes + addedTotal;
    const nextNode = usage.node_event_bytes + addedNode;
    const terminalizing = events.some((event) => SETTLEMENT_EVENT_TYPES.has(event.type));
    if (!safeInteger(nextTotal, 0, usage.total_event_limit) || !safeInteger(nextNode, 0, usage.node_event_limit) || usage.event_count + events.length > usage.event_count_limit ||
        (!terminalizing && (nextTotal > usage.total_event_limit - TERMINAL_EVENT_HEADROOM_BYTES ||
          usage.event_count + events.length > usage.event_count_limit - TERMINAL_EVENT_HEADROOM_COUNT))) {
      throw new DurableEventBudgetError("Durable event budget exhausted");
    }
    const insert = this.db.prepare("INSERT INTO execution_events (execution_id, seq, schema_version, attempt, type, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
    events.forEach((event, index) => insert.run(event.executionId, event.sequence, event.schemaVersion, event.attempt, event.type, event.at, payloads[index]));
    const last = events[events.length - 1];
    if (!last) throw new Error("A durable transition requires an event");
    const changed = this.db.prepare(
      `UPDATE durable_executions SET state = ?, desired_state = ?, next_event_seq = ?, projected_event_seq = ?, projection_json = ?,
       result_json = ?, error_text = ?, cost_micro_usdc = ?, token_count = ?, attempt_number = ?, updated_at = ?,
       finished_at = CASE WHEN ? IN ('succeeded','failed','cancelled','dead') THEN ? ELSE finished_at END
       WHERE id = ? AND projected_event_seq = ?`,
    ).run(projection.state, projection.desiredState, projection.sequence + 1, projection.sequence, materialized,
      projection.output === null ? null : canonicalJson(projection.output, 128 * 1024), projection.error,
      projection.costMicroUsdc, projection.tokens, projection.attempt, last.at,
      projection.state, last.at, executionId, events[0]!.sequence - 1);
    if (changed.changes !== 1) throw new Error("Durable projection sequence drift");
    const usageChanged = this.db.prepare("UPDATE execution_event_usage SET total_event_bytes = ?, node_event_bytes = ?, event_count = ?, updated_at = ? WHERE execution_id = ? AND total_event_bytes = ? AND node_event_bytes = ? AND event_count = ?").run(nextTotal, nextNode, usage.event_count + events.length, last.at, executionId, usage.total_event_bytes, usage.node_event_bytes, usage.event_count);
    if (usageChanged.changes !== 1) throw new Error("Durable event usage drift");
    return projection;
  }

  private liveLease(identity: LeaseIdentity, now: number): LeasedRow | undefined {
    return this.db.prepare(
      `SELECT j.execution_id, a.attempt_number, j.max_attempts, x.projected_event_seq, x.desired_state,
              x.cost_micro_usdc, x.token_count, j.lease_expires_at, j.heartbeat_at,
              u.total_event_bytes, u.node_event_bytes
       FROM execution_jobs j
       JOIN execution_attempts a ON a.job_id = j.id AND a.execution_id = j.execution_id
       JOIN durable_executions x ON x.id = j.execution_id
       JOIN execution_event_usage u ON u.execution_id = x.id AND u.schema_version = 1
       WHERE j.id = ? AND a.id = ? AND j.state = 'leased' AND a.state = 'leased'
         AND j.lease_token_hash = ? AND a.lease_token_hash = ? AND j.lease_expires_at > ?`,
    ).get(identity.jobId, identity.attemptId, this.leaseTokenHash(identity.leaseToken), this.leaseTokenHash(identity.leaseToken), now) as LeasedRow | undefined;
  }

  private readAllEvents(executionId: string, maximum = Number.MAX_SAFE_INTEGER, maximumBytes = Number.MAX_SAFE_INTEGER): DurableExecutionEventV1[] {
    const events: DurableExecutionEventV1[] = [];
    let payloadBytes = 0;
    let after = 0;
    while (true) {
      const rows = this.db.prepare(
        `SELECT execution_id, seq, schema_version, attempt, type, at, payload_json
         FROM execution_events WHERE execution_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      ).all(executionId, after, MAX_EVENT_READ) as EventRow[];
      if (rows.length === 0) break;
      for (const row of rows) payloadBytes += Buffer.byteLength(row.payload_json, "utf8");
      if (!Number.isSafeInteger(payloadBytes) || payloadBytes > maximumBytes) throw new Error("Durable transition history byte bound exceeded");
      const page = rows.map(eventFromRow);
      events.push(...page);
      if (events.length > maximum) throw new Error("Durable transition history bound exceeded");
      after = page[page.length - 1]!.sequence;
      if (rows.length < MAX_EVENT_READ) break;
    }
    return events;
  }

  private hydrateExecution(ownerId: string, executionId: string): DurableExecutionProjection | null {
    const hydrate = (): DurableExecutionProjection | null => {
      const row = this.db.prepare("SELECT projection_json FROM durable_executions WHERE id = ? AND owner_id = ?").get(executionId, ownerId) as { projection_json: string } | undefined;
      if (!row) return null;
      try {
        const projection = foldExecutionEvents(this.readAllEvents(executionId));
        return projectionJson(projection) === row.projection_json ? projection : null;
      } catch {
        return null;
      }
    };
    return this.db.inTransaction ? hydrate() : this.db.transaction(hydrate).deferred();
  }

  private hydrateExecutionView(ownerId: string, executionId: string): DurableExecutionOwnerView | null {
    const row = this.db.prepare(
      `SELECT id, flow_id, flow_version_id, parent_execution_id, created_at, updated_at, finished_at, deadline_at
       FROM durable_executions WHERE id = ? AND owner_id = ?`,
    ).get(executionId, ownerId) as { id: string; flow_id: string; flow_version_id: string; parent_execution_id: string | null; created_at: number; updated_at: number; finished_at: number | null; deadline_at: number | null } | undefined;
    if (!row) return null;
    const projection = this.hydrateExecution(ownerId, executionId);
    if (!projection) return null;
    return freezeDeep({
      executionId: row.id, flowId: row.flow_id, flowVersionId: row.flow_version_id,
      parentExecutionId: row.parent_execution_id, createdAt: row.created_at, updatedAt: row.updated_at,
      finishedAt: row.finished_at, deadlineAt: row.deadline_at, projection,
    });
  }

  async createExecution(input: CreateExecutionInput): Promise<CreateExecutionResult> {
    if (!validCreateInput(input)) return { status: "refused" };
    let callerDefinitionJson: string;
    try {
      callerDefinitionJson = canonicalJson(input.frozenDefinition, MAX_DEFINITION_BYTES);
    } catch {
      return { status: "refused" };
    }
    if (input.flowVersionId === "draft") return { status: "refused" };
    let invocationJson: string;
    let invocationHash: string;
    let invocationRootJson: string;
    try {
      invocationJson = input.invocation.json;
      invocationHash = input.invocation.hash;
      const parsedInvocation = parseDurableInvocationJson(invocationJson, invocationHash);
      const root = parsedInvocation.graphs.find((entry) => entry.key === parsedInvocation.rootKey && entry.identity.kind === "root");
      if (!root || parsedInvocation.execution.ownerId !== input.ownerId || parsedInvocation.execution.flowId !== input.flowId || parsedInvocation.execution.flowVersionId !== input.flowVersionId) throw new Error("Invalid invocation identity");
      invocationRootJson = canonicalJson(root.graph, MAX_DEFINITION_BYTES);
    } catch {
      return { status: "refused" };
    }
    if (invocationRootJson !== callerDefinitionJson) return { status: "refused" };
    let result: CreateExecutionResult = { status: "refused" };
    try {
      const transaction = this.db.transaction((): void => {
        const version = this.db.prepare(
          `SELECT v.graph, v.full_hash FROM flow_versions v JOIN flows f ON f.id = v.flow_id
           WHERE v.id = ? AND v.flow_id = ? AND f.owner_id = ?`,
        ).get(input.flowVersionId, input.flowId, input.ownerId) as { graph: string; full_hash: string } | undefined;
        if (!version) { result = { status: "not-found" }; return; }
        let frozenDefinitionJson: string;
        try {
          frozenDefinitionJson = canonicalJson(JSON.parse(version.graph) as unknown, MAX_DEFINITION_BYTES);
        } catch {
          result = { status: "refused" }; return;
        }
        if (callerDefinitionJson !== frozenDefinitionJson || input.definitionHash !== version.full_hash || !/^[a-f0-9]{64}$/u.test(version.full_hash)) {
          result = { status: "refused" }; return;
        }
        const requestHash = requestFingerprint(input, frozenDefinitionJson, invocationJson, invocationHash);
        const keyHash = this.keyHash(input.idempotency.key);
        let existing = this.db.prepare(
          `SELECT request_hash, execution_id, expires_at FROM execution_idempotency
           WHERE owner_id = ? AND namespace = ? AND key_hash = ?`,
        ).get(input.ownerId, input.idempotency.namespace, keyHash) as { request_hash: string; execution_id: string; expires_at: number } | undefined;
        if (existing && existing.expires_at <= input.createdAt) {
          this.db.prepare("DELETE FROM execution_idempotency WHERE owner_id = ? AND namespace = ? AND key_hash = ? AND expires_at <= ?")
            .run(input.ownerId, input.idempotency.namespace, keyHash, input.createdAt);
          existing = undefined;
        }
        if (existing) {
          if (existing.request_hash !== requestHash) { result = { status: "conflict" }; return; }
          const execution = this.hydrateExecution(input.ownerId, existing.execution_id);
          result = execution ? { status: "duplicate", execution } : { status: "refused" };
          return;
        }
        const created = parseDurableExecutionEvent({ schemaVersion: 1, executionId: input.executionId, sequence: 1, attempt: 0, type: "execution.created", at: input.createdAt, payload: { definitionHash: version.full_hash } });
        const enqueued = parseDurableExecutionEvent({ schemaVersion: 1, executionId: input.executionId, sequence: 2, attempt: 0, type: "job.enqueued", at: input.createdAt, payload: { jobId: input.jobId, priority: input.priority, availableAt: input.availableAt } });
        const projection = foldExecutionEvents([created, enqueued]);
        const materialized = projectionJson(projection);
        const responseJson = canonicalJson({ executionId: input.executionId }, 16 * 1024);
        this.db.prepare(
          `INSERT INTO durable_executions
           (id, owner_id, flow_id, flow_version_id, frozen_definition_json, definition_hash, trigger_type, trigger_id,
            state, desired_state, next_event_seq, projected_event_seq, projection_json, result_json, error_text,
            cost_micro_usdc, token_count, cost_budget_micro_usdc, token_budget, deadline_at, attempt_number, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'running', 3, 2, ?, NULL, NULL, 0, 0, ?, ?, ?, 0, ?, ?)`,
        ).run(input.executionId, input.ownerId, input.flowId, input.flowVersionId, frozenDefinitionJson, version.full_hash, input.trigger.type, input.trigger.id ?? null, materialized, input.costBudgetMicroUsdc, input.tokenBudget, input.deadlineAt ?? null, input.createdAt, input.createdAt);
        this.db.prepare(
          `INSERT INTO execution_invocations (execution_id, schema_version, snapshot_json, snapshot_hash, created_at)
           VALUES (?, 1, ?, ?, ?)`,
        ).run(input.executionId, invocationJson, invocationHash, input.createdAt);
        this.db.prepare(
          `INSERT INTO execution_jobs (id, execution_id, logical_key, state, priority, available_at, max_attempts, attempt_count, created_at, updated_at)
           VALUES (?, ?, 'whole-run', 'ready', ?, ?, ?, 0, ?, ?)`,
        ).run(input.jobId, input.executionId, input.priority, input.availableAt, input.maxAttempts, input.createdAt, input.createdAt);
        const insertEvent = this.db.prepare("INSERT INTO execution_events (execution_id, seq, schema_version, attempt, type, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
        const initialPayloads = [created, enqueued].map((event) => canonicalJson(event.payload, 256 * 1024));
        [created, enqueued].forEach((event, index) => insertEvent.run(event.executionId, event.sequence, event.schemaVersion, event.attempt, event.type, event.at, initialPayloads[index]));
        this.db.prepare("INSERT INTO execution_event_usage (execution_id, schema_version, total_event_bytes, node_event_bytes, total_event_limit, node_event_limit, event_count, event_count_limit, updated_at) VALUES (?, 1, ?, 0, ?, ?, 2, ?, ?)")
          .run(input.executionId, initialPayloads.reduce((total, payload) => total + Buffer.byteLength(payload, "utf8"), 0), MAX_TOTAL_EVENT_BYTES, MAX_NODE_EVENT_BYTES, MAX_NEW_EVENT_COUNT, input.createdAt);
        this.db.prepare(
          `INSERT INTO execution_idempotency (owner_id, namespace, key_hash, request_hash, execution_id, job_id, state, response_json, expires_at, committed_at)
           VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?)`,
        ).run(input.ownerId, input.idempotency.namespace, keyHash, requestHash, input.executionId, input.jobId, responseJson, input.idempotency.expiresAt, input.createdAt);
        result = { status: "created", execution: projection };
      });
      transaction.immediate();
      return result;
    } catch {
      return { status: "refused" };
    }
  }

  async getExecution(ownerId: string, executionId: string): Promise<DurableExecutionProjection | null> {
    if (!validId(ownerId) || !validId(executionId, 256)) return null;
    return this.hydrateExecution(ownerId, executionId);
  }

  async hasExecution(ownerId: string, executionId: string): Promise<boolean> {
    if (!validId(ownerId) || !validId(executionId, 256)) return false;
    try { return Boolean(this.db.prepare("SELECT 1 FROM durable_executions WHERE id = ? AND owner_id = ?").get(executionId, ownerId)); } catch { return false; }
  }

  async getExecutionView(ownerId: string, executionId: string): Promise<DurableExecutionOwnerView | null> {
    if (!validId(ownerId) || !validId(executionId, 256)) return null;
    try { return this.db.inTransaction ? this.hydrateExecutionView(ownerId, executionId) : this.db.transaction(() => this.hydrateExecutionView(ownerId, executionId)).deferred(); } catch { return null; }
  }

  async listEvents(ownerId: string, executionId: string, afterSequence: number, limit: number): Promise<readonly DurableExecutionEventV1[]> {
    if (!validId(ownerId) || !validId(executionId, 256) || !safeInteger(afterSequence) || !safeInteger(limit, 1, MAX_EVENT_READ)) return [];
    const rows = this.db.prepare(
      `SELECT e.execution_id, e.seq, e.schema_version, e.attempt, e.type, e.at, e.payload_json
       FROM durable_executions x JOIN execution_events e ON e.execution_id = x.id
       WHERE x.id = ? AND x.owner_id = ? AND e.seq > ? ORDER BY e.seq ASC LIMIT ?`,
    ).all(executionId, ownerId, afterSequence, limit) as EventRow[];
    return rows.map(eventFromRow);
  }

  async claimNextJob(input: ClaimNextJobInput): Promise<ClaimNextJobResult> {
    if (!input || !validId(input.workerId) || !safeInteger(input.leaseDurationMs, 1, 3_600_000)) return { status: "refused" };
    const attemptId = randomUUID();
    const leaseToken = randomBytes(32).toString("hex");
    const tokenHash = this.leaseTokenHash(leaseToken);
    try {
      let result: ClaimNextJobResult = { status: "no-job" };
      const transaction = this.db.transaction((): void => {
        const now = this.trustedNow();
        const leaseExpiresAt = now + input.leaseDurationMs;
        if (!safeInteger(leaseExpiresAt)) throw new Error("Invalid durable lease expiry");
        const rows = this.db.prepare(
          `SELECT j.id AS job_id, j.execution_id, j.attempt_count, j.max_attempts, x.projected_event_seq,
                  x.owner_id, x.flow_id, x.flow_version_id, x.frozen_definition_json, x.deadline_at,
                  x.cost_budget_micro_usdc, x.token_budget, i.snapshot_json, i.snapshot_hash,
                  u.total_event_bytes, u.node_event_bytes, u.event_count
           FROM execution_jobs j JOIN durable_executions x ON x.id = j.execution_id
           INNER JOIN execution_invocations i ON i.execution_id = x.id AND i.schema_version = 1
           INNER JOIN execution_event_usage u ON u.execution_id = x.id AND u.schema_version = 1
           WHERE j.state IN ('ready','retry') AND j.available_at <= ? AND j.attempt_count < j.max_attempts
             AND x.state = 'queued' AND x.desired_state = 'running'
             AND NOT EXISTS (SELECT 1 FROM execution_job_quarantine q WHERE q.job_id = j.id)
           ORDER BY j.priority DESC, j.available_at ASC, j.created_at ASC, j.id ASC LIMIT 100`,
        ).all(now) as Array<{ job_id: string; execution_id: string; attempt_count: number; max_attempts: number; projected_event_seq: number; owner_id: string; flow_id: string; flow_version_id: string; frozen_definition_json: string; deadline_at: number | null; cost_budget_micro_usdc: number; token_budget: number; snapshot_json: string; snapshot_hash: string; total_event_bytes: number; node_event_bytes: number; event_count: number }>;
        let invalidCandidate = false;
        for (const row of rows) {
          let invocation: ReturnType<typeof parseDurableInvocationJson>;
          let root: ReturnType<typeof parseDurableInvocationJson>["graphs"][number] | undefined;
          let quarantineReason: "invalid_durable_invocation" | "durable_mirror_mismatch" | "durable_event_usage_mismatch" | null = null;
          try {
            invocation = parseDurableInvocationJson(row.snapshot_json, row.snapshot_hash);
          } catch {
            quarantineReason = "invalid_durable_invocation";
          }
          if (!quarantineReason) {
            root = invocation!.graphs.find((entry) => entry.key === invocation!.rootKey && entry.identity.kind === "root");
            if (!root || invocation!.execution.ownerId !== row.owner_id || invocation!.execution.flowId !== row.flow_id || invocation!.execution.flowVersionId !== row.flow_version_id || JSON.stringify(root.graph) !== row.frozen_definition_json) quarantineReason = "durable_mirror_mismatch";
          }
          if (!quarantineReason) {
            const actual = this.db.prepare(
              "SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) AS total, COALESCE(SUM(CASE WHEN type LIKE 'node.%' THEN length(CAST(payload_json AS BLOB)) ELSE 0 END),0) AS node, COUNT(*) AS count FROM execution_events WHERE execution_id = ?",
            ).get(row.execution_id) as { total: number; node: number; count: number };
            if (actual.total !== row.total_event_bytes || actual.node !== row.node_event_bytes || actual.count !== row.event_count || actual.count !== row.projected_event_seq) quarantineReason = "durable_event_usage_mismatch";
          }
          if (quarantineReason) {
            this.db.prepare("INSERT OR IGNORE INTO execution_job_quarantine (job_id,execution_id,reason,created_at) VALUES (?,?,?,?)")
              .run(row.job_id, row.execution_id, quarantineReason, now);
            invalidCandidate = true;
            continue;
          }
          const attemptNumber = row.attempt_count + 1;
          if (!safeInteger(attemptNumber, 1, row.max_attempts)) throw new Error("Invalid durable attempt number");
          const claimed = parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: row.projected_event_seq + 1, attempt: attemptNumber, type: "job.claimed", at: now, payload: { jobId: row.job_id, attemptId, workerId: input.workerId, leaseExpiresAt } });
          const started = parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: row.projected_event_seq + 2, attempt: attemptNumber, type: "attempt.started", at: now, payload: { attemptId } });
          try {
            this.appendProjectionEvents(row.execution_id, [claimed, started]);
          } catch (error) {
            if (!(error instanceof DurableEventBudgetError)) throw error;
            const failed = parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: row.projected_event_seq + 3, attempt: attemptNumber, type: "execution.failed", at: now, payload: { error: POLICY_ERROR, costMicroUsdc: 0, tokens: 0 } });
            this.appendProjectionEvents(row.execution_id, [claimed, started, failed]);
            const terminalJob = this.db.prepare(
              "UPDATE execution_jobs SET state='completed',attempt_count=?,lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,heartbeat_at=NULL,last_error=?,updated_at=? WHERE id=? AND execution_id=? AND state IN ('ready','retry') AND attempt_count=?",
            ).run(attemptNumber, POLICY_ERROR, now, row.job_id, row.execution_id, row.attempt_count);
            if (terminalJob.changes !== 1) throw new Error("Durable claim terminalization drift");
            this.db.prepare(
              `INSERT INTO execution_attempts
               (id,execution_id,job_id,attempt_number,worker_id,lease_token_hash,state,started_at,heartbeat_at,finished_at,error_text)
               VALUES (?,?,?,?,?,?,'failed',?,?,?,?)`,
            ).run(attemptId, row.execution_id, row.job_id, attemptNumber, input.workerId, tokenHash, now, now, now, POLICY_ERROR);
            continue;
          }
          const changed = this.db.prepare(
            `UPDATE execution_jobs SET state = 'leased', attempt_count = ?, lease_owner = ?, lease_token_hash = ?,
             lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
             WHERE id = ? AND execution_id = ? AND state IN ('ready','retry') AND available_at <= ? AND attempt_count = ?`,
          ).run(attemptNumber, input.workerId, tokenHash, leaseExpiresAt, now, now,
            row.job_id, row.execution_id, now, row.attempt_count);
          if (changed.changes !== 1) return;
          this.db.prepare(
            `INSERT INTO execution_attempts
             (id, execution_id, job_id, attempt_number, worker_id, lease_token_hash, state, started_at, heartbeat_at)
             VALUES (?, ?, ?, ?, ?, ?, 'leased', ?, ?)`,
          ).run(attemptId, row.execution_id, row.job_id, attemptNumber, input.workerId, tokenHash, now, now);
          const claimedUsage = this.db.prepare("SELECT total_event_bytes, node_event_bytes FROM execution_event_usage WHERE execution_id = ?").get(row.execution_id) as { total_event_bytes: number; node_event_bytes: number };
          result = { status: "claimed", claim: freezeDeep({ executionId: row.execution_id, jobId: row.job_id, attemptId, attemptNumber, workerId: input.workerId, leaseToken, leaseExpiresAt, ownerId: row.owner_id, flowId: row.flow_id, flowVersionId: row.flow_version_id, eventSequence: row.projected_event_seq + 2, totalEventBytes: claimedUsage.total_event_bytes, nodeEventBytes: claimedUsage.node_event_bytes, frozenDefinition: root!.graph as unknown as DurableJsonValue, invocation: invocation!, deadlineAt: row.deadline_at, costBudgetMicroUsdc: row.cost_budget_micro_usdc, tokenBudget: row.token_budget }) };
          return;
        }
        if (invalidCandidate) result = { status: "refused" };
      });
      transaction.immediate();
      return result;
    } catch {
      return { status: "refused" };
    }
  }

  async heartbeat(input: LeaseIdentity & Readonly<{ leaseDurationMs: number }>): Promise<HeartbeatResult> {
    if (!validLeaseIdentity(input) || !safeInteger(input.leaseDurationMs, 1, 3_600_000)) return { status: "refused" };
    try {
      let result: HeartbeatResult = { status: "lost" };
      const transaction = this.db.transaction((): void => {
        const now = this.trustedNow();
        const row = this.liveLease(input, now);
        if (!row) return;
        const leaseExpiresAt = now + input.leaseDurationMs;
        if (!safeInteger(leaseExpiresAt)) throw new Error("Invalid durable lease expiry");
        if (leaseExpiresAt <= row.lease_expires_at) {
          result = { status: "retained", leaseExpiresAt: row.lease_expires_at, desiredState: row.desired_state, cancelRequested: row.desired_state === "cancelled" };
          return;
        }
        const tokenHash = this.leaseTokenHash(input.leaseToken);
        const job = this.db.prepare(
          `UPDATE execution_jobs SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
           WHERE id = ? AND execution_id = ? AND state = 'leased' AND lease_token_hash = ? AND lease_expires_at > ?`,
        ).run(leaseExpiresAt, now, now, input.jobId, row.execution_id, tokenHash, now);
        const attempt = this.db.prepare(
          `UPDATE execution_attempts SET heartbeat_at = ?
           WHERE id = ? AND job_id = ? AND execution_id = ? AND state = 'leased' AND lease_token_hash = ?`,
        ).run(now, input.attemptId, input.jobId, row.execution_id, tokenHash);
        if (job.changes !== 1 || attempt.changes !== 1) throw new Error("Durable heartbeat fence drift");
        result = { status: "extended", leaseExpiresAt, desiredState: row.desired_state, cancelRequested: row.desired_state === "cancelled" };
      });
      transaction.immediate();
      return result;
    } catch {
      return { status: "refused" };
    }
  }

  async appendLeasedEvent(input: AppendLeasedEventInput): Promise<LeasedTransitionResult> {
    if (!validLeaseIdentity(input) || !safeInteger(input.expectedSequence) || !input.event || input.event.schemaVersion !== 1 ||
        !["node.started", "node.logged", "node.completed", "node.failed"].includes(input.event.type)) return { status: "refused" };
    try {
      let result: LeasedTransitionResult = { status: "lost" };
      const transaction = this.db.transaction((): void => {
        const now = this.trustedNow();
        const row = this.liveLease(input, now);
        if (!row) return;
        if (row.desired_state !== "running") return;
        if (row.projected_event_seq !== input.expectedSequence) { result = { status: "conflict" }; return; }
        const event = parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: input.expectedSequence + 1, attempt: row.attempt_number, type: input.event.type, at: now, payload: input.event.payload });
        const projection = this.appendProjectionEvents(row.execution_id, [event]);
        result = { status: "appended", execution: projection };
      });
      transaction.immediate();
      return result;
    } catch (error) {
      if (error instanceof DurableEventBudgetError) return { status: "budget-exhausted" };
      return { status: "refused" };
    }
  }

  async completeAttempt(input: LeaseIdentity & Readonly<{ output: DurableJsonValue }>): Promise<LeasedTransitionResult> {
    if (!validLeaseIdentity(input)) return { status: "refused" };
    let output: DurableJsonValue;
    try { output = canonicalValue(input.output, 0, new Set()); canonicalJson(output, 128 * 1024); } catch { return { status: "refused" }; }
    try {
      let result: LeasedTransitionResult = { status: "lost" };
      const transaction = this.db.transaction((): void => {
        const now = this.trustedNow();
        const row = this.liveLease(input, now); if (!row || row.desired_state !== "running") return;
        const event = parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: row.projected_event_seq + 1, attempt: row.attempt_number, type: "execution.succeeded", at: now, payload: { output, costMicroUsdc: row.cost_micro_usdc, tokens: row.token_count } });
        const projection = this.appendProjectionEvents(row.execution_id, [event]);
        const tokenHash = this.leaseTokenHash(input.leaseToken);
        const job = this.db.prepare("UPDATE execution_jobs SET state = 'completed', lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ? AND state = 'leased' AND lease_token_hash = ?").run(now, input.jobId, tokenHash);
        const attempt = this.db.prepare("UPDATE execution_attempts SET state = 'succeeded', finished_at = ?, heartbeat_at = ? WHERE id = ? AND job_id = ? AND state = 'leased' AND lease_token_hash = ?").run(now, now, input.attemptId, input.jobId, tokenHash);
        if (job.changes !== 1 || attempt.changes !== 1) throw new Error("Durable completion fence drift");
        result = { status: "completed", execution: projection };
      }); transaction.immediate(); return result;
    } catch { return { status: "refused" }; }
  }

  async failAttempt(input: LeaseIdentity & Readonly<{ classification: FailureClassification; error: string }>): Promise<LeasedTransitionResult> {
    if (!validLeaseIdentity(input) || typeof input.error !== "string" || Buffer.byteLength(input.error, "utf8") < 1 || Buffer.byteLength(input.error, "utf8") > 8_192) return { status: "refused" };
    try {
      let result: LeasedTransitionResult = { status: "lost" };
      const transaction = this.db.transaction((): void => {
        const now = this.trustedNow();
        const row = this.liveLease(input, now); if (!row) return;
        if ((input.classification === "cancelled") !== (row.desired_state === "cancelled")) return;
        if (input.classification !== "cancelled" && row.desired_state !== "running") return;
        const decision = decideRetry({ classification: input.classification, jobId: input.jobId, attemptNumber: row.attempt_number, maxAttempts: row.max_attempts, now });
        let action: "retry" | "cancel" | "dead-letter" | "fail" = decision.action;
        let persistedError = input.error;
        let type: "attempt.retry_scheduled" | "execution.failed" | "execution.cancelled" | "execution.dead_lettered";
        let payload: DurableJsonValue;
        let jobState: "retry" | "completed" | "cancelled" | "dead";
        if (decision.action === "retry") { type = "attempt.retry_scheduled"; payload = { attemptId: input.attemptId, error: input.error, availableAt: decision.availableAt }; jobState = "retry"; }
        else if (decision.action === "cancel") { type = "execution.cancelled"; payload = { reason: input.error }; jobState = "cancelled"; }
        else if (decision.action === "dead-letter") { type = "execution.dead_lettered"; payload = { error: input.error }; jobState = "dead"; }
        else { type = "execution.failed"; payload = { error: input.error, costMicroUsdc: row.cost_micro_usdc, tokens: row.token_count }; jobState = "completed"; }
        let event = parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: row.projected_event_seq + 1, attempt: row.attempt_number, type, at: now, payload });
        let projection: DurableExecutionProjection;
        try {
          projection = this.appendProjectionEvents(row.execution_id, [event]);
        } catch (error) {
          if (!(error instanceof DurableEventBudgetError) || action !== "retry") throw error;
          action = "fail"; persistedError = POLICY_ERROR; jobState = "completed";
          event = parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: row.projected_event_seq + 1, attempt: row.attempt_number, type: "execution.failed", at: now, payload: { error: POLICY_ERROR, costMicroUsdc: row.cost_micro_usdc, tokens: row.token_count } });
          projection = this.appendProjectionEvents(row.execution_id, [event]);
        }
        const availableAt = action === "retry" && decision.action === "retry" ? decision.availableAt : now;
        const deadAt = action === "dead-letter" ? now : null;
        const tokenHash = this.leaseTokenHash(input.leaseToken);
        const job = this.db.prepare("UPDATE execution_jobs SET state = ?, available_at = ?, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL, heartbeat_at = NULL, last_error = ?, dead_lettered_at = ?, updated_at = ? WHERE id = ? AND state = 'leased' AND lease_token_hash = ?").run(jobState, availableAt, persistedError, deadAt, now, input.jobId, tokenHash);
        const attemptState = action === "cancel" ? "cancelled" : "failed";
        const attempt = this.db.prepare("UPDATE execution_attempts SET state = ?, finished_at = ?, heartbeat_at = ?, error_text = ? WHERE id = ? AND job_id = ? AND state = 'leased' AND lease_token_hash = ?").run(attemptState, now, now, persistedError, input.attemptId, input.jobId, tokenHash);
        if (job.changes !== 1 || attempt.changes !== 1) throw new Error("Durable failure fence drift");
        const status = action === "retry" ? "retry-scheduled" : action === "cancel" ? "cancelled" : action === "dead-letter" ? "dead-lettered" : "failed";
        result = { status, execution: projection };
      }); transaction.immediate(); return result;
    } catch { return { status: "refused" }; }
  }

  async pauseAttempt(input: LeaseIdentity): Promise<LeasedTransitionResult> {
    if (!validLeaseIdentity(input)) return { status: "refused" };
    try {
      let result: LeasedTransitionResult = { status: "lost" };
      const transaction = this.db.transaction((): void => {
        const now = this.trustedNow();
        const row = this.liveLease(input, now);
        if (!row || row.desired_state !== "paused") return;
        const event = parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: row.projected_event_seq + 1, attempt: row.attempt_number, type: "execution.paused", at: now, payload: {} });
        const projection = this.appendProjectionEvents(row.execution_id, [event]);
        const tokenHash = this.leaseTokenHash(input.leaseToken);
        const reason = "paused by control request";
        const job = this.db.prepare("UPDATE execution_jobs SET state = 'retry', available_at = ?, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL, heartbeat_at = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND state = 'leased' AND lease_token_hash = ?").run(now, now, input.jobId, tokenHash);
        const attempt = this.db.prepare("UPDATE execution_attempts SET state = 'lost', finished_at = ?, heartbeat_at = ?, error_text = ? WHERE id = ? AND job_id = ? AND state = 'leased' AND lease_token_hash = ?").run(now, now, reason, input.attemptId, input.jobId, tokenHash);
        if (job.changes !== 1 || attempt.changes !== 1) throw new Error("Durable pause fence drift");
        result = { status: "appended", execution: projection };
      });
      transaction.immediate();
      return result;
    } catch { return { status: "refused" }; }
  }

  async controlExecution(ownerId: string, executionId: string, action: "pause" | "cancel" | "resume"): Promise<ControlExecutionResult> {
    if (!validId(ownerId) || !validId(executionId, 256) || !["pause", "cancel", "resume"].includes(action)) return { status: "refused" };
    try {
      let result: ControlExecutionResult = { status: "not-found" };
      const transaction = this.db.transaction((): void => {
        const now = this.trustedNow();
        const row = this.db.prepare(
          `SELECT x.state, x.desired_state, x.projected_event_seq, x.attempt_number,
                  j.id AS job_id, j.state AS job_state
           FROM durable_executions x JOIN execution_jobs j ON j.execution_id = x.id
           WHERE x.id = ? AND x.owner_id = ?`,
        ).get(executionId, ownerId) as { state: DurableExecutionProjection["state"]; desired_state: "running" | "paused" | "cancelled"; projected_event_seq: number; attempt_number: number; job_id: string; job_state: "ready" | "leased" | "retry" | "completed" | "cancelled" | "dead" } | undefined;
        if (!row) return;
        const projection = this.hydrateExecution(ownerId, executionId);
        if (!projection) { result = { status: "refused" }; return; }
        if (action === "cancel" && row.desired_state === "cancelled") { result = { status: "idempotent", execution: projection }; return; }
        if (action === "pause" && row.desired_state === "paused") { result = { status: "idempotent", execution: projection }; return; }
        if (action === "resume" && row.desired_state === "running" && row.state === "queued" && projection.controlRequests.at(-1)?.action === "resume") { result = { status: "idempotent", execution: projection }; return; }
        if (["succeeded", "failed", "cancelled", "dead"].includes(row.state)) { result = { status: "conflict" }; return; }

        const control = parseDurableExecutionEvent({ schemaVersion: 1, executionId, sequence: row.projected_event_seq + 1, attempt: row.attempt_number, type: "control.requested", at: now, payload: { action } });
        if (action === "resume") {
          if (row.state !== "paused" || row.job_state !== "retry") { result = { status: "conflict" }; return; }
          const resumed = parseDurableExecutionEvent({ schemaVersion: 1, executionId, sequence: row.projected_event_seq + 2, attempt: row.attempt_number, type: "execution.resumed", at: now, payload: {} });
          const next = this.appendProjectionEvents(executionId, [control, resumed]);
          const changed = this.db.prepare("UPDATE execution_jobs SET state = 'retry', available_at = ?, updated_at = ? WHERE id = ? AND state = 'retry'").run(now, now, row.job_id);
          if (changed.changes !== 1) throw new Error("Durable resume job drift");
          result = { status: "applied", execution: next }; return;
        }
        if (row.state === "running") {
          if (row.job_state !== "leased") { result = { status: "conflict" }; return; }
          result = { status: "applied", execution: this.appendProjectionEvents(executionId, [control]) }; return;
        }
        if (row.state !== "queued" && row.state !== "paused") { result = { status: "conflict" }; return; }
        if (row.job_state !== "ready" && row.job_state !== "retry") { result = { status: "conflict" }; return; }
        const terminal = action === "pause"
          ? parseDurableExecutionEvent({ schemaVersion: 1, executionId, sequence: row.projected_event_seq + 2, attempt: row.attempt_number, type: "execution.paused", at: now, payload: {} })
          : parseDurableExecutionEvent({ schemaVersion: 1, executionId, sequence: row.projected_event_seq + 2, attempt: row.attempt_number, type: "execution.cancelled", at: now, payload: { reason: "cancelled_by_control" } });
        const next = this.appendProjectionEvents(executionId, [control, terminal]);
        const changed = this.db.prepare("UPDATE execution_jobs SET state = ?, available_at = ?, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ? AND state IN ('ready','retry')").run(action === "pause" ? "retry" : "cancelled", now, now, row.job_id);
        if (changed.changes !== 1) throw new Error("Durable preclaim control drift");
        result = { status: "applied", execution: next };
      });
      transaction.immediate();
      return result;
    } catch { return { status: "refused" }; }
  }

  async retryExecution(input: Readonly<{ ownerId: string; sourceExecutionId: string; executionId: string; jobId: string; idempotencyKey: string; expiresAt: number }>): Promise<RetryExecutionResult> {
    if (!input || !validId(input.ownerId) || !validId(input.sourceExecutionId, 256) ||
        !validId(input.executionId, 256) || !validId(input.jobId, 256) || !validId(input.idempotencyKey, 4096) ||
        !safeInteger(input.expiresAt)) return { status: "refused" };
    let result: RetryExecutionResult = { status: "refused" };
    try {
      const transaction = this.db.transaction((): void => {
        const now = this.trustedNow();
        if (input.expiresAt < now) { result = { status: "refused" }; return; }
        const shallow = this.db.prepare("SELECT state FROM durable_executions WHERE id = ? AND owner_id = ?")
          .get(input.sourceExecutionId, input.ownerId) as { state: DurableExecutionProjection["state"] } | undefined;
        if (!shallow) { result = { status: "not-found" }; return; }
        if (!["succeeded", "failed", "cancelled", "dead"].includes(shallow.state)) { result = { status: "conflict" }; return; }

        const namespace = "v3-retry";
        const keyHash = this.keyHash(input.idempotencyKey);
        const requestHash = createHash("sha256").update("durable-runtime:retry-request:v1\0", "utf8").update(input.sourceExecutionId, "utf8").digest("hex");
        let existing = this.db.prepare(
          "SELECT request_hash, execution_id, expires_at FROM execution_idempotency WHERE owner_id = ? AND namespace = ? AND key_hash = ?",
        ).get(input.ownerId, namespace, keyHash) as { request_hash: string; execution_id: string; expires_at: number } | undefined;
        if (existing && existing.expires_at <= now) {
          this.db.prepare("DELETE FROM execution_idempotency WHERE owner_id = ? AND namespace = ? AND key_hash = ? AND expires_at <= ?")
            .run(input.ownerId, namespace, keyHash, now);
          existing = undefined;
        }
        if (existing) {
          if (existing.request_hash !== requestHash) { result = { status: "conflict" }; return; }
          const view = this.hydrateExecutionView(input.ownerId, existing.execution_id);
          result = view ? { status: "duplicate", execution: view } : { status: "refused" };
          return;
        }
        const source = this.db.prepare(
          `SELECT x.id, x.state, x.projected_event_seq, x.flow_id, x.flow_version_id, x.deployment_id, x.environment_id, x.frozen_definition_json, x.definition_hash,
                  x.cost_budget_micro_usdc, x.token_budget, x.deadline_at, x.created_at,
                  j.priority, j.max_attempts, i.snapshot_json, i.snapshot_hash,
                  u.total_event_bytes, u.node_event_bytes, u.event_count, u.total_event_limit, u.node_event_limit, u.event_count_limit
           FROM durable_executions x
           JOIN execution_jobs j ON j.execution_id = x.id
           JOIN execution_invocations i ON i.execution_id = x.id AND i.schema_version = 1
           JOIN execution_event_usage u ON u.execution_id = x.id AND u.schema_version = 1
           WHERE x.id = ? AND x.owner_id = ? AND j.logical_key = 'whole-run'`,
        ).get(input.sourceExecutionId, input.ownerId) as {
          id: string; state: DurableExecutionProjection["state"]; projected_event_seq: number; flow_id: string; flow_version_id: string; deployment_id: string | null; environment_id: string | null; frozen_definition_json: string; definition_hash: string;
          cost_budget_micro_usdc: number; token_budget: number; deadline_at: number | null; created_at: number;
          priority: number; max_attempts: number; snapshot_json: string; snapshot_hash: string;
          total_event_bytes: number; node_event_bytes: number; event_count: number; total_event_limit: number; node_event_limit: number; event_count_limit: number;
        } | undefined;
        if (!source) { result = { status: "refused" }; return; }

        const sourceProjection = this.hydrateExecution(input.ownerId, source.id);
        if (!sourceProjection || sourceProjection.state !== source.state || sourceProjection.sequence !== source.projected_event_seq ||
            !["succeeded", "failed", "cancelled", "dead"].includes(sourceProjection.state) ||
            this.db.prepare("SELECT 1 FROM execution_job_quarantine WHERE execution_id = ? LIMIT 1").get(source.id)) { result = { status: "refused" }; return; }
        const actualUsage = this.db.prepare(
          "SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) AS total, COALESCE(SUM(CASE WHEN type LIKE 'node.%' THEN length(CAST(payload_json AS BLOB)) ELSE 0 END),0) AS node, COUNT(*) AS count FROM execution_events WHERE execution_id = ?",
        ).get(source.id) as { total: number; node: number; count: number };
        if (actualUsage.total !== source.total_event_bytes || actualUsage.node !== source.node_event_bytes || actualUsage.count !== source.event_count || actualUsage.count !== source.projected_event_seq) { result = { status: "refused" }; return; }
        const version = this.db.prepare(
          `SELECT v.graph, v.full_hash FROM flow_versions v JOIN flows f ON f.id = v.flow_id
           WHERE v.id = ? AND v.flow_id = ? AND f.owner_id = ?`,
        ).get(source.flow_version_id, source.flow_id, input.ownerId) as { graph: string; full_hash: string } | undefined;
        if (!version || version.full_hash !== source.definition_hash) { result = { status: "refused" }; return; }
        let authoritativeGraph: string;
        try { authoritativeGraph = canonicalJson(JSON.parse(version.graph) as unknown, MAX_DEFINITION_BYTES); } catch { result = { status: "refused" }; return; }
        if (authoritativeGraph !== source.frozen_definition_json) { result = { status: "refused" }; return; }

        let rootJson: string;
        try {
          const invocation = parseDurableInvocationJson(source.snapshot_json, source.snapshot_hash);
          const root = invocation.graphs.find((entry) => entry.key === invocation.rootKey && entry.identity.kind === "root");
          if (!root || invocation.execution.ownerId !== input.ownerId || invocation.execution.flowId !== source.flow_id || invocation.execution.flowVersionId !== source.flow_version_id) throw new Error("invalid retry invocation");
          rootJson = canonicalJson(root.graph, MAX_DEFINITION_BYTES);
        } catch { result = { status: "refused" }; return; }
        if (rootJson !== source.frozen_definition_json) { result = { status: "refused" }; return; }

        const duration = source.deadline_at === null ? null : Math.max(0, source.deadline_at - source.created_at);
        const deadlineAt = duration === null ? null : now + duration;
        if (deadlineAt !== null && !safeInteger(deadlineAt, now)) { result = { status: "refused" }; return; }
        const created = parseDurableExecutionEvent({ schemaVersion: 1, executionId: input.executionId, sequence: 1, attempt: 0, type: "execution.created", at: now, payload: { definitionHash: source.definition_hash } });
        const enqueued = parseDurableExecutionEvent({ schemaVersion: 1, executionId: input.executionId, sequence: 2, attempt: 0, type: "job.enqueued", at: now, payload: { jobId: input.jobId, priority: source.priority, availableAt: now } });
        const projection = foldExecutionEvents([created, enqueued]);
        const materialized = projectionJson(projection);
        this.db.prepare(
          `INSERT INTO durable_executions
           (id, owner_id, flow_id, flow_version_id, deployment_id, environment_id, parent_execution_id, frozen_definition_json, definition_hash, trigger_type, trigger_id,
            state, desired_state, next_event_seq, projected_event_seq, projection_json, result_json, error_text,
            cost_micro_usdc, token_count, cost_budget_micro_usdc, token_budget, deadline_at, attempt_number, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'retry', ?, 'queued', 'running', 3, 2, ?, NULL, NULL, 0, 0, ?, ?, ?, 0, ?, ?)`,
        ).run(input.executionId, input.ownerId, source.flow_id, source.flow_version_id, source.deployment_id, source.environment_id, source.id,
          source.frozen_definition_json, source.definition_hash, source.id, materialized,
          source.cost_budget_micro_usdc, source.token_budget, deadlineAt, now, now);
        this.db.prepare("INSERT INTO execution_invocations (execution_id, schema_version, snapshot_json, snapshot_hash, created_at) VALUES (?, 1, ?, ?, ?)")
          .run(input.executionId, source.snapshot_json, source.snapshot_hash, now);
        this.db.prepare(
          "INSERT INTO execution_jobs (id, execution_id, logical_key, state, priority, available_at, max_attempts, attempt_count, created_at, updated_at) VALUES (?, ?, 'whole-run', 'ready', ?, ?, ?, 0, ?, ?)",
        ).run(input.jobId, input.executionId, source.priority, now, source.max_attempts, now, now);
        const payloads = [created, enqueued].map((event) => canonicalJson(event.payload, 256 * 1024));
        const insertEvent = this.db.prepare("INSERT INTO execution_events (execution_id, seq, schema_version, attempt, type, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
        [created, enqueued].forEach((event, index) => insertEvent.run(event.executionId, event.sequence, event.schemaVersion, event.attempt, event.type, event.at, payloads[index]));
        this.db.prepare("INSERT INTO execution_event_usage (execution_id, schema_version, total_event_bytes, node_event_bytes, total_event_limit, node_event_limit, event_count, event_count_limit, updated_at) VALUES (?, 1, ?, 0, ?, ?, 2, ?, ?)")
          .run(input.executionId, payloads.reduce((sum, payload) => sum + Buffer.byteLength(payload, "utf8"), 0), source.total_event_limit, source.node_event_limit, source.event_count_limit, now);
        this.db.prepare("INSERT INTO execution_idempotency (owner_id, namespace, key_hash, request_hash, execution_id, job_id, state, response_json, expires_at, committed_at) VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?)")
          .run(input.ownerId, namespace, keyHash, requestHash, input.executionId, input.jobId, canonicalJson({ executionId: input.executionId }, 16 * 1024), input.expiresAt, now);
        const view: DurableExecutionOwnerView = freezeDeep({ executionId: input.executionId, flowId: source.flow_id, flowVersionId: source.flow_version_id, parentExecutionId: source.id, createdAt: now, updatedAt: now, finishedAt: null, deadlineAt, projection });
        result = { status: "created", execution: view };
      });
      transaction.immediate();
      return result;
    } catch { return { status: "refused" }; }
  }

  async recoverExpiredLeases(input: Readonly<{ limit: number }>): Promise<Readonly<{ status: "recovered"; recovered: number; retried: number; deadLettered: number }> | Readonly<{ status: "refused" }>> {
    if (!input || !safeInteger(input.limit, 1, MAX_RECOVERY_BATCH)) return { status: "refused" };
    try {
      let counts = { recovered: 0, retried: 0, deadLettered: 0 };
      const candidates = this.db.prepare(
        `SELECT id AS job_id FROM execution_jobs
         WHERE state = 'leased' ORDER BY lease_expires_at ASC, id ASC LIMIT ?`,
      ).all(input.limit) as Array<{ job_id: string }>;
      for (const candidate of candidates) {
        let outcome: "retry" | "dead" | "failed" | "controlled" | null = null;
        const transaction = this.db.transaction((): void => {
          const now = this.trustedNow();
          const row = this.db.prepare(
          `SELECT j.id AS job_id, j.execution_id, j.attempt_count, j.max_attempts, j.lease_token_hash,
                  x.projected_event_seq, x.desired_state, x.cost_micro_usdc, x.token_count, a.id AS attempt_id
           FROM execution_jobs j JOIN durable_executions x ON x.id = j.execution_id
           JOIN execution_attempts a ON a.job_id = j.id AND a.execution_id = j.execution_id AND a.attempt_number = j.attempt_count
           WHERE j.id = ? AND j.state = 'leased' AND a.state = 'leased' AND j.lease_expires_at <= ?`,
          ).get(candidate.job_id, now) as { job_id: string; execution_id: string; attempt_count: number; max_attempts: number; lease_token_hash: string; projected_event_seq: number; desired_state: "running" | "paused" | "cancelled"; cost_micro_usdc: number; token_count: number; attempt_id: string } | undefined;
          if (!row) return;
          if (row.desired_state === "paused" || row.desired_state === "cancelled") {
            const paused = row.desired_state === "paused";
            const reason = paused ? "paused after lease expiry" : "cancelled after lease expiry";
            const event = paused
              ? parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: row.projected_event_seq + 1, attempt: row.attempt_count, type: "execution.paused", at: now, payload: {} })
              : parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: row.projected_event_seq + 1, attempt: row.attempt_count, type: "execution.cancelled", at: now, payload: { reason } });
            this.appendProjectionEvents(row.execution_id, [event]);
            const changed = this.db.prepare("UPDATE execution_jobs SET state = ?, available_at = ?, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL, heartbeat_at = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND state = 'leased' AND lease_token_hash = ? AND lease_expires_at <= ?").run(paused ? "retry" : "cancelled", now, now, row.job_id, row.lease_token_hash, now);
            const attempt = this.db.prepare("UPDATE execution_attempts SET state = ?, finished_at = ?, heartbeat_at = ?, error_text = ? WHERE id = ? AND job_id = ? AND state = 'leased' AND lease_token_hash = ?").run(paused ? "lost" : "cancelled", now, now, reason, row.attempt_id, row.job_id, row.lease_token_hash);
            if (changed.changes !== 1 || attempt.changes !== 1) throw new Error("Durable controlled recovery fence drift");
            outcome = "controlled";
            return;
          }
          let error = "lease expired";
          const decision = decideRetry({ classification: "timeout", jobId: row.job_id, attemptNumber: row.attempt_count, maxAttempts: row.max_attempts, now });
          const retryAvailableAt = decision.action === "retry" ? decision.availableAt : now;
          let retry = decision.action === "retry";
          let event = retry
            ? parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: row.projected_event_seq + 1, attempt: row.attempt_count, type: "attempt.retry_scheduled", at: now, payload: { attemptId: row.attempt_id, error, availableAt: retryAvailableAt } })
            : parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: row.projected_event_seq + 1, attempt: row.attempt_count, type: "execution.dead_lettered", at: now, payload: { error } });
          let policyTerminal = false;
          try {
            this.appendProjectionEvents(row.execution_id, [event]);
          } catch (appendError) {
            if (!(appendError instanceof DurableEventBudgetError) || !retry) throw appendError;
            retry = false; policyTerminal = true; error = POLICY_ERROR;
            event = parseDurableExecutionEvent({ schemaVersion: 1, executionId: row.execution_id, sequence: row.projected_event_seq + 1, attempt: row.attempt_count, type: "execution.failed", at: now, payload: { error, costMicroUsdc: row.cost_micro_usdc, tokens: row.token_count } });
            this.appendProjectionEvents(row.execution_id, [event]);
          }
          const jobState = retry ? "retry" : policyTerminal ? "completed" : "dead";
          const changed = this.db.prepare("UPDATE execution_jobs SET state = ?, available_at = ?, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL, heartbeat_at = NULL, last_error = ?, dead_lettered_at = ?, updated_at = ? WHERE id = ? AND state = 'leased' AND lease_token_hash = ? AND lease_expires_at <= ?").run(jobState, retry ? retryAvailableAt : now, error, !retry && !policyTerminal ? now : null, now, row.job_id, row.lease_token_hash, now);
          const attempt = this.db.prepare("UPDATE execution_attempts SET state = ?, finished_at = ?, heartbeat_at = ?, error_text = ? WHERE id = ? AND job_id = ? AND state = 'leased' AND lease_token_hash = ?").run(policyTerminal ? "failed" : "lost", now, now, error, row.attempt_id, row.job_id, row.lease_token_hash);
          if (changed.changes !== 1 || attempt.changes !== 1) throw new Error("Durable recovery fence drift");
          outcome = retry ? "retry" : policyTerminal ? "failed" : "dead";
        });
        transaction.immediate();
        if (outcome !== null) counts = { recovered: counts.recovered + 1, retried: counts.retried + (outcome === "retry" ? 1 : 0), deadLettered: counts.deadLettered + (outcome === "dead" ? 1 : 0) };
      }
      return { status: "recovered", ...counts };
    } catch { return { status: "refused" }; }
  }

  async rebuildProjection(ownerId: string, executionId: string): Promise<RebuildProjectionResult | null> {
    if (!validId(ownerId) || !validId(executionId, 256)) return null;
    const rebuild = (): RebuildProjectionResult | null => {
      const row = this.db.prepare("SELECT projection_json FROM durable_executions WHERE id = ? AND owner_id = ?").get(executionId, ownerId) as { projection_json: string } | undefined;
      if (!row) return null;
      const projection = foldExecutionEvents(this.readAllEvents(executionId));
      const rebuilt = projectionJson(projection);
      return { status: rebuilt === row.projection_json ? "equal" : "mismatch", projection, projectionJson: rebuilt };
    };
    return this.db.inTransaction ? rebuild() : this.db.transaction(rebuild).deferred();
  }
}
