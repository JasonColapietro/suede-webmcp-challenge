/**
 * Deployable-template export for a Suede agent.
 * GET /api/agents/[agent]/template — returns a downloadable JSON manifest with
 * the flow graph, a minimal x402 client script, and a README.
 */
import { NextResponse } from "next/server";
import { getRepo } from "@/lib/db/repo";
import { resolveAgent } from "@/lib/agents";
import { getProjectRepo } from "@/lib/projects/provider";
import { resolvePublicServiceContract } from "@/lib/public-service-contract";
import { projectPublicHttpCredentials } from "@/lib/flow/http-publication-policy";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import {
  isPublishedAgentRecord,
  resolvePublicPaymentReadiness,
  type PublicPaymentState,
} from "@/lib/public-payment-readiness";
import { buildRunScript } from "@/lib/template-payment-client";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ agent: string }>;
}

function buildReadme(
  slug: string,
  agentId: string,
  priceUsdc: number,
  paymentState: PublicPaymentState,
): string {
  if (paymentState === "unavailable") {
    return [
      `# ${slug}`,
      "",
      "A Suede Agent Studio flow, exported as a deployable template.",
      "Unavailable: this published service currently exposes neither a public preview nor payment.",
      "",
      "`flow.json` holds the portable flow graph for re-import.",
    ].join("\n");
  }
  if (paymentState === "preview") {
    return [
      `# ${slug}`,
      "",
      "A Suede Agent Studio flow, exported as a deployable template.",
      "Preview mode: this endpoint currently runs explicit dry-runs and does not accept payment.",
      "",
      "## Usage",
      "",
      "1. Optionally set `SUEDE_BASE_URL`.",
      "2. Run: `node run.ts`.",
      "",
      `Endpoint: \`POST /api/agents/${agentId}/run\``,
      "",
      "`flow.json` holds the portable flow graph for re-import.",
    ].join("\n");
  }
  return [
    `# ${slug}`,
    "",
    "A Suede Agent Studio flow, exported as a deployable template.",
    "It is callable per-call in USDC on Base via the x402 protocol.",
    "",
    "## Usage",
    "",
    "1. Set `WALLET_PRIVATE_KEY` (a funded Base wallet).",
    "2. Install deps: `npm i @x402/fetch @x402/evm viem`.",
    "3. Run: `node run.ts`.",
    "",
    "The generated client is locked to x402 v2, Base, canonical Base USDC, the exported exact amount, and the configured recipient. It rejects changed payment terms before signing.",
    "",
    `Endpoint: \`POST /api/agents/${agentId}/run\``,
    `Price: \`${priceUsdc} USDC\` per call (x402 v2, eip155:8453).`,
    "",
    "`flow.json` holds the portable flow graph for re-import.",
  ].join("\n");
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
    if (!flow) {
      return NextResponse.json({ error: "flow not found" }, { status: 404 });
    }
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
    const templateGraph = projectPublicHttpCredentials(service.graph as SupportedFlowGraph);
    const readiness = await resolvePublicPaymentReadiness({
      agent,
      flow,
      repo,
      publishedGraph: service.graph,
      liveExecutionReady: activeDeployment !== null,
    });
    const payment = readiness.state === "payment-enabled"
      ? {
          state: "payment-enabled" as const,
          acceptsPayment: true as const,
          rail: "x402" as const,
          network: "eip155:8453" as const,
          amountUsdc: agent.priceUsdc,
        }
      : { state: readiness.state, acceptsPayment: false as const };

    const manifest = {
      schemaVersion: 2,
      name: agent.slug,
      flow: templateGraph,
      files: {
        "flow.json": JSON.stringify(templateGraph),
        "run.ts": buildRunScript(
          agent.id,
          agent.priceUsdc,
          readiness.state,
          readiness.acceptsPayment ? readiness.payout.payTo : undefined,
        ),
        "README.md": buildReadme(agent.slug, agent.id, agent.priceUsdc, readiness.state),
      },
      interfaces: ["a2a"],
      settlementRails: readiness.state === "payment-enabled" ? ["x402"] : [],
      payment,
    };

    return NextResponse.json(manifest, {
      headers: {
        "Content-Disposition": `attachment; filename="${agent.slug}.suede-template.json"`,
      },
    });
  } catch (error: unknown) {
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("agents template route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
