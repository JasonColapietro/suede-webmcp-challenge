import type { FlowRepo } from "@/lib/db/repo";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import { isFlowGraphV2 } from "@/lib/flow/graph-schema";
import { flowToManifest } from "@/lib/manifest/from-flow";

/**
 * Static company gates that must agree with the public paid-run boundary
 * before discovery may advertise AP2 for an employee. Monthly budget is a
 * dynamic quota and remains a runtime 429; paused, gated, detached, and
 * non-paid employees are not discoverable as AP2-capable services.
 */
export async function companyServiceSupportsPublicAp2(input: {
  readonly repo: FlowRepo;
  readonly agentId: string;
  readonly graph: SupportedFlowGraph;
}): Promise<boolean> {
  try {
    const employee = await input.repo.getEmployeeByAgent(input.agentId);
    if (!employee) return true;
    if (employee.publishGated) return false;

    const [company, departments] = await Promise.all([
      input.repo.getCompany(employee.companyId),
      input.repo.listDepartments(employee.companyId),
    ]);
    if (company?.status !== "active"
      || !departments.some((department) => department.id === employee.departmentId)) {
      return false;
    }

    const manifest = isFlowGraphV2(input.graph)
      ? flowToManifest(input.graph)
      : flowToManifest(input.graph);
    return manifest.triggers.some((trigger) => trigger.kind === "paidCall");
  } catch {
    return false;
  }
}
