import type { FlowVersionRecord, FlowVersionSummary } from "./types";

export const PUBLIC_VERSION_CREATOR = "workspace-owner" as const;

export function publicFlowVersionSummary(version: FlowVersionSummary): FlowVersionSummary {
  return { ...version, createdBy: PUBLIC_VERSION_CREATOR };
}

export function publicFlowVersionRecord(version: FlowVersionRecord): FlowVersionRecord {
  return { ...version, createdBy: PUBLIC_VERSION_CREATOR };
}
