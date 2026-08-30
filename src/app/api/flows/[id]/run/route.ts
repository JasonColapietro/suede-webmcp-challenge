import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { runAndStream, sseFrame } from "@/lib/run-service";

export const runtime = "nodejs";

const runBodySchema = z.object({
  triggerInput: z.record(z.string(), z.unknown()).optional(),
  runVariables: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();

    const flow = await repo.getFlow(id);
    if (flow === null || flow.ownerId !== owner) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    let triggerInput: Record<string, unknown> | undefined;
    let runVariables: Record<string, unknown> | undefined;
    try {
      const body: unknown = await request.json();
      const parsed = runBodySchema.safeParse(body);
      if (parsed.success) {
        triggerInput = parsed.data.triggerInput;
        runVariables = parsed.data.runVariables;
      }
    } catch {
      triggerInput = undefined;
      runVariables = undefined;
    }

    const graph = flow.graph;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller): Promise<void> {
        try {
          for await (const event of runAndStream(graph, {
            trigger: "manual",
            flowId: flow.id,
            triggerInput,
            runVariables,
            dryRun: true,
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
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("flows run route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
