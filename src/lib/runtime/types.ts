export type DurableJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly DurableJsonValue[]
  | { readonly [key: string]: DurableJsonValue };

export type DurableExecutionEventTypeV1 =
  | "execution.created"
  | "job.enqueued"
  | "job.claimed"
  | "attempt.started"
  | "node.started"
  | "node.logged"
  | "node.completed"
  | "node.failed"
  | "control.requested"
  | "attempt.retry_scheduled"
  | "execution.paused"
  | "execution.resumed"
  | "execution.cancelled"
  | "execution.succeeded"
  | "execution.failed"
  | "execution.dead_lettered";

type Event<TType extends DurableExecutionEventTypeV1, TPayload> = Readonly<{
  schemaVersion: 1;
  executionId: string;
  sequence: number;
  attempt: number;
  type: TType;
  at: number;
  payload: Readonly<TPayload>;
}>;

export type DurableExecutionEventV1 =
  | Event<"execution.created", { definitionHash: string }>
  | Event<"job.enqueued", { jobId: string; priority: number; availableAt: number }>
  | Event<"job.claimed", { jobId: string; attemptId: string; workerId: string; leaseExpiresAt: number }>
  | Event<"attempt.started", { attemptId: string }>
  | Event<"node.started", { nodeId: string }>
  | Event<"node.logged", { nodeId: string; level: "info" | "warn" | "error"; message: string }>
  | Event<"node.completed", { nodeId: string; output: DurableJsonValue; costMicroUsdc: number; tokens: number }>
  | Event<"node.failed", { nodeId: string; error: string }>
  | Event<"control.requested", { action: "cancel" | "pause" | "resume" }>
  | Event<"attempt.retry_scheduled", { attemptId: string; error: string; availableAt: number }>
  | Event<"execution.paused", Record<string, never>>
  | Event<"execution.resumed", Record<string, never>>
  | Event<"execution.cancelled", { reason: string }>
  | Event<"execution.succeeded", { output: DurableJsonValue; costMicroUsdc: number; tokens: number }>
  | Event<"execution.failed", { error: string; costMicroUsdc: number; tokens: number }>
  | Event<"execution.dead_lettered", { error: string }>;

export type DurableExecutionState =
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "dead";

export type DurableDesiredState = "running" | "paused" | "cancelled";

export type DurableExecutionProjection = Readonly<{
  schemaVersion: 1;
  executionId: string;
  definitionHash: string;
  sequence: number;
  state: DurableExecutionState;
  desiredState: DurableDesiredState;
  attempt: number;
  jobId: string | null;
  attemptId: string | null;
  costMicroUsdc: number;
  tokens: number;
  output: DurableJsonValue | null;
  error: string | null;
  nodes: Readonly<Record<string, Readonly<{
    state: "running" | "completed" | "failed";
    attempt: number;
    output: DurableJsonValue | null;
    error: string | null;
  }>>>;
  logs: readonly Readonly<{
    sequence: number;
    nodeId: string;
    level: "info" | "warn" | "error";
    message: string;
  }>[];
  logCount: number;
  controlRequests: readonly Readonly<{
    sequence: number;
    action: "cancel" | "pause" | "resume";
  }>[];
  controlRequestCount: number;
  retry: Readonly<{ attempt: number; availableAt: number; error: string }> | null;
  deadLetter: Readonly<{ attempt: number; error: string }> | null;
}>;
