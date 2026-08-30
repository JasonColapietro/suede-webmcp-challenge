/**
 * /api/cli/agents
 *
 * GET  — list all agents for the authenticated workspace owner (with manifests)
 * POST — push (create or update) an agent from an AgentManifest JSON body
 *
 * Auth: Authorization: Bearer <workspaceKey>
 *   workspaceKey == ownerId (the UUID from /flows workspace reveal).
 *   The middleware folds x-owner-id header into resolveOwnerId(), but the CLI
 *   sends a Bearer token, so we extract the owner here from the Authorization header.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { AgentManifestSchema } from "@/lib/manifest/schema";
import type { AgentManifest } from "@/lib/manifest/schema";
import { getRepo } from "@/lib/db/repo";
import {
  handleCliAgentsList,
  handleCliAgentsPush,
} from "@/lib/cli/agents-handler";
import {
  parseJsonRequest,
  privateJson,
} from "@/lib/projects/api-response";
import { FlowMutationStoreUnavailableError } from "@/lib/flow/flow-mutation-service";
import { API_OPERATION_V1_UNSUPPORTED } from "@/lib/flow/api-operation-contract";
import {
  HTTP_PUBLICATION_CREDENTIAL_CODE,
  HTTP_PUBLICATION_CREDENTIAL_ERROR,
} from "@/lib/flow/http-publication-policy";
import {
  REQUIRED_CONNECTION_CODE,
  REQUIRED_CONNECTION_ERROR,
} from "@/lib/flow/connection-requirements";

export const runtime = "nodejs";

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  return key.length > 0 ? key : null;
}

export async function GET(): Promise<NextResponse> {
  try {
    const h = await headers();
    const ownerId = extractBearer(h.get("Authorization")) ?? h.get("x-owner-id");
    if (!ownerId) {
      return privateJson({ error: "Authorization required" }, 401);
    }

    const repo = await getRepo();
    const result = await handleCliAgentsList(ownerId, repo);
    return privateJson(result);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null &&
        Reflect.get(error, "code") === API_OPERATION_V1_UNSUPPORTED) {
      return privateJson({ error: API_OPERATION_V1_UNSUPPORTED }, 409);
    }
    if (typeof error === "object" && error !== null &&
        Reflect.get(error, "code") === HTTP_PUBLICATION_CREDENTIAL_CODE) {
      return privateJson({ error: HTTP_PUBLICATION_CREDENTIAL_ERROR }, 409);
    }
    if (typeof error === "object" && error !== null &&
        Reflect.get(error, "code") === REQUIRED_CONNECTION_CODE) {
      return privateJson({ error: REQUIRED_CONNECTION_ERROR }, 409);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const h = await headers();
    const ownerId = extractBearer(h.get("Authorization")) ?? h.get("x-owner-id");
    if (!ownerId) {
      return privateJson({ error: "Authorization required" }, 401);
    }

    const parsed = await parseJsonRequest(request, AgentManifestSchema);
    if (!parsed.ok) return privateJson({ error: "Invalid AgentManifest" }, 400);

    const repo = await getRepo();
    const impactReceipt = request.headers.get("x-suede-impact-receipt") ?? undefined;
    if (impactReceipt !== undefined && (impactReceipt.length < 32 || impactReceipt.length > 256)) {
      return privateJson({ error: "Invalid impact receipt" }, 400);
    }
    const result = await handleCliAgentsPush(parsed.data as AgentManifest, ownerId, repo, { impactReceipt });
    if (!result.ok) {
      if ("mutationRefused" in result) {
        return privateJson({
          error: "Flow mutation refused",
          status: result.status,
          ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
          ...(result.impact === undefined ? {} : { impact: result.impact }),
        }, result.status === "not-found" ? 404 : 409);
      }
      return privateJson(
        { error: `Rate limit exceeded. Retry in ${result.retryAfterSec}s.` },
        429,
        { "Retry-After": String(result.retryAfterSec) },
      );
    }
    return privateJson(result, 201);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null &&
        Reflect.get(error, "code") === API_OPERATION_V1_UNSUPPORTED) {
      return privateJson({ error: API_OPERATION_V1_UNSUPPORTED }, 409);
    }
    if (typeof error === "object" && error !== null &&
        Reflect.get(error, "code") === HTTP_PUBLICATION_CREDENTIAL_CODE) {
      return privateJson({ error: HTTP_PUBLICATION_CREDENTIAL_ERROR }, 409);
    }
    if (typeof error === "object" && error !== null &&
        Reflect.get(error, "code") === REQUIRED_CONNECTION_CODE) {
      return privateJson({ error: REQUIRED_CONNECTION_ERROR }, 409);
    }
    if (error instanceof FlowMutationStoreUnavailableError) {
      return privateJson({ error: "flow mutation unavailable" }, 503);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}
