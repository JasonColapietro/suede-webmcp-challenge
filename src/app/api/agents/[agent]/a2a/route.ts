/**
 * A2A AgentCard for a Suede agent.
 * GET /api/agents/[agent]/a2a — discovery document for the native A2A 1.0
 * HTTP+JSON interface rooted at the same URL.
 */
import { NextResponse } from "next/server";
import { resolveAgent } from "@/lib/agents";
import { getRepo } from "@/lib/db/repo";
import { getProjectRepo } from "@/lib/projects/provider";
import { resolvePublicServiceContract, RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";
import { summarizeGraph } from "@/lib/catalog";
import { deriveInputSchema } from "@/lib/flow/input-contract";
import { curatedBusinessService } from "@/lib/curated-business-services";
import { buildSuedeAgentCard } from "@/lib/discovery/agent-card";
import { publicAp2RuntimeStatus } from "@/lib/rails/ap2/config";
import { companyServiceSupportsPublicAp2 } from "@/lib/rails/ap2-company-eligibility";
import type { SupportedFlowGraph } from "@/lib/flow/types";
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
    const activeDeployment = projectRepo && typeof projectRepo.getActiveDeployment === "function"
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
    const publicGraph = service.graph as SupportedFlowGraph;
    const readiness = await resolvePublicPaymentReadiness({
      agent,
      flow,
      repo,
      publishedGraph: service.graph,
      liveExecutionReady: true,
    });

    const metaDescription = publicGraph.meta?.description;
    const fallbackDescription = typeof metaDescription === "string" && metaDescription.trim() !== ""
      ? metaDescription.trim().slice(0, 140)
      : summarizeGraph(publicGraph);
    const contract = service.curated ?? curatedBusinessService(agent.slug, publicGraph);
    const [ap2Status, relay] = await Promise.all([
      publicAp2RuntimeStatus(),
      typeof repo.getRelayEndpoint === "function"
        ? repo.getRelayEndpoint(agent.id).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const companySupportsAp2 = ap2Status.ready && ap2Status.mode !== "off"
      ? await companyServiceSupportsPublicAp2({ repo, agentId: agent.id, graph: publicGraph })
      : true;
    return NextResponse.json(buildSuedeAgentCard({
      name: service.kind === "resource" ? service.name : flow.name,
      slug: agent.slug,
      description: service.kind === "resource" ? service.description : contract?.description ?? fallbackDescription,
      priceUsdc: agent.priceUsdc,
      inputSchema: (service.kind === "resource" ? service.inputSchema : contract?.inputSchema ?? deriveInputSchema(publicGraph)) as Record<string, unknown>,
      outputSchema: (service.kind === "resource" ? service.responseSchema ?? service.outputSchema : contract?.outputSchema ?? {
        type: "object",
        additionalProperties: true,
      }) as Record<string, unknown>,
      tags: service.kind === "resource" ? service.tags : contract?.tags ?? ["suede", "agent", "workflow"],
      ...(service.kind === "resource" ? { exampleInput: service.exampleInput } : {}),
      ...(service.resource ? { extensions: { [RESOURCE_CONTRACT_EXTENSION_URI]: service.resource } } : {}),
      paymentState: readiness.state,
      publishedLive: readiness.publishedLive,
      fulfillmentSupportsAp2: relay !== undefined
        && (relay === null || relay.protocolVersion === 2)
        && companySupportsAp2,
      ...(contract
        ? {
            exampleInput: contract.exampleInput,
            exampleOutput: contract.exampleOutput,
            reviewPolicy: contract.reviewPolicy,
            dataHandling: contract.dataHandling,
          }
        : {}),
    }, ap2Status));
  } catch (error: unknown) {
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("agents a2a route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
