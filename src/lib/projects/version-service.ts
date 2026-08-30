import type {
  CreateFlowCheckpointRepositoryInput,
  CreateFlowVersionRepositoryInput,
  FlowVersionRepo,
} from "./repo";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import type {
  DependencyPinInput,
  FlowVersionComparison,
  FlowVersionRecord,
  FlowVersionSummary,
} from "./types";
import { normalizeVersionCreationInput, requireVersionText } from "./version-input";
import { rejectCallerFlowDependencies } from "./subflow-dependencies";
import { rejectCallerConnectorDependencies } from "./connector-dependencies";
import { rejectCallerResourceDependencies } from "./resource-dependencies";
import { compareFlowVersionDetails } from "./version-diff";

export interface CreateFlowVersionInput {
  readonly flowId: string;
  readonly ownerId: string;
  readonly label?: string;
  readonly description?: string;
  readonly dependencies?: readonly DependencyPinInput[];
}

export interface CreateFlowCheckpointInput extends CreateFlowVersionInput {
  readonly graph: SupportedFlowGraph;
  readonly impactReceipt?: string;
}

export interface GetFlowVersionInput {
  readonly flowId: string;
  readonly versionId: string;
  readonly ownerId: string;
}

export interface ListFlowVersionsInput {
  readonly flowId: string;
  readonly ownerId: string;
}

export class VersionService {
  constructor(private readonly repo: FlowVersionRepo) {}

  async createFlowVersion(input: CreateFlowVersionInput): Promise<FlowVersionRecord | null> {
    rejectCallerFlowDependencies(input.dependencies);
    rejectCallerConnectorDependencies(input.dependencies);
    rejectCallerResourceDependencies(input.dependencies);
    const normalized: CreateFlowVersionRepositoryInput = normalizeVersionCreationInput(input);
    return this.repo.createFlowVersion(normalized);
  }

  async createFlowCheckpoint(input: CreateFlowCheckpointInput): Promise<FlowVersionRecord | null> {
    rejectCallerFlowDependencies(input.dependencies);
    rejectCallerConnectorDependencies(input.dependencies);
    rejectCallerResourceDependencies(input.dependencies);
    const normalized = normalizeVersionCreationInput(input);
    const repositoryInput: CreateFlowCheckpointRepositoryInput = {
      ...normalized,
      graph: input.graph,
      ...(input.impactReceipt === undefined ? {} : { impactReceipt: input.impactReceipt }),
    };
    return this.repo.createFlowCheckpoint(repositoryInput);
  }

  async getFlowVersion(input: GetFlowVersionInput): Promise<FlowVersionRecord | null> {
    return this.repo.getFlowVersion({
      flowId: requireVersionText(input.flowId, "flowId"),
      versionId: requireVersionText(input.versionId, "versionId"),
      ownerId: requireVersionText(input.ownerId, "ownerId"),
    });
  }

  async listFlowVersions(input: ListFlowVersionsInput): Promise<FlowVersionSummary[]> {
    return this.repo.listFlowVersions({
      flowId: requireVersionText(input.flowId, "flowId"),
      ownerId: requireVersionText(input.ownerId, "ownerId"),
    });
  }
}

export function compareFlowVersions(
  left: FlowVersionRecord,
  right: FlowVersionRecord,
): FlowVersionComparison {
  const detail = compareFlowVersionDetails(left, right);
  return {
    semanticEqual: detail.semanticEqual,
    fullEqual: detail.fullEqual,
    changedSections: detail.changedSections,
  };
}
