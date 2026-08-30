/**
 * GET /api/companies — the owner's companies with employee count and status.
 * POST /api/companies — found a company from a first-party template
 * (templateToDraft → materializeCompanyDraft). The description-first path
 * (POST /api/companies/found) is a separate, later task.
 * See docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md,
 * Task 10 ("create company CRUD, approvals, and the live-selling gate").
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  resolveOwnerId,
  SUEDE_OWNER_PREFIX,
  UnauthenticatedOwnerError,
} from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { materializeCompanyDraft, templateToDraft } from "@/lib/company/founding";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  invalidRequestResponse,
  privateJson,
  readBoundedJsonRequest,
} from "@/lib/projects/api-response";

export const runtime = "nodejs";

const FoundCompanyRequestSchema = z.object({
  templateSlug: z.string().min(1),
});

export async function GET(): Promise<NextResponse> {
  try {
    const owner = await resolveOwnerId();
    if (!owner.startsWith(SUEDE_OWNER_PREFIX)) {
      return privateJson({ error: "Authentication required" }, 401);
    }
    const repo = await getRepo();
    const companies = await repo.listCompaniesByOwner(owner);
    const companiesOut = await Promise.all(
      companies.map(async (company) => {
        const employees = await repo.listEmployees(company.id);
        return { ...company, employeeCount: employees.length };
      }),
    );
    return privateJson({ companies: companiesOut });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const owner = await resolveOwnerId();
    if (!owner.startsWith(SUEDE_OWNER_PREFIX)) {
      return privateJson({ error: "Authentication required" }, 401);
    }

    // Founding writes a flow + agent per template employee, so bound the
    // rate the same way /api/guided bounds Guided turns (6 burst, 1/10s).
    const limited = checkRateLimit(`company-found:${owner}`, { capacity: 6, refillPerSec: 0.1 });
    if (!limited.allowed) {
      return privateJson(
        { error: "rate limited", retryAfterSec: limited.retryAfterSec },
        429,
        { "Retry-After": String(limited.retryAfterSec) },
      );
    }

    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return invalidRequestResponse();
    const parsed = FoundCompanyRequestSchema.safeParse(body.data);
    if (!parsed.success) return invalidRequestResponse();

    const draft = templateToDraft(parsed.data.templateSlug);
    if (!draft) {
      return privateJson({ error: "unknown_template" }, 400);
    }

    const repo = await getRepo();
    const { companyId } = await materializeCompanyDraft(owner, draft, repo);
    return privateJson({ companyId }, 201);
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}
