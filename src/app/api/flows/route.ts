import { NextResponse } from "next/server";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import {
  CreateFlowRequestSchema,
  validateRunnableGraph,
} from "@/lib/flow/request-schema";
import {
  FlowMutationService,
  FlowMutationStoreUnavailableError,
} from "@/lib/flow/flow-mutation-service";
import {
  invalidRequestResponse,
  privateJson,
  readBoundedJsonRequest,
} from "@/lib/projects/api-response";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { API_OPERATION_V1_UNSUPPORTED } from "@/lib/flow/api-operation-contract";

export const runtime = "nodejs";

function isUnversionedApiOperationRequest(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const graph = Reflect.get(value, "graph");
  if (graph === null || typeof graph !== "object" || Array.isArray(graph) ||
      Reflect.get(graph, "schemaVersion") !== undefined) return false;
  const nodes = Reflect.get(graph, "nodes");
  return Array.isArray(nodes) && nodes.some((node) =>
    node !== null && typeof node === "object" && !Array.isArray(node) &&
    Reflect.get(node, "type") === "api.operation");
}

export async function GET(): Promise<NextResponse> {
  try {
    const owner = await resolveOwnerId();
    const repo = await getRepo();
    const flows = await repo.listFlows(owner);
    return privateJson({ flows });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: "Authentication required" }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const owner = await resolveOwnerId();
    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return invalidRequestResponse();
    if (isUnversionedApiOperationRequest(body.data)) {
      return privateJson({ error: API_OPERATION_V1_UNSUPPORTED }, 409);
    }
    const parsed = CreateFlowRequestSchema.safeParse(body.data);
    if (!parsed.success) return invalidRequestResponse();

    const { name } = parsed.data;
    const graph = parseSupportedFlowGraph(parsed.data.graph);
    const graphError = validateRunnableGraph(graph);
    if (graphError !== null) {
      return privateJson({ error: "invalid flow graph" }, 400);
    }

    const repo = await getRepo();
    const result = await new FlowMutationService(repo).save({ ownerId: owner, name, graph });
    if (result.status === "saved") return privateJson({ flow: result.flow });
    if (result.status === "cycle" || result.status === "invalid-reference") {
      return privateJson({ error: "invalid subflow reference" }, 400);
    }
    if (result.status === "not-found") {
      return privateJson({ error: "not found" }, 404);
    }
    return privateJson({ error: "mutation conflict" }, 409);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null &&
        Reflect.get(error, "code") === API_OPERATION_V1_UNSUPPORTED) {
      return privateJson({ error: API_OPERATION_V1_UNSUPPORTED }, 409);
    }
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: "Authentication required" }, error.status);
    }
    if (error instanceof FlowMutationStoreUnavailableError) {
      return privateJson({ error: "flow mutation unavailable" }, 503);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}
