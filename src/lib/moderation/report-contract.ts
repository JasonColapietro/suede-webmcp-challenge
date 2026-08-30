import { z } from "zod";
import {
  MODERATION_REASONS,
  MODERATION_STATUSES,
} from "./types";

const ReferenceId = z.string().trim().min(1).max(256);
const Reason = z.enum(MODERATION_REASONS);

const Common = {
  reason: Reason,
} as const;

export const ModerationReportSubmissionSchema = z.discriminatedUnion("subjectType", [
  z.object({
    subjectType: z.literal("run_output"),
    flowId: ReferenceId,
    runId: ReferenceId,
    nodeId: ReferenceId.optional(),
    ...Common,
  }).strict(),
  z.object({
    subjectType: z.literal("agent_output"),
    agentId: ReferenceId,
    runId: ReferenceId.optional(),
    ...Common,
  }).strict(),
  z.object({
    subjectType: z.literal("agent"),
    agentId: ReferenceId,
    ...Common,
  }).strict(),
]);

export type ModerationReportSubmission = z.infer<typeof ModerationReportSubmissionSchema>;

export const ModerationReportReviewSchema = z.object({
  status: z.enum(MODERATION_STATUSES),
  reviewerNotes: z.string().trim().max(2_000).nullable().optional(),
}).strict();

export const ModerationQueueQuerySchema = z.object({
  status: z.enum(MODERATION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
