/**
 * The CEO — a persistent, per-company chat thread. The founder tells an
 * already-founded company's CEO assistant what to change (hire, let an
 * employee go, or change a budget); it proposes exactly one action and
 * only executes it once the founder confirms in a later message. See
 * src/lib/company/ceo.ts for the brain. Every write here is the same repo
 * call an existing path already makes: hireEmployeeIntoCompany mirrors
 * founding's per-employee steps; the fireEmployee branch mirrors
 * DELETE /api/companies/[id]/employees/[agentId] exactly; the budget
 * branch mirrors the department/employee PATCH routes exactly.
 *
 * GET returns the persisted conversation. POST advances it by one turn.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo, type FlowRepo } from "@/lib/db/repo";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import {
  invalidRequestResponse,
  notFoundResponse,
  privateJson,
  readBoundedJsonRequest,
} from "@/lib/projects/api-response";
import { runCeoTurn, type CeoActionProposal } from "@/lib/company/ceo";
import { hireEmployeeIntoCompany } from "@/lib/company/founding";
import type { CompanyRecord, DepartmentRecord, EmployeeRecord } from "@/lib/company/types";

export const runtime = "nodejs";

const CEO_MESSAGE_MAX = 2_000;
const CEO_HISTORY_LIMIT = 40;

const CeoMessageRequestSchema = z
  .object({ message: z.string().trim().min(1).max(CEO_MESSAGE_MAX) })
  .strict();

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface ExecutedSummary {
  kind: CeoActionProposal["kind"];
}

function validateSessionMutation(request: Request): 403 | 415 | null {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(request.url).origin;
  } catch {
    return 403;
  }
  if (request.headers.get("origin") !== expectedOrigin) return 403;
  if (request.headers.get("sec-fetch-site") !== "same-origin") return 403;
  if (request.headers.has("content-encoding")) return 415;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json" ? null : 415;
}

/**
 * Executes a confirmed proposal. Re-checks the referenced department or
 * employee still exists in the CURRENT state before writing — the
 * proposal may be stale by the time the founder confirms it.
 */
async function executeProposal(
  repo: FlowRepo,
  owner: string,
  company: CompanyRecord,
  departments: DepartmentRecord[],
  employees: EmployeeRecord[],
  proposal: CeoActionProposal,
): Promise<{ reply: string; executed: ExecutedSummary | null }> {
  if (proposal.kind === "hire") {
    if (!departments.some((d) => d.id === proposal.departmentId)) {
      return { reply: `${proposal.departmentName} no longer exists. Nothing changed.`, executed: null };
    }
    await hireEmployeeIntoCompany(
      owner,
      {
        companyId: company.id,
        departmentId: proposal.departmentId,
        slug: proposal.slug,
        jobDescription: proposal.jobDescription,
        monthlyBudgetUsdc: proposal.monthlyBudgetUsdc,
        manifest: proposal.manifest,
      },
      repo,
    );
    return {
      reply: `Hired. "${proposal.jobDescription}" is now on the ${proposal.departmentName} team as a draft employee.`,
      executed: { kind: "hire" },
    };
  }

  if (proposal.kind === "fireEmployee") {
    const employee = employees.find((e) => e.agentId === proposal.agentId);
    if (!employee) {
      return { reply: "That employee is already gone. Nothing changed.", executed: null };
    }
    // Deactivate before removing the company gate — mirrors DELETE
    // /api/companies/[id]/employees/[agentId] exactly.
    const deactivated = await repo.updateAgent(proposal.agentId, { status: "draft", settlementLive: false });
    if (!deactivated || deactivated.status !== "draft" || deactivated.settlementLive) {
      throw new Error("Failed to deactivate employee agent");
    }
    const removed = await repo.removeEmployee(proposal.agentId);
    if (!removed) {
      return { reply: "That employee is already gone. Nothing changed.", executed: null };
    }
    return {
      reply: `Done. "${proposal.employeeSummary}" is removed from the company. Their agent stops running publicly, but their history is kept.`,
      executed: { kind: "fireEmployee" },
    };
  }

  if (proposal.kind === "createDepartment") {
    // Re-check against CURRENT departments — the founder may have created it
    // through the form between proposal and confirmation.
    const duplicate = departments.find((d) => d.name.toLowerCase() === proposal.name.toLowerCase());
    if (duplicate) {
      return { reply: `${duplicate.name} already exists. Nothing changed.`, executed: null };
    }
    // Same repo write as POST /api/companies/[id]/departments.
    await repo.createDepartment({
      companyId: company.id,
      name: proposal.name,
      monthlyBudgetUsdc: proposal.monthlyBudgetUsdc,
    });
    return {
      reply: `Done. The ${proposal.name} department is on the org chart. No one runs until you hire into it.`,
      executed: { kind: "createDepartment" },
    };
  }

  if (proposal.target === "department") {
    if (!departments.some((d) => d.id === proposal.targetId)) {
      return { reply: `${proposal.targetName} no longer exists. Nothing changed.`, executed: null };
    }
    await repo.setDepartmentBudget(proposal.targetId, proposal.monthlyBudgetUsdc);
  } else {
    if (!employees.some((e) => e.agentId === proposal.targetId)) {
      return { reply: "That employee is already gone. Nothing changed.", executed: null };
    }
    await repo.updateEmployee(proposal.targetId, { monthlyBudgetUsdc: proposal.monthlyBudgetUsdc });
  }
  const amount = proposal.monthlyBudgetUsdc === null ? "no cap" : `$${proposal.monthlyBudgetUsdc}/mo`;
  return {
    reply: `Done. ${proposal.targetName}'s monthly budget is now ${amount}.`,
    executed: { kind: "budget" },
  };
}

export async function GET(_request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();

    const company = await repo.getCompany(id);
    if (!company || company.ownerId !== owner) return notFoundResponse();

    const messages = await repo.listCeoMessages(id, CEO_HISTORY_LIMIT);
    return privateJson({ messages });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}

export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const requestFailure = validateSessionMutation(request);
    if (requestFailure === 403) return privateJson({ error: "Forbidden" }, 403);
    if (requestFailure === 415) return privateJson({ error: "Unsupported media type" }, 415);

    const { id } = await params;
    const owner = await resolveOwnerId();

    const rl = checkRateLimit(`ceo:${owner}`, { capacity: 10, refillPerSec: 0.15 });
    if (!rl.allowed) {
      return privateJson(
        { error: "rate_limited", message: `Too many requests. Retry after ${rl.retryAfterSec}s.` },
        429,
        { "Retry-After": String(rl.retryAfterSec) },
      );
    }

    const repo = await getRepo();
    const company = await repo.getCompany(id);
    if (!company || company.ownerId !== owner) return notFoundResponse();

    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return invalidRequestResponse();
    const parsed = CeoMessageRequestSchema.safeParse(body.data);
    if (!parsed.success) return invalidRequestResponse();

    const [departments, employees, history] = await Promise.all([
      repo.listDepartments(company.id),
      repo.listEmployees(company.id),
      repo.listCeoMessages(company.id, CEO_HISTORY_LIMIT),
    ]);

    // Billing context for the real brain. Without it the CEO answers from its
    // deterministic brain — a working path, not an error — so an unpaid
    // workspace still runs its company without spending the funded model key.
    const turn = await runCeoTurn(
      parsed.data.message,
      history,
      { company, departments, employees },
      { ownerId: owner, repo, ip: ipFromRequest(request) },
    );

    await repo.appendCeoMessage({ companyId: company.id, role: "user", content: parsed.data.message });

    if (turn.kind === "confirmed") {
      const outcome = await executeProposal(repo, owner, company, departments, employees, turn.proposal);
      await repo.appendCeoMessage({
        companyId: company.id,
        role: "assistant",
        content: outcome.reply,
        proposal: null,
      });
      return privateJson({ reply: outcome.reply, proposal: null, executed: outcome.executed });
    }

    const proposal = turn.kind === "response" ? turn.proposal : null;
    await repo.appendCeoMessage({
      companyId: company.id,
      role: "assistant",
      content: turn.reply,
      proposal,
    });
    return privateJson({ reply: turn.reply, proposal, executed: null });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    console.error("company ceo turn failed", error);
    return privateJson({ error: "internal error" }, 500);
  }
}
