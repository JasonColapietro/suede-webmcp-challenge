import {
  OperatingAdapterResultSchema,
  type OperatingAdapterResult,
} from "./schema";

export interface OperatingSystemAdapter {
  readonly adapterId: string;
  readonly label: string;
  collect(): Promise<unknown>;
}

function unavailableResult(
  adapter: OperatingSystemAdapter,
  checkedAt: string,
): OperatingAdapterResult {
  return OperatingAdapterResultSchema.parse({
    adapterId: adapter.adapterId,
    label: adapter.label,
    status: "unavailable",
    checkedAt,
    note: "This adapter could not be read. No status was inferred from the failure.",
    projects: [],
    milestones: [],
    evidence: [],
    approvals: [],
  });
}

export async function collectOperatingAdapter(
  adapter: OperatingSystemAdapter,
  checkedAt: string,
): Promise<OperatingAdapterResult> {
  try {
    return OperatingAdapterResultSchema.parse(await adapter.collect());
  } catch {
    return unavailableResult(adapter, checkedAt);
  }
}
