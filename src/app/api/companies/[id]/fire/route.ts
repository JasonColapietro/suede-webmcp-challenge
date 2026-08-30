/**
 * Manual company fire — POST /api/companies/[id]/fire. Runs every employee
 * in the requested scope (the whole company, one department, or a single
 * employee) through the same guardrails and run-mode resolution the
 * unattended tick will later reuse (src/lib/company/guardrails.ts,
 * src/lib/run-mode.ts, src/app/api/cron/tick/route.ts). A draft company
 * always dry-runs (resolveRunMode's requestedDryRun); an active company
 * settles live only when both the platform and the employee agent are
 * live, exactly like the tick and the agent run route.
 *
 * Residual concurrency note: guardrails re-evaluate per employee inside
 * this loop (not once per request) and the fire rate limit bounds burst
 * size, but a check-then-run race across two concurrent fire requests can
 * still overspend a budget by at most one extra run — accepted per the
 * plan's risk register (Task 9).
 *
 * See docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md,
 * Task 9, and docs/superpowers/plans/2026-07-17-autonomous-company-prd.md.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  resolveOwnerId,
  SUEDE_OWNER_PREFIX,
  UnauthenticatedOwnerError,
} from "@/lib/auth";
import { getRepo, type FlowRepo } from "@/lib/db/repo";
import type { DepartmentRecord, EmployeeRecord } from "@/lib/company/types";
import { fireBlocksForEmployee, findConsumableApproval, type FireBlock } from "@/lib/company/guardrails";
import { resolveRunMode } from "@/lib/run-mode";
import { runPublishedLiveToCompletion, runToCompletion } from "@/lib/run-service";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Fires are heavy (they can trigger live settlement): 4 burst, one refill every 20s. */
const FIRE_RL_OPTS = { capacity: 4, refillPerSec: 0.05 };

const fireBodySchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("company") }),
  z.object({ scope: z.literal("department"), targetId: z.string().trim().min(1) }),
  z.object({ scope: z.literal("employee"), targetId: z.string().trim().min(1) }),
]);

interface RouteContext {
  params: Promise<{ id: string }>;
}

type FireResultReason = FireBlock["code"] | "agent_missing" | "flow_missing";

interface FireResult {
  agentId: string;
  ran: boolean;
  dryRun?: boolean;
  runId?: string;
  reason?: FireResultReason;
}

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  return key.length > 0 ? key : null;
}

/**
 * Cookie-authenticated browser fires must prove exact same-origin JSON.
 * Programmatic callers use the anonymous workspace key as a Bearer token,
 * matching the settlement mutation lane.
 */
function validateSessionMutation(req: Request): 403 | 415 | null {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(req.url).origin;
  } catch {
    return 403;
  }
  if (req.headers.get("origin") !== expectedOrigin) return 403;
  if (req.headers.get("sec-fetch-site") !== "same-origin") return 403;
  if (req.headers.has("content-encoding")) return 415;
  const contentType = req.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return contentType === "application/json" ? null : 415;
}

/**
 * Mirrors the fire-cost-threshold predicate inside fireBlocksForEmployee's
 * check 4 (src/lib/company/guardrails.ts) so the route can tell, AFTER a
 * passing guardrails call, whether the pass was threshold-approval-backed —
 * and therefore whether to consume the fire_over_threshold approval.
 * guardrails.ts does not export the raw predicate, so this must be kept in
 * sync with its check 4 by hand.
 */
async function mostRecentCompletedRunCostUsdc(
  repo: FlowRepo,
  flowId: string,
  agentId: string,
): Promise<number | null> {
  const runs = await repo.listRuns(flowId);
  const completed = runs.filter((r) => r.finishedAt !== null && r.agentId === agentId);
  const mostRecent = [...completed].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  return mostRecent ? mostRecent.totalCostUsdc : null;
}

/**
 * Return only approvals this request successfully consumed. The conditional
 * repo transition prevents this compensation from reviving an approval that
 * some unrelated state change has already moved elsewhere.
 */
async function restoreConsumedApprovals(repo: FlowRepo, approvalIds: string[]): Promise<void> {
  for (const approvalId of [...approvalIds].reverse()) {
    if (!await repo.restoreApproval(approvalId)) {
      throw new Error(`failed to restore consumed approval ${approvalId}`);
    }
  }
}

export async function POST(req: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const authorization = req.headers.get("authorization");
    const bearerOwner = extractBearer(authorization);
    if (authorization !== null && bearerOwner === null) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    if (bearerOwner?.startsWith(SUEDE_OWNER_PREFIX)) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    if (bearerOwner === null) {
      const requestFailure = validateSessionMutation(req);
      if (requestFailure === 403) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (requestFailure === 415) {
        return NextResponse.json({ error: "Unsupported media type" }, { status: 415 });
      }
    }

    const { id } = await params;
    const raw: unknown = await req.json().catch(() => ({}));
    const parsed = fireBodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid request body" }, { status: 400 });
    }

    const owner = bearerOwner ?? await resolveOwnerId();

    const rl = checkRateLimit(`fire:${owner}`, FIRE_RL_OPTS);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "rate_limited", message: `Too many requests. Retry after ${rl.retryAfterSec}s.` },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }

    const repo = await getRepo();
    const company = await repo.getCompany(id);
    if (!company || company.ownerId !== owner) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (company.status === "paused") {
      return NextResponse.json({ error: "company_paused" }, { status: 409 });
    }

    const [allEmployees, employeeHistory, departments] = await Promise.all([
      repo.listEmployees(company.id),
      repo.listCompanyEmployeeHistory(company.id),
      repo.listDepartments(company.id),
    ]);
    const departmentsById = new Map<string, DepartmentRecord>(departments.map((d) => [d.id, d]));
    const departmentAgentIds = new Map<string, string[]>();
    for (const e of employeeHistory) {
      const list = departmentAgentIds.get(e.departmentId) ?? [];
      list.push(e.agentId);
      departmentAgentIds.set(e.departmentId, list);
    }

    let scopedEmployees: EmployeeRecord[];
    if (parsed.data.scope === "company") {
      scopedEmployees = allEmployees;
    } else if (parsed.data.scope === "department") {
      const targetId = parsed.data.targetId;
      const department = departmentsById.get(targetId);
      if (!department) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      scopedEmployees = allEmployees.filter((e) => e.departmentId === department.id);
    } else {
      const targetId = parsed.data.targetId;
      const employee = allEmployees.find((e) => e.agentId === targetId);
      if (!employee) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      scopedEmployees = [employee];
    }

    // One snapshot of approved approvals for the whole request. Every
    // employee's post-pass consume decision below reads this same list —
    // fireBlocksForEmployee takes its own snapshot internally for the block
    // check; this one backs the route's separate "which approval paid for
    // this pass" decision.
    const approvedApprovals = await repo.listApprovals(company.id, "approved");
    // Read once per request, not per employee — every employee this fire
    // touches sees the same platform-live state (mirrors the tick).
    const globalLive = process.env.X402_SKIP_SETTLEMENT === "false";

    const results: FireResult[] = [];

    for (const employee of scopedEmployees) {
      const agent = await repo.getAgent(employee.agentId);
      if (!agent) {
        results.push({ agentId: employee.agentId, ran: false, reason: "agent_missing" });
        continue;
      }
      const flow = await repo.getFlow(agent.flowId);
      if (!flow) {
        results.push({ agentId: employee.agentId, ran: false, reason: "flow_missing" });
        continue;
      }

      const department = departmentsById.get(employee.departmentId);
      if (!department) {
        // Schema invariant: company_employees.department_id is a NOT NULL FK
        // onto company_departments, and the repo exposes no department
        // delete, so this is unreachable in practice. Fail loudly rather
        // than silently mis-evaluate guardrails for this employee.
        throw new Error(
          `employee ${employee.agentId} references missing department ${employee.departmentId}`,
        );
      }

      const block = await fireBlocksForEmployee({
        repo,
        company,
        department,
        employee,
        departmentAgentIds: departmentAgentIds.get(employee.departmentId) ?? [employee.agentId],
        now: new Date(),
      });

      if (block) {
        results.push({ agentId: employee.agentId, ran: false, reason: block.code });
        continue;
      }

      // Resolve every required approval before consuming any. This avoids
      // burning the publish approval merely because a later threshold
      // approval is absent from this request's snapshot.
      const requiredApprovals: Array<{
        id: string;
        failureReason: "approval_required_publish_gated" | "approval_required_over_threshold";
      }> = [];
      if (employee.publishGated) {
        const approval = findConsumableApproval(approvedApprovals, "fire_publish_gated", employee.agentId);
        if (!approval) {
          results.push({
            agentId: employee.agentId,
            ran: false,
            reason: "approval_required_publish_gated",
          });
          continue;
        }
        requiredApprovals.push({ id: approval.id, failureReason: "approval_required_publish_gated" });
      }
      if (company.fireCostThresholdUsdc !== null) {
        const lastCost = await mostRecentCompletedRunCostUsdc(repo, flow.id, employee.agentId);
        if (lastCost !== null && lastCost > company.fireCostThresholdUsdc) {
          const approval = findConsumableApproval(approvedApprovals, "fire_over_threshold", employee.agentId);
          if (!approval) {
            results.push({
              agentId: employee.agentId,
              ran: false,
              reason: "approval_required_over_threshold",
            });
            continue;
          }
          requiredApprovals.push({ id: approval.id, failureReason: "approval_required_over_threshold" });
        }
      }

      // Consume before running so concurrent requests cannot share one-use
      // authority. If a later consume loses the race, restore only the rows
      // this request already won before reporting the losing gate.
      const consumedApprovalIds: string[] = [];
      let lostApprovalReason: "approval_required_publish_gated" | "approval_required_over_threshold" | null = null;
      for (const approval of requiredApprovals) {
        if (!await repo.consumeApproval(approval.id)) {
          await restoreConsumedApprovals(repo, consumedApprovalIds);
          lostApprovalReason = approval.failureReason;
          break;
        }
        consumedApprovalIds.push(approval.id);
      }
      if (lostApprovalReason) {
        results.push({ agentId: employee.agentId, ran: false, reason: lostApprovalReason });
        continue;
      }

      const { dryRun } = resolveRunMode({
        requestedDryRun: company.status === "draft",
        globalLive,
        agentSettlementLive: agent.settlementLive,
      });

      let compensationStarted = false;
      try {
        if (dryRun) {
          const summary = await runToCompletion(flow.graph, {
            trigger: "company-fire",
            agentId: employee.agentId,
            flowId: flow.id,
            dryRun: true,
          });
          results.push({ agentId: employee.agentId, ran: true, dryRun: true, runId: summary.runId });
        } else {
          const summary = await runPublishedLiveToCompletion({
            flowId: flow.id,
            ownerId: flow.ownerId,
            agentId: employee.agentId,
            trigger: "company-fire",
          });
          if (!summary) {
            compensationStarted = true;
            await restoreConsumedApprovals(repo, consumedApprovalIds);
            return NextResponse.json({ error: "connection service unavailable" }, { status: 503 });
          }
          results.push({ agentId: employee.agentId, ran: true, dryRun: false, runId: summary.runId });
        }
      } catch (error: unknown) {
        if (!compensationStarted) {
          await restoreConsumedApprovals(repo, consumedApprovalIds);
        }
        throw error;
      }
    }

    return NextResponse.json({ results });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Never surface raw error.message on the money path — log server-side,
    // return an opaque error to the client (mirrors src/app/api/agents/[agent]/run/route.ts).
    console.error("company fire failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
