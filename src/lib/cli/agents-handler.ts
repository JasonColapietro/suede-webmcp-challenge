/**
 * Pure handler logic for /api/cli/agents (GET list + POST push).
 *
 * Extracted from the Next.js route so vitest can import it directly
 * without the next/server machinery.
 */

import { randomUUID } from "node:crypto";
import { manifestToFlow } from "@/lib/manifest/to-flow";
import { flowToManifest } from "@/lib/manifest/from-flow";
import { uniqueSlug } from "@/lib/slug";
import { parseCron, describeCron, nextOccurrence } from "@/lib/cron";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRepo } from "@/lib/db/repo";
import type { FlowRepo } from "@/lib/db/repo";
import type { AgentManifest } from "@/lib/manifest/schema";
import { promoteFlowToLive, type PromoteLiveStage } from "@/lib/launch/promote-live";
import { getProjectRepo } from "@/lib/projects/provider";
import type { ProjectRepo } from "@/lib/projects/repo";
import { requireFlowGraphV1 } from "@/lib/flow/graph-schema";
import { FlowMutationService } from "@/lib/flow/flow-mutation-service";
import {
  ApiOperationV1UnsupportedError,
  graphContainsApiOperation,
} from "@/lib/flow/api-operation-contract";
import { assertGraphHasSafeHttpPublicationCredentials } from "@/lib/flow/http-publication-policy";
import { assertGraphHasRequiredConnectionBindings } from "@/lib/flow/connection-requirements";

export interface PushResult {
  ok: true;
  slug: string;
  url: string;
  manifest: AgentManifest;
}

export interface PushRateLimitResult {
  ok: false;
  rateLimited: true;
  retryAfterSec: number;
}

export interface PushMutationRefusedResult {
  ok: false;
  mutationRefused: true;
  status: "not-found" | "invalid-reference" | "cycle" | "impact-required" | "conflict";
  receipt?: string;
  impact?: import("@/lib/flow/flow-mutation-service").FlowImpactSummary;
}

export interface ListResult {
  agents: AgentManifest[];
}

/**
 * Thrown when the flow saved but its promote-to-live sequence failed. The
 * push stops BEFORE any agent write, so no half-launched, unpayable agent is
 * left behind: the flow is saved, nothing is publicly callable.
 */
export class CliLaunchPromotionError extends Error {
  readonly stage: PromoteLiveStage;

  constructor(stage: PromoteLiveStage) {
    super(
      `Agent push saved the flow but could not publish a Live deployment (stage: ${stage}). No agent was created or changed. Retry the push.`,
    );
    this.name = "CliLaunchPromotionError";
    this.stage = stage;
  }
}

/**
 * Resolve the project control plane the push should promote through.
 *
 * An explicitly injected projectRepo always wins (tests wire a store that
 * shares the caller's database). Otherwise promotion runs only when the
 * caller passed the process-canonical FlowRepo (which the real route always
 * does): getProjectRepo() shares state with that store and no other, so
 * promoting on behalf of a foreign injected repo would target the wrong
 * database and always fail.
 */
async function resolvePromotionRepo(
  repo: FlowRepo,
  injected: ProjectRepo | undefined,
): Promise<ProjectRepo | null> {
  if (injected) return injected;
  let canonical: FlowRepo | null = null;
  try {
    canonical = await getRepo();
  } catch {
    canonical = null;
  }
  if (repo !== canonical) return null;
  // Canonical store: promotion is mandatory, so an unavailable project store
  // propagates (fail closed, before any agent write) instead of skipping.
  return getProjectRepo();
}

/**
 * Push (create or update) an agent from a manifest.
 *
 * Dedup law: one agent per flow (stable slug). If the owner already has a
 * flow+agent for this manifest name, the existing agent is updated in place.
 *
 * Rate-limited: 10 pushes per minute per owner (token-bucket via rate-limit.ts).
 */
export async function handleCliAgentsPush(
  manifest: AgentManifest,
  ownerId: string,
  repo: FlowRepo,
  options: {
    readonly impactReceipt?: string;
    /**
     * Project control plane sharing `repo`'s database, for promote-to-live.
     * When omitted, promotion runs through getProjectRepo() iff `repo` is the
     * process-canonical store (see resolvePromotionRepo).
     */
    readonly projectRepo?: ProjectRepo;
  } = {},
): Promise<PushResult | PushRateLimitResult | PushMutationRefusedResult> {
  const rl = checkRateLimit(`cli-push:${ownerId}`, { capacity: 10, refillPerSec: 0.5 });
  if (!rl.allowed) {
    return { ok: false, rateLimited: true, retryAfterSec: rl.retryAfterSec };
  }
  // Compile manifest → flow graph
  const graph = manifestToFlow(manifest);
  if (graphContainsApiOperation(graph)) throw new ApiOperationV1UnsupportedError();
  assertGraphHasSafeHttpPublicationCredentials(graph);
  assertGraphHasRequiredConnectionBindings(graph);
  // Give the graph a fresh id so saveFlow upserts cleanly
  const graphWithId = { ...graph, id: graph.id.startsWith("mf-") ? graph.id : `mf-${randomUUID()}` };

  // Extract priceUsdc from paidCall trigger (if any)
  const paidCallTrigger = manifest.triggers.find((t) => t.kind === "paidCall");
  const priceUsdc = paidCallTrigger?.kind === "paidCall" ? paidCallTrigger.priceUsdc : 0;

  // Extract cron from schedule trigger (if any)
  const scheduleTrigger = manifest.triggers.find((t) => t.kind === "schedule");
  const cron = scheduleTrigger?.kind === "schedule" ? scheduleTrigger.cron : null;

  // Validate cron before any writes
  if (cron !== null && parseCron(cron) === null) {
    throw new Error(`Invalid cron expression: "${cron}"`);
  }

  // Look for an existing flow for this owner with the same graph id (dedup by graph slug-id)
  const existingFlows = await repo.listFlows(ownerId);
  const existingFlow = existingFlows.find((f) => f.graph.id === graphWithId.id);

  const mutation = await new FlowMutationService(repo).save({
    ...(existingFlow ? { id: existingFlow.id, mustExist: true } : {}),
    ownerId,
    name: manifest.name,
    graph: graphWithId,
    ...(options.impactReceipt === undefined ? {} : { impactReceipt: options.impactReceipt }),
  });
  if (mutation.status !== "saved") {
    return {
      ok: false,
      mutationRefused: true,
      status: mutation.status,
      ...(mutation.status === "impact-required"
        ? { receipt: mutation.receipt, impact: mutation.impact }
        : {}),
    };
  }
  const flowRecord = mutation.flow;

  // Promote the saved graph to an immutable Live deployment BEFORE any agent
  // write. A pushed agent without an active Live deployment cannot serve paid
  // calls (503 "published run unavailable"), so promotion failure fails the
  // push loudly instead of leaving a half-launched agent behind.
  const promotionRepo = await resolvePromotionRepo(repo, options.projectRepo);
  if (promotionRepo) {
    const promotion = await promoteFlowToLive({
      flowId: flowRecord.id,
      ownerId,
      projectRepo: promotionRepo,
    });
    if (promotion.status !== "promoted") {
      throw new CliLaunchPromotionError(promotion.stage);
    }
  }

  // Dedup agent (one per flow)
  const existingAgent = await repo.getAgentByFlowId(flowRecord.id);
  const agent = existingAgent
    ? ((await repo.updateAgent(existingAgent.id, {
        status: "live",
        priceUsdc,
      })) ?? existingAgent)
    : await repo.createAgent({
        flowId: flowRecord.id,
        slug: uniqueSlug(manifest.name),
        status: "live",
        priceUsdc,
      });

  // Upsert schedule if applicable
  if (cron !== null) {
    await repo.upsertSchedule({ agentId: agent.id, cron, enabled: true });
    void describeCron(cron);
    void nextOccurrence(cron, Date.now());
  }

  const returnedManifest = flowToManifest(requireFlowGraphV1(flowRecord.graph, "CLI push manifest generation"));

  return {
    ok: true,
    slug: agent.slug,
    url: `/a/${agent.slug}`,
    manifest: returnedManifest,
  };
}

/**
 * List all agents for an owner, each with its manifest.
 */
export async function handleCliAgentsList(
  ownerId: string,
  repo: FlowRepo,
): Promise<ListResult> {
  const agents = await repo.listAgentsByOwner(ownerId);
  if (agents.length === 0) return { agents: [] };

  const flows = await repo.listFlows(ownerId);
  const flowById = new Map(flows.map((f) => [f.id, f]));

  const manifests: AgentManifest[] = [];
  for (const agent of agents) {
    const flow = flowById.get(agent.flowId);
    if (!flow) continue;
    manifests.push(flowToManifest(requireFlowGraphV1(flow.graph, "CLI agent listing")));
  }

  return { agents: manifests };
}
