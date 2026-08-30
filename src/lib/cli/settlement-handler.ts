/**
 * Settlement toggle handler for POST /api/agents/[agent]/settlement
 *
 * Flips per-agent settlement_live boolean.
 * Only the agent's owner (identified by workspace Bearer key) may flip it.
 *
 * ACTUAL BEHAVIOR (verified against src/lib/db/sqlite-repo.ts createAgent()
 * and src/lib/db/schema.deploy.sql): settlement_live defaults to TRUE
 * (opt-out), not false. This was a deliberate migration-safety choice —
 * prod ran fully live before this column existed, and dry-run also disables
 * the x402 payment gate, so a false default would have silently made every
 * pre-existing priced agent free to call. See sqlite-repo.ts's own comment
 * and AI_HANDOFF Phase 9 hotfix for the history. This endpoint lets an owner
 * explicitly flip settlement off (or back on) per agent; it does not gate
 * whether a newly-created agent starts live — creation does that today.
 *
 * Autonomous Company live-selling gate: when the agent being flipped to
 * live is a company employee (repo.getEmployeeByAgent), the flip requires
 * an APPROVED approval of kind "enable_live_selling" whose subjectId is
 * this agent. The approval is consumed on success so one approval buys
 * exactly one flip to live. Flips to false stay ungated — a founder can
 * always pull an employee back to dry-run. See
 * docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md, Task 10.
 */
import type { AgentRecord, FlowRepo } from "@/lib/db/repo";
import { findConsumableApproval } from "@/lib/company/guardrails";

export interface SettlementToggleInput {
  /** New desired value for settlement_live. */
  live: boolean;
}

export interface SettlementToggleResult {
  agentId: string;
  slug: string;
  settlementLive: boolean;
}

export type SettlementToggleError =
  | { kind: "not_found" }
  | { kind: "not_owner" }
  | { kind: "bad_input" }
  | { kind: "approval_required" };

/**
 * Toggle settlement_live for an agent identified by slug or id.
 * Returns the updated agent state or an error discriminant.
 */
export async function handleSettlementToggle(
  slugOrId: string,
  ownerId: string,
  input: SettlementToggleInput,
  repo: FlowRepo,
): Promise<SettlementToggleResult | SettlementToggleError> {
  // Resolve agent by slug first, then by id.
  let agent = await repo.getAgentBySlug(slugOrId);
  if (!agent) {
    agent = await repo.getAgent(slugOrId);
  }
  if (!agent) {
    return { kind: "not_found" };
  }

  // Owner check — the agent's flow must belong to the caller.
  const flow = await repo.getFlow(agent.flowId);
  if (!flow || flow.ownerId !== ownerId) {
    return { kind: "not_owner" };
  }

  let consumedApprovalId: string | null = null;
  if (input.live) {
    // Tolerate repo mocks/impls that predate the company domain and don't
    // implement getEmployeeByAgent — treat them as "not an employee" rather
    // than throwing.
    const employee = typeof repo.getEmployeeByAgent === "function"
      ? await repo.getEmployeeByAgent(agent.id)
      : null;
    if (employee) {
      const approvedApprovals = await repo.listApprovals(employee.companyId, "approved");
      const approval = findConsumableApproval(approvedApprovals, "enable_live_selling", agent.id);
      if (!approval) {
        return { kind: "approval_required" };
      }
      // Consume before flipping so one approval buys exactly one flip.
      // The boolean is the concurrency enforcement result: another request
      // may have consumed the same approved row after our read. That losing
      // request must stay dry rather than treating a stale approval snapshot
      // as authorization.
      if (!await repo.consumeApproval(approval.id)) {
        return { kind: "approval_required" };
      }
      consumedApprovalId = approval.id;
    }
  }

  let updated: AgentRecord | null;
  try {
    updated = await repo.updateAgent(agent.id, { settlementLive: input.live });
  } catch (error: unknown) {
    // An interrupted database response is ambiguous: re-read before
    // compensating so a write that actually committed cannot reuse its
    // one-use approval. If the desired state is observable, treat the
    // guarded action as complete.
    let observed;
    try {
      observed = await repo.getAgent(agent.id);
    } catch {
      throw error;
    }
    if (observed?.settlementLive === input.live) {
      updated = observed;
    } else {
      if (consumedApprovalId && !await repo.restoreApproval(consumedApprovalId)) {
        throw new Error(`failed to restore consumed approval ${consumedApprovalId}`);
      }
      throw error;
    }
  }
  if (!updated) {
    if (consumedApprovalId && !await repo.restoreApproval(consumedApprovalId)) {
      throw new Error(`failed to restore consumed approval ${consumedApprovalId}`);
    }
    return { kind: "not_found" };
  }
  if (updated.settlementLive !== input.live) {
    if (consumedApprovalId && !await repo.restoreApproval(consumedApprovalId)) {
      throw new Error(`failed to restore consumed approval ${consumedApprovalId}`);
    }
    throw new Error("settlement update did not reach requested state");
  }

  return {
    agentId: updated.id,
    slug: updated.slug,
    settlementLive: updated.settlementLive,
  };
}
