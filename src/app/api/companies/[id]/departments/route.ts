/**
 * POST /api/companies/[id]/departments — add a department to a company the
 * caller owns. A founder can grow the org chart without any employee
 * running (PRD criterion).
 * See docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md,
 * Task 10 ("create company CRUD, approvals, and the live-selling gate").
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

const CreateDepartmentRequestSchema = z.object({
  name: z.string().min(1),
  monthlyBudgetUsdc: z.number().nonnegative().nullable().optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();

    const company = await repo.getCompany(id);
    if (!company || company.ownerId !== owner) return notFoundResponse();

    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return invalidRequestResponse();
    const parsed = CreateDepartmentRequestSchema.safeParse(body.data);
    if (!parsed.success) return invalidRequestResponse();

    const department = await repo.createDepartment({
      companyId: id,
      name: parsed.data.name,
      monthlyBudgetUsdc: parsed.data.monthlyBudgetUsdc ?? null,
    });

    return privateJson({ department }, 201);
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}
