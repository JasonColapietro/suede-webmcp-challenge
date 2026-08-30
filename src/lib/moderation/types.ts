export const MODERATION_SUBJECT_TYPES = ["run_output", "agent_output", "agent"] as const;
export type ModerationSubjectType = (typeof MODERATION_SUBJECT_TYPES)[number];

export const MODERATION_REASONS = [
  "sexual_content",
  "hate_or_harassment",
  "violence_or_self_harm",
  "illegal_or_dangerous",
  "privacy_or_personal_data",
  "deceptive_or_misleading",
  "other_unsafe_content",
] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];

export const MODERATION_STATUSES = ["open", "reviewing", "resolved", "dismissed"] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

/**
 * A bounded moderation reference. Generated output, prompts, credentials, and
 * other run payloads are deliberately absent: reviewers follow the server-side
 * ids to the authoritative record instead of copying sensitive content into a
 * second database surface.
 */
export interface ModerationReportRecord {
  id: string;
  reporterOwnerId: string;
  subjectOwnerId: string;
  subjectType: ModerationSubjectType;
  flowId: string | null;
  runId: string | null;
  nodeId: string | null;
  agentId: string | null;
  reason: ModerationReason;
  status: ModerationStatus;
  reviewerNotes: string | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}

export interface CreateModerationReportInput {
  reporterOwnerId: string;
  subjectOwnerId: string;
  subjectType: ModerationSubjectType;
  flowId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  reason: ModerationReason;
}

export interface ModerationQueueQuery {
  status?: ModerationStatus;
  limit: number;
}

export interface UpdateModerationReportInput {
  status: ModerationStatus;
  reviewerNotes?: string | null;
  reviewedBy: string;
}
