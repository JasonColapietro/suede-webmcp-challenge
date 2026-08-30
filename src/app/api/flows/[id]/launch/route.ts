import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { uniqueSlug } from "@/lib/slug";
import { describeCron, nextOccurrence, parseCron } from "@/lib/cron";
import { resolvePayout } from "@/lib/payout";
import { validateFlowGraph } from "@/lib/flow/validate";
import { generateWebhookSecret } from "@/lib/webhook-auth";
import { isFlowGraphV1 } from "@/lib/flow/graph-schema";
import { API_OPERATION_LIVE_UNAVAILABLE, graphContainsApiOperation } from "@/lib/connectors/operation-closure";
import { promoteFlowToLive } from "@/lib/launch/promote-live";
import { getProjectRepo } from "@/lib/projects/provider";
import { deriveSiteAgentPricing } from "@/lib/site/pricing";

export const runtime = "nodejs";

const launchBodySchema = z.object({
  priceUsdc: z.number().nonnegative().optional(),
  payoutAddress: z.string().optional(),
});

interface ScheduleInfo {
  cron: string;
  description: string;
  nextRunAt: number | null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();

    const flow = await repo.getFlow(id);
    if (flow === null || flow.ownerId !== owner) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (graphContainsApiOperation(flow.graph)) {
      return NextResponse.json({ error: API_OPERATION_LIVE_UNAVAILABLE }, { status: 409 });
    }
    // v2 graphs launch when they are paid-call only. Schedule and webhook
    // triggers still require v1 (their launch wiring below was built for the
    // v1 manifest shape); porting them is a separate, deliberate change.
    if (!isFlowGraphV1(flow.graph)) {
      const unsupportedTrigger = flow.graph.nodes.some(
        (n) => n.type === "schedule" || n.type === "webhook",
      );
      if (unsupportedTrigger) {
        return NextResponse.json(
          {
            error:
              "Flow graph v2 launch currently supports paid-call agents only. Remove schedule and webhook nodes to launch this flow, or keep those triggers on a v1 flow.",
          },
          { status: 409 },
        );
      }
    }

    let priceUsdc: number | undefined;
    let payoutAddress: string | undefined;
    try {
      const body: unknown = await request.json();
      const parsed = launchBodySchema.safeParse(body);
      if (parsed.success) {
        priceUsdc = parsed.data.priceUsdc;
        const addr = parsed.data.payoutAddress?.trim();
        if (addr) payoutAddress = addr;
      }
    } catch {
      priceUsdc = undefined;
    }

    if (payoutAddress !== undefined && !isAddress(payoutAddress)) {
      return NextResponse.json(
        { error: "payoutAddress is not a valid EVM address (0x…)." },
        { status: 400 },
      );
    }

    // Validate the graph is actually wired together BEFORE any writes so a
    // disconnected or half-built flow can't go live silently.
    const structuralError = validateFlowGraph(flow.graph);
    if (structuralError !== null) {
      return NextResponse.json({ error: structuralError }, { status: 400 });
    }

    // Validate the schedule node's cron BEFORE any writes so a bad expression
    // can't leave a half-launched agent behind.
    const scheduleNode = flow.graph.nodes.find((n) => n.type === "schedule");
    let cron: string | null = null;
    if (scheduleNode) {
      const raw = scheduleNode.params.cron;
      cron = typeof raw === "string" ? raw.trim() : "";
      if (cron === "" || parseCron(cron) === null) {
        return NextResponse.json(
          {
            error: `Schedule node has an invalid cron expression${cron ? ` ("${cron}")` : ""}. Use five fields, e.g. "0 9 * * *" for daily at 09:00 UTC.`,
          },
          { status: 400 },
        );
      }
    }

    // Promote the current draft graph to an immutable Live deployment BEFORE
    // any agent writes. A published agent without an active Live deployment is
    // unpayable (its non-dry-run calls 503 "published run unavailable"), so a
    // promotion failure fails the whole launch instead of leaving a
    // half-launched agent behind silently.
    const projectRepo = await getProjectRepo();
    const promotion = await promoteFlowToLive({
      flowId: flow.id,
      ownerId: owner,
      projectRepo,
    });
    if (promotion.status !== "promoted") {
      return NextResponse.json(
        {
          error: `Launch could not publish a Live deployment (stage: ${promotion.stage}). Nothing was launched. Retry the launch; if it keeps failing, open the flow and promote it to Live from the Versions panel.`,
        },
        { status: 409 },
      );
    }

    // Relaunch updates the existing agent (stable slug) instead of minting
    // a duplicate row per click.
    const existingAgent = await repo.getAgentByFlowId(flow.id);
    const agent = existingAgent
      ? ((await repo.updateAgent(existingAgent.id, {
          status: "live",
          ...(priceUsdc !== undefined ? { priceUsdc } : {}),
        })) ?? existingAgent)
      : await repo.createAgent({
          flowId: flow.id,
          slug: uniqueSlug(flow.name),
          status: "live",
          priceUsdc: priceUsdc ?? 0,
        });
    const slug = agent.slug;

    // Register (or replace) the agent's schedule so launched flows genuinely
    // fire on their own; disable in place when the schedule node is gone.
    let schedule: ScheduleInfo | null = null;
    if (cron !== null) {
      await repo.upsertSchedule({ agentId: agent.id, cron, enabled: true });
      schedule = {
        cron,
        description: describeCron(cron),
        nextRunAt: nextOccurrence(cron, Date.now()),
      };
    } else {
      const existing = (await repo.listSchedulesByAgents([agent.id]))[0];
      if (existing?.enabled) {
        await repo.upsertSchedule({ agentId: agent.id, cron: existing.cron, enabled: false });
      }
    }

    if (payoutAddress !== undefined) {
      await repo.saveWallet({ ownerId: owner, address: payoutAddress });
    }
    const payout = await resolvePayout(agent);

    // Provision (or leave alone) the webhook secret. A secret is generated
    // exactly once per agent — the raw value cannot be recovered from what's
    // stored (see webhook-auth.ts), so a relaunch that finds an existing row
    // must not silently rotate it out from under an already-configured
    // third-party sender. Only surfaced in the response the one time it is
    // actually (re)generated.
    const hasWebhookNode = flow.graph.nodes.some((n) => n.type === "webhook");
    let webhook: { url: string; secret?: string; note?: string } | null = null;
    if (hasWebhookNode) {
      const webhookUrl = `/api/agents/${agent.id}/webhook`;
      const existing = await repo.getWebhookEndpoint(agent.id);
      const webhookNode = flow.graph.nodes.find((n) => n.type === "webhook");
      const note =
        typeof webhookNode?.params.note === "string" && webhookNode.params.note.trim() !== ""
          ? webhookNode.params.note.trim()
          : undefined;
      if (existing) {
        webhook = { url: webhookUrl, note };
      } else {
        const secret = generateWebhookSecret();
        await repo.upsertWebhookEndpoint({ agentId: agent.id, secretHash: secret });
        webhook = { url: webhookUrl, secret, note };
      }
    }

    const urls = {
      run: `/api/agents/${agent.id}/run`,
      card: `/api/agents/${slug}/.well-known/agent-card`,
      x402: `/api/agents/${slug}/.well-known/x402`,
      a2a: `/api/agents/${slug}/a2a`,
      public: `/a/${slug}`,
      ...(webhook ? { webhook: webhook.url } : {}),
    };

    // Cost-derived pricing annotation. Reuses the existing site-agent floor
    // math over the knowledge baked into this graph's LLM system prompts
    // (that is exactly the shape deriveSiteAgentPricing prices). Annotation
    // only: the stored price is never clamped here, so free launches stay
    // free and existing pricing behavior is untouched.
    const systemPromptChars = flow.graph.nodes.reduce((total, node) => {
      if (node.type !== "llm") return total;
      const system = node.params.system;
      return total + (typeof system === "string" ? system.length : 0);
    }, 0);
    const pricing = deriveSiteAgentPricing(systemPromptChars, 0);

    const payoutWarning =
      payout.source === "platform" && agent.priceUsdc > 0
        ? "Paid calls for this agent currently route to the platform wallet. Save a payout wallet address to receive its USDC."
        : null;

    return NextResponse.json({
      agent,
      slug,
      urls,
      endpoints: Object.values(urls),
      schedule,
      payout,
      webhook,
      // Additive launch-state fields (settlement + payout + deployment).
      deployment: {
        id: promotion.liveDeployment.id,
        versionId: promotion.versionId,
      },
      settlementLive: agent.settlementLive,
      settlementEndpoint: `/api/agents/${agent.id}/settlement`,
      payoutSource: payout.source,
      ...(payoutWarning === null ? {} : { payoutWarning }),
      floorUsdc: pricing.floorUsdc,
      suggestedUsdc: pricing.suggestedUsdc,
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("flows launch route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
