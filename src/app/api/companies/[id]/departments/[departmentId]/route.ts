/**
 * PATCH /api/companies/[id]/departments/[departmentId] — update the monthly
 * budget cap for one department in a company the verified caller owns.
 */
import { NextResponse } from "next/server";
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

const UpdateDepartmentBudgetSchema = z
  .object({ monthlyBudgetUsdc: z.number().nonnegative().nullable() })
  .strict();

interface RouteContext {
  params: Promise<{ id: string; departmentId: string }>;
}

export async function PATCH(request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id, departmentId } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();

    const company = await repo.getCompany(id);
    if (!company || company.ownerId !== owner) return notFoundResponse();

    const department = (await repo.listDepartments(id)).find(
      (candidate) => candidate.id === departmentId,
    );
    if (!department) return notFoundResponse();

    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return invalidRequestResponse();
    const parsed = UpdateDepartmentBudgetSchema.safeParse(body.data);
    if (!parsed.success) return invalidRequestResponse();

    await repo.setDepartmentBudget(departmentId, parsed.data.monthlyBudgetUsdc);
    return privateJson({
      department: { ...department, monthlyBudgetUsdc: parsed.data.monthlyBudgetUsdc },
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}
