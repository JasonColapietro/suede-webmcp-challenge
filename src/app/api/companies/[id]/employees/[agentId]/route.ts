/**
 * PATCH /api/companies/[id]/employees/[agentId] — update the monthly budget
 * cap and/or the employee's own payout wallet for one employee in a company
 * the verified caller owns. A null payTo clears the override so the
 * employee settles to the founder's wallet again (resolvePayout).
 * DELETE terminally deactivates public execution and soft-removes company
 * membership. The underlying agent, immutable deployment, flow, and company
 * activity identity are deliberately preserved.
 */
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { z } from "zod";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import {
  invalidRequestResponse,
  notFoundResponse,
  privateJson,
  readBoundedJsonRequest,
} from "@/lib/projects/api-response";

export const runtime = "nodejs";

const UpdateEmployeeSchema = z
  .object({
    monthlyBudgetUsdc: z.number().nonnegative().nullable().optional(),
    payTo: z.string().trim().nullable().optional(),
  })
  .strict()
  .refine((v) => v.monthlyBudgetUsdc !== undefined || v.payTo !== undefined, {
    message: "Provide monthlyBudgetUsdc and/or payTo",
  });

interface RouteContext {
  params: Promise<{ id: string; agentId: string }>;
}

export async function PATCH(request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id, agentId } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();

    const company = await repo.getCompany(id);
    if (!company || company.ownerId !== owner) return notFoundResponse();

    const employee = await repo.getEmployeeByAgent(agentId);
    if (!employee || employee.companyId !== id) return notFoundResponse();

    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return invalidRequestResponse();
    const parsed = UpdateEmployeeSchema.safeParse(body.data);
    if (!parsed.success) return invalidRequestResponse();

    if (typeof parsed.data.payTo === "string" && !isAddress(parsed.data.payTo)) {
      return privateJson({ error: "payTo is not a valid EVM address (0x…)." }, 400);
    }

    const patch: { monthlyBudgetUsdc?: number | null; payTo?: string | null } = {};
    if (parsed.data.monthlyBudgetUsdc !== undefined) patch.monthlyBudgetUsdc = parsed.data.monthlyBudgetUsdc;
    if (parsed.data.payTo !== undefined) patch.payTo = parsed.data.payTo;

    await repo.updateEmployee(agentId, patch);
    return privateJson({
      employee: {
        ...employee,
        ...(patch.monthlyBudgetUsdc !== undefined ? { monthlyBudgetUsdc: patch.monthlyBudgetUsdc } : {}),
        ...(patch.payTo !== undefined ? { payTo: patch.payTo } : {}),
      },
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}

export async function DELETE(_request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id, agentId } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();

    const company = await repo.getCompany(id);
    if (!company || company.ownerId !== owner) return notFoundResponse();

    const employee = await repo.getEmployeeByAgent(agentId);
    if (!employee || employee.companyId !== id) return notFoundResponse();

    const agent = await repo.getAgent(agentId);
    if (!agent) return notFoundResponse();

    // Deactivate before removing the company gate. A failure after this point
    // leaves the agent safely unpublished instead of publicly callable without
    // company governance.
    const deactivated = await repo.updateAgent(agentId, {
      status: "draft",
      settlementLive: false,
    });
    if (!deactivated || deactivated.status !== "draft" || deactivated.settlementLive) {
      throw new Error("Failed to deactivate employee agent");
    }

    const removed = await repo.removeEmployee(agentId);
    if (!removed) return notFoundResponse();

    return privateJson({ removed: true, agentId });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}
