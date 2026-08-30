import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import {
  PersistedRunPreflightError,
  preflightPersistedRun,
} from "@/lib/flow/run-subflow-preflight";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { getProjectRepo } from "@/lib/projects/provider";
import { runAndStream, sseFrame } from "@/lib/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const runBodySchema = z.object({
  flowVersionId: z.string().uuid().optional(),
  triggerInput: z.record(z.string(), z.unknown()).optional(),
  runVariables: z.record(z.string(), z.unknown()).optional(),
}).strict();

function invalidRunRequest(): NextResponse {
  return NextResponse.json(
    { error: "invalid request" },
    { status: 400, headers: { "cache-control": "private, no-store" } },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ flowId: string }> },
): Promise<Response> {
  try {
    const { flowId } = await params;
    const ownerId = await resolveOwnerId();
    const repo = await getRepo();
    const flow = await repo.getOwnedFlow(flowId, ownerId);
    if (!flow) return NextResponse.json({ error: "not found" }, { status: 404 });

    let body: unknown = {};
    try {
      const rawBody = await request.text();
      if (rawBody.trim().length > 0) body = JSON.parse(rawBody) as unknown;
    } catch {
      return invalidRunRequest();
    }
    const parsed = runBodySchema.safeParse(body);
    if (!parsed.success) return invalidRunRequest();
    const { flowVersionId, triggerInput, runVariables } = parsed.data;

    const projectRepo = flowVersionId ||
      (flow.graph as { schemaVersion?: unknown }).schemaVersion === 2
      ? await getProjectRepo()
      : null;
    const immutableVersion = flowVersionId && projectRepo
      ? await projectRepo.getFlowVersion({ flowId: flow.id, versionId: flowVersionId, ownerId })
      : null;
    if (flowVersionId && !immutableVersion) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const runGraph = immutableVersion
      ? parseSupportedFlowGraph(immutableVersion.graph)
      : flow.graph;
    const declaresV2 = (runGraph as { schemaVersion?: unknown }).schemaVersion === 2;
    const preflighted = await preflightPersistedRun({
      rootFlowId: flow.id,
      ownerId,
      graph: runGraph,
      flowRepo: repo,
      ...(declaresV2 && projectRepo ? { versionRepo: projectRepo } : {}),
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller): Promise<void> {
        try {
          for await (const event of runAndStream(preflighted.graph, {
            trigger: "manual",
            flowId: flow.id,
            triggerInput,
            runVariables,
            dryRun: true,
            subflowSnapshot: preflighted.subflowSnapshot,
          })) {
            controller.enqueue(encoder.encode(sseFrame(event)));
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unexpected error";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof PersistedRunPreflightError) {
      return NextResponse.json(
        { error: error.publicError },
        { status: error.status, headers: { "cache-control": "private, no-store" } },
      );
    }
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("v2 flows run route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
