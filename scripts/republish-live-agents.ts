/**
 * Backfill Live deployments for already-launched agents.
 *
 * Legacy launches published the agent row without promoting the flow to an
 * immutable Live deployment, so their paid (non-dry-run) calls 503 with
 * "published run unavailable". For every live agent whose flow lacks an
 * active Live deployment, this checkpoints the current draft graph as a
 * version and promotes it PROMOTE TEST -> PROMOTE LIVE through the same
 * shared helper the launch route now uses (src/lib/launch/promote-live.ts).
 *
 * DRY-RUN BY DEFAULT: prints what it would promote and writes nothing.
 * Pass --execute to actually promote.
 *
 * Runs directly against the configured database (DB_DRIVER / SQLITE_PATH or
 * the Supabase env vars), so point the env at prod to backfill prod:
 *
 *   # inspect (no writes)
 *   DB_DRIVER=supabase SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/republish-live-agents.ts
 *
 *   # write
 *   DB_DRIVER=supabase SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/republish-live-agents.ts --execute
 *
 * Local sqlite works the same way with DB_DRIVER=sqlite SQLITE_PATH=studio.db.
 */
import { pathToFileURL } from "node:url";
import { getRepo } from "../src/lib/db/repo";
import type { FlowRepo } from "../src/lib/db/repo";
import { promoteFlowToLive } from "../src/lib/launch/promote-live";
import type { PromoteLiveStage } from "../src/lib/launch/promote-live";
import { getProjectRepo } from "../src/lib/projects/provider";
import type { ProjectRepo } from "../src/lib/projects/repo";

export interface RepublishCandidate {
  readonly agentId: string;
  readonly slug: string;
  readonly flowId: string;
  readonly flowName: string;
  readonly ownerId: string;
  readonly priceUsdc: number;
}

export interface RepublishFailure {
  readonly slug: string;
  readonly flowId: string;
  readonly stage: PromoteLiveStage;
}

export interface RepublishSummary {
  /** Live agents inspected. */
  readonly scanned: number;
  /** Agents whose flow already held an active Live deployment (skipped). */
  readonly alreadyLive: number;
  /** Agents with a missing flow row; they can never promote and are reported, not touched. */
  readonly orphaned: readonly string[];
  /** Agents that need (or needed) a Live deployment. */
  readonly candidates: readonly RepublishCandidate[];
  /** Slugs promoted this run (always empty on a dry-run). */
  readonly promoted: readonly string[];
  /** Promotions that failed, with the stage that refused. */
  readonly failed: readonly RepublishFailure[];
  /** True when --execute was set and writes were attempted. */
  readonly executed: boolean;
}

/**
 * Core walk, injectable for tests: scan live agents, find the ones without an
 * active Live deployment, and (only when execute is true) promote each via
 * promoteFlowToLive. Never mutates agent rows; promotion residue on failure
 * is safe (see promote-live.ts).
 */
export async function republishLiveAgents(input: {
  readonly repo: FlowRepo;
  readonly projectRepo: ProjectRepo;
  readonly execute: boolean;
  readonly log?: (line: string) => void;
}): Promise<RepublishSummary> {
  const log = input.log ?? ((): void => undefined);
  const agents = await input.repo.listLiveAgents();

  const orphaned: string[] = [];
  const candidates: RepublishCandidate[] = [];
  let alreadyLive = 0;

  for (const agent of agents) {
    const flow = await input.repo.getFlow(agent.flowId);
    if (!flow) {
      orphaned.push(agent.slug);
      log(`! orphaned (no flow row): ${agent.slug} (flow ${agent.flowId})`);
      continue;
    }
    const deployment = await input.projectRepo.getActiveDeployment({
      flowId: agent.flowId,
      environmentKind: "live",
      ownerId: flow.ownerId,
    });
    const hasActiveLive =
      deployment !== null && deployment.status === "live" && deployment.retiredAt === undefined;
    if (hasActiveLive) {
      alreadyLive += 1;
      log(`= already live-deployed: ${agent.slug} (${flow.name})`);
      continue;
    }
    candidates.push({
      agentId: agent.id,
      slug: agent.slug,
      flowId: agent.flowId,
      flowName: flow.name,
      ownerId: flow.ownerId,
      priceUsdc: agent.priceUsdc,
    });
  }

  const promoted: string[] = [];
  const failed: RepublishFailure[] = [];

  for (const candidate of candidates) {
    if (!input.execute) {
      log(
        `~ would promote: ${candidate.slug} (${candidate.flowName}, ` +
          `$${candidate.priceUsdc.toFixed(2)}/call, flow ${candidate.flowId})`,
      );
      continue;
    }
    const result = await promoteFlowToLive({
      flowId: candidate.flowId,
      ownerId: candidate.ownerId,
      projectRepo: input.projectRepo,
    });
    if (result.status === "promoted") {
      promoted.push(candidate.slug);
      log(`+ promoted to Live: ${candidate.slug} (version ${result.versionId.slice(0, 8)})`);
    } else {
      failed.push({ slug: candidate.slug, flowId: candidate.flowId, stage: result.stage });
      log(`x failed at ${result.stage}: ${candidate.slug} (flow ${candidate.flowId})`);
    }
  }

  return {
    scanned: agents.length,
    alreadyLive,
    orphaned,
    candidates,
    promoted,
    failed,
    executed: input.execute,
  };
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const repo = await getRepo();
  const projectRepo = await getProjectRepo();

  console.log(
    execute
      ? "EXECUTE MODE: promoting every live agent without an active Live deployment."
      : "DRY RUN: no writes. Pass --execute to promote.",
  );

  const summary = await republishLiveAgents({
    repo,
    projectRepo,
    execute,
    log: (line) => console.log(line),
  });

  console.log(
    `\n${summary.scanned} live agents scanned: ${summary.alreadyLive} already deployed, ` +
      `${summary.candidates.length} missing a Live deployment, ` +
      `${summary.orphaned.length} orphaned.`,
  );
  if (!summary.executed) {
    console.log(
      summary.candidates.length === 0
        ? "Nothing to do."
        : `Re-run with --execute to promote ${summary.candidates.length} agent(s).`,
    );
    return;
  }
  console.log(`Promoted ${summary.promoted.length}; failed ${summary.failed.length}.`);
  if (summary.failed.length > 0) {
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
