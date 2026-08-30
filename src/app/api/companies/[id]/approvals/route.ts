/**
 * POST /api/companies/[id]/approvals — two request shapes:
 *   { create: { kind, subjectId } } opens a pending approval.
 *   { decide: { approvalId, decision, reason? } } approves or rejects one;
 *     rejection stores the reason (PRD criterion).
 * Approvals gate enabling live selling, firing a publish-gated employee, and
 * firing a scope whose employee's last completed run cost more than the
 * company's fireCostThresholdUsdc — consumption happens where the gated
 * action actually runs (the fire endpoint, the settlement toggle), not here.
 * See docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md,
 * Task 10 ("create company CRUD, approvals, and the live-selling gate").
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import type { ApprovalKind, ApprovalCostSnapshot } from "@/lib/company/types";
import {
  invalidRequestResponse,
  notFoundResponse,
  privateJson,
  readBoundedJsonRequest,
} from "@/lib/projects/api-response";

export const runtime = "nodejs";

const CostNoteSchema = z.string().trim().min(1).max(300).nullable().optional();
const ApprovalCostSnapshotSchema = z.discriminatedUnion("basis", [
  z.object({
    basis: z.literal("quoted"),
    amountUsdc: z.number().finite().nonnegative(),
    note: CostNoteSchema,
  }),
  z.object({
    basis: z.literal("estimated"),
    amountUsdc: z.number().finite().nonnegative(),
    note: CostNoteSchema,
  }),
  z.object({
    basis: z.literal("unavailable"),
    amountUsdc: z.null().optional(),
    note: CostNoteSchema,
  }),
]);

const CreateApprovalRequestSchema = z.object({
  create: z.object({
    kind: z.enum(["enable_live_selling", "fire_publish_gated", "fire_over_threshold"]),
    subjectId: z.string().min(1),
    actionSummary: z.string().trim().min(1).max(300).optional(),
    costSnapshot: ApprovalCostSnapshotSchema.optional(),
  }),
});

const DecideApprovalRequestSchema = z.object({
  decide: z.object({
    approvalId: z.string().min(1),
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().optional(),
  }),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

function fallbackActionSummary(kind: ApprovalKind, subjectId: string): string {
  if (kind === "enable_live_selling") return `Enable live selling for employee ${subjectId}`;
  if (kind === "fire_publish_gated") return `Run publish-gated employee ${subjectId}`;
  return `Run employee ${subjectId} above the company cost threshold`;
}

function normalizeCostSnapshot(
  snapshot: z.infer<typeof ApprovalCostSnapshotSchema> | undefined,
): ApprovalCostSnapshot {
  if (!snapshot) {
    return {
      basis: "unavailable",
      amountUsdc: null,
      note: "No pre-action quote or estimate was supplied.",
    };
  }
  if (snapshot.basis === "unavailable") {
    return {
      basis: "unavailable",
      amountUsdc: null,
      note: snapshot.note ?? null,
    };
  }
  return {
    basis: snapshot.basis,
    amountUsdc: snapshot.amountUsdc,
    note: snapshot.note ?? null,
  };
}

export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();

    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return invalidRequestResponse();
    const data = body.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return invalidRequestResponse();
    }

    if ("create" in data) {
      const parsed = CreateApprovalRequestSchema.safeParse(data);
      if (!parsed.success) return invalidRequestResponse();

      // Owner check: the company named in the URL must belong to the caller.
      const company = await repo.getCompany(id);
      if (!company || company.ownerId !== owner) return notFoundResponse();

      const approval = await repo.createApproval({
        companyId: id,
        kind: parsed.data.create.kind,
        subjectId: parsed.data.create.subjectId,
        actionSummary: parsed.data.create.actionSummary ?? fallbackActionSummary(
          parsed.data.create.kind,
          parsed.data.create.subjectId,
        ),
        costSnapshot: normalizeCostSnapshot(parsed.data.create.costSnapshot),
      });
      return privateJson({ approval }, 201);
    }

    if ("decide" in data) {
      const parsed = DecideApprovalRequestSchema.safeParse(data);
      if (!parsed.success) return invalidRequestResponse();

      const { approvalId, decision, reason } = parsed.data.decide;

      // Owner check: load the approval first, then its company — the
      // approval's own companyId is the source of truth, not the URL.
      const approval = await repo.getApproval(approvalId);
      if (!approval) return notFoundResponse();
      if (approval.companyId !== id) return notFoundResponse();
      const company = await repo.getCompany(approval.companyId);
      if (!company || company.ownerId !== owner) return notFoundResponse();

      const updated = await repo.decideApproval(approvalId, decision, reason ?? null);
      if (!updated) return privateJson({ error: "not_pending" }, 404);

      return privateJson({ approval: updated });
    }

    return invalidRequestResponse();
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}
