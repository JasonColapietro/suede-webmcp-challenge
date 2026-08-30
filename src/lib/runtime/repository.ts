import type { DurableExecutionEventV1, DurableExecutionProjection, DurableJsonValue } from "./types";
import type { FailureClassification } from "./retry-policy";
import type { DurableInvocationV1 } from "./invocation";

export interface CreateExecutionInput {
  ownerId: string;
  executionId: string;
  jobId: string;
  flowId: string;
  flowVersionId: string;
  frozenDefinition: DurableJsonValue;
  definitionHash: string;
  trigger: Readonly<{ type: "api" | "schedule" | "webhook" | "retry" | "fork"; id?: string }>;
  priority: number;
  availableAt: number;
  maxAttempts: number;
  costBudgetMicroUsdc: number;
  tokenBudget: number;
  createdAt: number;
  deadlineAt?: number;
  idempotency: Readonly<{ namespace: string; key: string; expiresAt: number }>;
  invocation: Readonly<{ json: string; hash: string }>;
}

export type CreateExecutionResult =
  | { status: "created" | "duplicate"; execution: DurableExecutionProjection }
  | { status: "conflict" | "not-found" | "refused" };

export type RebuildProjectionResult =
  | { status: "equal"; projection: DurableExecutionProjection; projectionJson: string }
  | { status: "mismatch"; projection: DurableExecutionProjection; projectionJson: string };

export interface ClaimNextJobInput { workerId: string; leaseDurationMs: number }
export type DurableJobClaim = Readonly<{
  executionId: string; jobId: string; attemptId: string; attemptNumber: number;
  workerId: string; leaseToken: string; leaseExpiresAt: number;
  ownerId: string; flowId: string; flowVersionId: string;
  eventSequence: number;
  totalEventBytes: number; nodeEventBytes: number;
  frozenDefinition: DurableJsonValue; deadlineAt: number | null;
  costBudgetMicroUsdc: number; tokenBudget: number;
  invocation: DurableInvocationV1;
}>;
export type ClaimNextJobResult = { status: "claimed"; claim: DurableJobClaim } | { status: "no-job" | "refused" };

export interface LeaseIdentity { jobId: string; attemptId: string; leaseToken: string }
export type HeartbeatResult =
  | { status: "extended" | "retained"; leaseExpiresAt: number; desiredState: "running" | "paused" | "cancelled"; cancelRequested: boolean }
  | { status: "lost" | "refused" };
type LeasedEvent = Extract<DurableExecutionEventV1, { type: "node.started" | "node.logged" | "node.completed" | "node.failed" }>;
export type LeasedEventDraft = LeasedEvent extends infer TEvent
  ? TEvent extends LeasedEvent
    ? Omit<TEvent, "executionId" | "sequence" | "attempt" | "at">
    : never
  : never;
export interface AppendLeasedEventInput extends LeaseIdentity {
  expectedSequence: number;
  event: LeasedEventDraft;
}
export type LeasedTransitionResult =
  | { status: "appended" | "completed" | "failed" | "retry-scheduled" | "cancelled" | "dead-lettered"; execution: DurableExecutionProjection }
  | { status: "conflict" | "lost" | "refused" | "budget-exhausted" };

export type ControlExecutionResult =
  | Readonly<{ status: "applied" | "idempotent"; execution: DurableExecutionProjection }>
  | Readonly<{ status: "conflict" | "not-found" | "refused" }>;

export type DurableExecutionOwnerView = Readonly<{
  executionId: string;
  flowId: string;
  flowVersionId: string;
  parentExecutionId: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  deadlineAt: number | null;
  projection: DurableExecutionProjection;
}>;

export type RetryExecutionResult =
  | Readonly<{ status: "created" | "duplicate"; execution: DurableExecutionOwnerView }>
  | Readonly<{ status: "conflict" | "not-found" | "refused" }>;

export interface DurableRuntimeRepository {
  createExecution(input: CreateExecutionInput): Promise<CreateExecutionResult>;
  getExecution(ownerId: string, executionId: string): Promise<DurableExecutionProjection | null>;
  hasExecution(ownerId: string, executionId: string): Promise<boolean>;
  getExecutionView(ownerId: string, executionId: string): Promise<DurableExecutionOwnerView | null>;
  listEvents(ownerId: string, executionId: string, afterSequence: number, limit: number): Promise<readonly DurableExecutionEventV1[]>;
  rebuildProjection(ownerId: string, executionId: string): Promise<RebuildProjectionResult | null>;
  claimNextJob(input: ClaimNextJobInput): Promise<ClaimNextJobResult>;
  heartbeat(input: LeaseIdentity & Readonly<{ leaseDurationMs: number }>): Promise<HeartbeatResult>;
  appendLeasedEvent(input: AppendLeasedEventInput): Promise<LeasedTransitionResult>;
  completeAttempt(input: LeaseIdentity & Readonly<{ output: DurableJsonValue }>): Promise<LeasedTransitionResult>;
  failAttempt(input: LeaseIdentity & Readonly<{ classification: FailureClassification; error: string }>): Promise<LeasedTransitionResult>;
  pauseAttempt(input: LeaseIdentity): Promise<LeasedTransitionResult>;
  controlExecution(ownerId: string, executionId: string, action: "pause" | "cancel" | "resume"): Promise<ControlExecutionResult>;
  retryExecution(input: Readonly<{ ownerId: string; sourceExecutionId: string; executionId: string; jobId: string; idempotencyKey: string; expiresAt: number }>): Promise<RetryExecutionResult>;
  recoverExpiredLeases(input: Readonly<{ limit: number }>): Promise<Readonly<{ status: "recovered"; recovered: number; retried: number; deadLettered: number }> | Readonly<{ status: "refused" }>>;
}
