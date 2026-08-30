import { NextResponse } from "next/server";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import {
  UpdateFlowRequestSchema,
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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();
    const flow = await repo.getOwnedFlow(id, owner);
    if (flow === null) {
      return privateJson({ error: "not found" }, 404);
    }
    return privateJson({ flow });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: "Authentication required" }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();
    if (await repo.getOwnedFlow(id, owner) === null) {
      return privateJson({ error: "not found" }, 404);
    }
    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return invalidRequestResponse();
    if (isUnversionedApiOperationRequest(body.data)) {
      return privateJson({ error: API_OPERATION_V1_UNSUPPORTED }, 409);
    }
    const parsed = UpdateFlowRequestSchema.safeParse(body.data);
    if (!parsed.success) return invalidRequestResponse();

    const { name, impactReceipt } = parsed.data;
    const graph = parseSupportedFlowGraph(parsed.data.graph);
    const graphError = validateRunnableGraph(graph);
    if (graphError !== null) {
      return privateJson({ error: "invalid flow graph" }, 400);
    }

    const result = await new FlowMutationService(repo).save({
      id,
      mustExist: true,
      ownerId: owner,
      name,
      graph,
      ...(impactReceipt === undefined ? {} : { impactReceipt }),
    });
    if (result.status === "saved") return privateJson({ flow: result.flow });
    if (result.status === "not-found") {
      return privateJson({ error: "not found" }, 404);
    }
    if (result.status === "impact-required") {
      return privateJson({
        error: "impact confirmation required",
        receipt: result.receipt,
        impact: result.impact,
      }, 409);
    }
    if (result.status === "cycle" || result.status === "invalid-reference") {
      return privateJson({ error: "invalid subflow reference" }, 400);
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

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();
    const deleted = await repo.deleteFlow(id, owner);
    if (!deleted) {
      return privateJson({ error: "not found" }, 404);
    }
    return privateJson({ deleted: true });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: "Authentication required" }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}
