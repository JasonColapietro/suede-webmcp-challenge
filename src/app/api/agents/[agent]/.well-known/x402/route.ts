/**
 * x402 discovery document for a Suede agent.
 * GET /api/agents/[agent]/.well-known/x402 — describes current payment state
 * and, only when enabled, per-call x402 terms.
 * payTo is the CREATOR's wallet when they've saved one (platform env is only
 * a fallback).
 */
import { NextResponse } from "next/server";
import { resolveAgent } from "@/lib/agents";
import { summarizeGraph } from "@/lib/catalog";
import { deriveInputSchema } from "@/lib/flow/input-contract";
import {
  buildX402BazaarExtensions,
  buildX402Accept,
  buildX402ResourceInfo,
  X402_PROTOCOL_VERSION,
} from "@/lib/rails/x402-verify";
import { curatedBusinessService } from "@/lib/curated-business-services";
import { SITE_URL } from "@/lib/site";
import { getRepo } from "@/lib/db/repo";
import { getProjectRepo } from "@/lib/projects/provider";
import { resolvePublicServiceContract, RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";
import {
  isPublishedAgentRecord,
  resolvePublicPaymentReadiness,
} from "@/lib/public-payment-readiness";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ agent: string }>;
}

export async function GET(_req: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { agent: agentParam } = await params;
    const agent = await resolveAgent(agentParam);
    if (!isPublishedAgentRecord(agent)) {
      return NextResponse.json({ error: "agent not found" }, { status: 404 });
    }
    const repo = await getRepo();
    const flow = await repo.getFlow(agent.flowId);
    if (!flow) return NextResponse.json({ error: "agent not found" }, { status: 404 });
    const projectRepo = await getProjectRepo().catch(() => null);
    const activeDeployment = projectRepo
      && typeof projectRepo.getActiveDeployment === "function"
      ? await projectRepo.getActiveDeployment({
          flowId: flow.id,
          ownerId: flow.ownerId,
          environmentKind: "live",
        }).catch(() => null)
      : null;
    const service = await resolvePublicServiceContract({ flow, agent, projectRepo, activeDeployment });
    if (!service || service.resource?.access.execution === "private") {
      return NextResponse.json({ error: "agent not found" }, { status: 404 });
    }
    const publicGraph = service.graph;

    const readiness = await resolvePublicPaymentReadiness({
      agent,
      flow,
      repo,
      publishedGraph: service.graph,
      liveExecutionReady: true,
    });
    const acceptsPayment = readiness.state === "payment-enabled";
    const payout = readiness.payout;
    const resourceUrl = `${SITE_URL}/api/agents/${agent.slug}/run`;
    const contract = service.curated ?? curatedBusinessService(agent.slug, publicGraph);
    const metaDescription = publicGraph.meta?.description;
    const whatItDoes =
      typeof metaDescription === "string" && metaDescription.trim() !== ""
        ? metaDescription.trim().slice(0, 140)
        : summarizeGraph(publicGraph);
    const resourceIdentity = service.kind === "resource" ? service.description : contract?.description ?? `${flow.name}: ${whatItDoes}`;
    const inputSchema = service.kind === "resource" ? service.inputSchema : contract?.inputSchema ?? deriveInputSchema(publicGraph);
    const outputSchema = service.kind === "resource" ? service.responseSchema ?? service.outputSchema : contract?.outputSchema ?? {
      type: "object",
      additionalProperties: true,
    };
    const tags = service.kind === "resource" ? [...service.tags] : contract ? [...contract.tags] : ["suede", "agent", "x402"];
    const bazaarExtensions = buildX402BazaarExtensions({
      ...(service.kind === "resource" ? { mode: "resource" as const } : {}),
      inputSchema,
      outputSchema,
      exampleInput: service.kind === "resource" ? service.exampleInput : contract?.exampleInput ?? {},
      exampleOutput: service.kind === "resource" ? service.responseExample ?? {} : contract?.exampleOutput ?? { ok: true },
    });
    const resourceExtensions = service.resource
      ? { [RESOURCE_CONTRACT_EXTENSION_URI]: service.resource }
      : {};
    const payment = acceptsPayment
      ? {
          paymentState: "payment-enabled" as const,
          accepts: [
            buildX402Accept({
              priceUsdc: agent.priceUsdc,
              payTo: payout.payTo,
              resource: resourceUrl,
              description: resourceIdentity,
              outputSchema,
            }),
          ],
          extensions: { ...bazaarExtensions, ...resourceExtensions },
          payoutSource: payout.source,
        }
      : {
          paymentState: readiness.state,
          ...(service.resource ? { extensions: resourceExtensions } : {}),
        };

    return NextResponse.json({
      x402Version: X402_PROTOCOL_VERSION,
      name: service.kind === "resource" ? service.name : flow.name,
      acceptsPayment,
      previewAvailable: readiness.previewAvailable,
      publishedLive: readiness.publishedLive,
      ...payment,
      resource: buildX402ResourceInfo({
        resource: resourceUrl,
        description: resourceIdentity,
        serviceName: "Suede Agent Studio",
        tags,
      }),
      /** JSON Schema for the run input, derived from the public graph. */
      inputSchema,
      outputSchema,
      ...(contract
        ? {
            exampleInput: contract.exampleInput,
            exampleOutput: contract.exampleOutput,
            curation: {
              collection: contract.collection,
              operator: contract.operator,
              reviewPolicy: contract.reviewPolicy,
              dataHandling: contract.dataHandling,
            },
          }
        : {}),
    });
  } catch (error: unknown) {
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("agents .well-known x402 route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
