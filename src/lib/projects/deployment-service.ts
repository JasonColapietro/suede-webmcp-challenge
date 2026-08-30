import type {
  DeployVersionRepositoryInput,
  DeployVersionRepositoryResult,
  DeploymentRepo,
} from "./repo";
import type {
  DeploymentRecord,
  EnvironmentKind,
} from "./types";
import { parseEnvironmentKind } from "./types";
import { requireVersionText } from "./version-input";
import { DeployFlowVersionRequestSchema } from "./request-schema";
import {
  API_OPERATION_LIVE_UNAVAILABLE,
  graphContainsApiOperation,
} from "@/lib/connectors/operation-closure";
import type { FlowVersionRepo } from "./repo";
import { inspectVersionClosure } from "./version-closure";

export interface DeployVersionInput {
  readonly flowId: string;
  readonly versionId: string;
  readonly versionSemanticHash: string;
  readonly versionFullHash: string;
  readonly environmentId: string;
  readonly environmentKind: "test" | "live";
  readonly expectedActiveDeploymentId: string | null;
  readonly sourceTestDeploymentId: string | null;
  readonly confirmation: "PROMOTE TEST" | "PROMOTE LIVE";
  readonly ownerId: string;
}

export interface GetActiveDeploymentInput {
  readonly flowId: string;
  readonly environmentKind: EnvironmentKind;
  readonly ownerId: string;
}

export interface ListDeploymentsInput {
  readonly flowId: string;
  readonly ownerId: string;
}

export interface RetireDeploymentInput {
  readonly deploymentId: string;
  readonly ownerId: string;
}

export class DeploymentService {
  constructor(private readonly repo: DeploymentRepo & Pick<FlowVersionRepo, "getFlowVersion">) {}

  async deployVersion(input: DeployVersionInput): Promise<DeployVersionRepositoryResult> {
    const request = DeployFlowVersionRequestSchema.safeParse({
      versionId: input.versionId,
      versionSemanticHash: input.versionSemanticHash,
      versionFullHash: input.versionFullHash,
      environmentId: input.environmentId,
      environmentKind: input.environmentKind,
      expectedActiveDeploymentId: input.expectedActiveDeploymentId,
      sourceTestDeploymentId: input.sourceTestDeploymentId,
      confirmation: input.confirmation,
    });
    if (!request.success) return { status: "invalid-request" };
    const normalized: DeployVersionRepositoryInput = {
      flowId: requireVersionText(input.flowId, "flowId"),
      ownerId: requireVersionText(input.ownerId, "ownerId"),
      ...request.data,
    };
    const version = await this.repo.getFlowVersion({
      flowId: normalized.flowId,
      versionId: normalized.versionId,
      ownerId: normalized.ownerId,
    });
    if (!version) return { status: "not-found" };
    if (graphContainsApiOperation(version.graph)) return { status: API_OPERATION_LIVE_UNAVAILABLE };
    const closure = await inspectVersionClosure({
      root: version,
      ownerId: normalized.ownerId,
      repo: this.repo,
    });
    if (closure === "api-operation") return { status: API_OPERATION_LIVE_UNAVAILABLE };
    if (closure === "invalid") return { status: "invalid-request" };
    return this.repo.deployVersion(normalized);
  }

  async getActiveDeployment(
    input: GetActiveDeploymentInput,
  ): Promise<DeploymentRecord | null> {
    return this.repo.getActiveDeployment({
      flowId: requireVersionText(input.flowId, "flowId"),
      environmentKind: parseEnvironmentKind(input.environmentKind),
      ownerId: requireVersionText(input.ownerId, "ownerId"),
    });
  }

  async listDeployments(input: ListDeploymentsInput): Promise<DeploymentRecord[]> {
    return this.repo.listDeployments({
      flowId: requireVersionText(input.flowId, "flowId"),
      ownerId: requireVersionText(input.ownerId, "ownerId"),
    });
  }

  async retireDeployment(
    input: RetireDeploymentInput,
  ): Promise<DeploymentRecord | null> {
    return this.repo.retireDeployment({
      deploymentId: requireVersionText(input.deploymentId, "deploymentId"),
      ownerId: requireVersionText(input.ownerId, "ownerId"),
    });
  }
}
