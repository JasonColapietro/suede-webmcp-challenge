import { describe, expect, it } from "vitest";
import {
  ModerationQueueQuerySchema,
  ModerationReportReviewSchema,
  ModerationReportSubmissionSchema,
} from "@/lib/moderation/report-contract";

describe("moderation report contracts", () => {
  it("accepts bounded references without generated output", () => {
    const parsed = ModerationReportSubmissionSchema.parse({
      subjectType: "run_output",
      flowId: "flow-1",
      runId: "run-1",
      nodeId: "node-1",
      reason: "other_unsafe_content",
    });

    expect(parsed).toEqual({
      subjectType: "run_output",
      flowId: "flow-1",
      runId: "run-1",
      nodeId: "node-1",
      reason: "other_unsafe_content",
    });
  });

  it("rejects raw output and unknown client-supplied ownership fields", () => {
    expect(() => ModerationReportSubmissionSchema.parse({
      subjectType: "run_output",
      flowId: "flow-1",
      runId: "run-1",
      reason: "privacy_or_personal_data",
      output: "raw generated output",
    })).toThrow();

    expect(() => ModerationReportSubmissionSchema.parse({
      subjectType: "agent",
      agentId: "agent-1",
      subjectOwnerId: "someone-else",
      reason: "deceptive_or_misleading",
    })).toThrow();

    expect(() => ModerationReportSubmissionSchema.parse({
      subjectType: "agent",
      agentId: "agent-1",
      reason: "other_unsafe_content",
      details: "free text is not accepted",
    })).toThrow();
  });

  it("enforces reference and reviewer-note bounds", () => {
    expect(() => ModerationReportSubmissionSchema.parse({
      subjectType: "agent",
      agentId: "a".repeat(257),
      reason: "other_unsafe_content",
    })).toThrow();
    expect(() => ModerationReportReviewSchema.parse({
      status: "resolved",
      reviewerNotes: "x".repeat(2_001),
    })).toThrow();
  });

  it("caps moderation queue reads", () => {
    expect(ModerationQueueQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(() => ModerationQueueQuerySchema.parse({ limit: 101 })).toThrow();
  });
});
