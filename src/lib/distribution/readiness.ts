/**
 * Per-agent discovery readiness.
 *
 * A readiness check reports FACTS the studio can verify in-process — that the
 * agent resolves, that its discovery manifest builds with a valid x402 accept,
 * that it clears the public-catalog filter, that a real payout wallet is set,
 * and which x402 protocol version its docs actually emit. It never claims that
 * an external index (Bazaar, x402search) has accepted the listing — that's not
 * observable from here. The checks reuse the exact builders the live discovery
 * routes use (`resolveAgent`, `resolvePublicAgentGraph`, `resolvePayout`,
 * `buildX402PaymentRequired`), so a "pass" means those routes would serve the
 * same thing.
 *
 * Server-only. Never import into a client component.
 */
import { resolveAgent } from "../agents";
import { getRepo } from "../db/repo";
import { isTestAgent, summarizeGraph } from "../catalog";
import { deriveInputSchema } from "../flow/input-contract";
import { curatedBusinessService } from "../curated-business-services";
import { resolvePayout, ZERO_ADDRESS } from "../payout";
import { getProjectRepo } from "../projects/provider";
import { resolvePublicAgentGraph } from "../projects/public-agent-graph";
import {
  buildX402PaymentRequired,
  buildX402BazaarExtensions,
} from "../rails/x402-verify";
import { SITE_URL } from "../site";

export type ReadinessState = "pass" | "fail" | "na" | "info";

export interface ReadinessCheck {
  id: string;
  label: string;
  state: ReadinessState;
  detail: string;
  /** Present when the check is fixable — a short instruction for the owner. */
  fix?: string;
}

export interface ReadinessReport {
  agentId: string;
  slug: string;
  /** The x402 version the agent's discovery docs actually emit right now. */
  protocolVersion: number;
  checks: ReadinessCheck[];
}

/**
 * Thrown when the agent does not exist or is not owned by the caller. The route
 * maps this to 404 for both cases so agent existence never leaks to non-owners.
 */
export class DiscoveryAgentNotFoundError extends Error {
  public readonly code = "AGENT_NOT_FOUND" as const;

  constructor() {
    super("agent not found");
    this.name = "DiscoveryAgentNotFoundError";
  }
}

/** Platform-wide live-settlement flag, read the same way the run route reads it. */
function platformSettlementLive(): boolean {
  return process.env.X402_SKIP_SETTLEMENT === "false";
}

export async function checkAgentDiscoveryReadiness(
  agentIdOrSlug: string,
  ownerId: string,
): Promise<ReadinessReport> {
  const agent = await resolveAgent(agentIdOrSlug);
  if (!agent) throw new DiscoveryAgentNotFoundError();

  const repo = await getRepo();
  const flow = await repo.getFlow(agent.flowId);
  if (!flow || flow.ownerId !== ownerId) throw new DiscoveryAgentNotFoundError();

  const publicGraph = await resolvePublicAgentGraph({
    flow,
    projectRepo: await getProjectRepo().catch(() => null),
  });
  const payout = await resolvePayout(agent);

  // Build the per-agent discovery doc with the SAME builder the live
  // /.well-known/x402 route uses, so protocol_version and discovery_doc report
  // exactly what that route serves. A build failure (e.g. a non-https resource)
  // is captured as a failing discovery_doc check rather than crashing.
  const resourceUrl = `${SITE_URL}/api/agents/${agent.slug}/run`;
  const curated = publicGraph ? curatedBusinessService(agent.slug, publicGraph) : null;
  const description = curated?.description ??
    (publicGraph ? `${flow.name}: ${summarizeGraph(publicGraph)}` : flow.name);
  let protocolVersion = 0;
  let discoveryDocBuilds = false;
  try {
    const inputSchema = curated?.inputSchema ??
      (publicGraph ? deriveInputSchema(publicGraph) : { type: "object" as const });
    const outputSchema = curated?.outputSchema ?? {
      type: "object",
      additionalProperties: true,
    };
    const doc = buildX402PaymentRequired({
      priceUsdc: agent.priceUsdc,
      payTo: payout.payTo,
      resource: resourceUrl,
      description,
      tags: curated ? [...curated.tags] : ["suede", "agent", "x402"],
      outputSchema,
      extensions: buildX402BazaarExtensions({
        inputSchema,
        outputSchema,
        exampleInput: curated?.exampleInput ?? {},
        exampleOutput: curated?.exampleOutput ?? { ok: true },
      }),
    });
    protocolVersion = doc.x402Version;
    discoveryDocBuilds = doc.accepts.length > 0;
  } catch {
    discoveryDocBuilds = false;
  }

  const graphResolves = publicGraph !== null;
  const isLive = agent.status === "live";
  const isTest = isTestAgent(agent.slug, flow.name);
  const inPublicCatalog = graphResolves && isLive && !isTest;
  const hasWallet = payout.payTo.toLowerCase() !== ZERO_ADDRESS.toLowerCase();
  const settlementReady = agent.settlementLive && platformSettlementLive();

  const checks: ReadinessCheck[] = [
    {
      id: "discovery_doc",
      label: "x402 discovery manifest live",
      state: graphResolves && discoveryDocBuilds ? "pass" : "fail",
      detail:
        graphResolves && discoveryDocBuilds
          ? `Serving at ${SITE_URL}/api/agents/${agent.slug}/.well-known/x402 with a valid payment accept.`
          : "The discovery manifest does not build for this agent yet.",
      ...(graphResolves && discoveryDocBuilds
        ? {}
        : { fix: "Relaunch the agent so its discovery manifest publishes." }),
    },
    {
      id: "agent_card",
      label: "Agent card published",
      state: graphResolves ? "pass" : "fail",
      detail: graphResolves
        ? `Serving at ${SITE_URL}/api/agents/${agent.slug}/.well-known/agent-card.json.`
        : "The agent card is not being served yet.",
      ...(graphResolves ? {} : { fix: "Relaunch the agent to publish its agent card." }),
    },
    {
      id: "a2a",
      label: "A2A endpoint reachable",
      state: graphResolves ? "pass" : "fail",
      detail: graphResolves
        ? `A2A 1.0 AgentCard at ${SITE_URL}/api/agents/${agent.slug}/a2a with HTTP+JSON execution at /message:send.`
        : "The A2A endpoint is not being served yet.",
      ...(graphResolves ? {} : { fix: "Relaunch the agent to publish its A2A endpoint." }),
    },
    {
      id: "in_root_index",
      label: "Listed in the studio's root index",
      state: inPublicCatalog ? "pass" : isLive ? "fail" : "na",
      detail: inPublicCatalog
        ? `Included in ${SITE_URL}/.well-known/x402.`
        : isLive
          ? "Live, but excluded from the root index (a test/demo slug pattern or an unresolved graph)."
          : "Only live agents appear in the root index.",
      ...(inPublicCatalog || !isLive
        ? {}
        : { fix: "Rename the agent so its slug does not match a test/demo pattern." }),
    },
    {
      id: "in_catalog_feed",
      label: "Present in /api/catalog",
      state: inPublicCatalog ? "pass" : isLive ? "fail" : "na",
      detail: inPublicCatalog
        ? `Returned by ${SITE_URL}/api/catalog.`
        : isLive
          ? "Live, but excluded from the catalog feed (same filter as the root index)."
          : "Only live agents appear in the catalog feed.",
    },
    {
      id: "crawlable",
      label: "Discovery paths crawlable",
      state: "info",
      detail:
        "robots.ts re-allows /.well-known/ discovery paths and /api/catalog for the AI-crawler allowlist while blocking the rest of /api/.",
    },
    {
      id: "payout_wallet",
      label: "Payout wallet set",
      state: hasWallet ? "pass" : "fail",
      detail: hasWallet
        ? `Paid calls route to ${payout.payTo} (${payout.source}).`
        : "No payout wallet is set — paid calls would route to the zero address.",
      ...(hasWallet
        ? {}
        : { fix: "Set a payout wallet on relaunch so earnings route to you." }),
    },
    {
      id: "settlement_ready",
      label: "Settlement enabled (required for Bazaar auto-listing)",
      state: settlementReady ? "pass" : "fail",
      detail: settlementReady
        ? "Live settlement is on for this agent, so a paid call can settle on-chain."
        : agent.settlementLive
          ? "Enabled on this agent, but the platform is running in dry-run (X402_SKIP_SETTLEMENT is not false)."
          : "Settlement is off for this agent — a paid call cannot settle on-chain yet.",
      ...(settlementReady
        ? {}
        : {
            fix: agent.settlementLive
              ? "Platform settlement is in dry-run; no per-agent change needed."
              : "Enable settlement on this agent so a paid call can settle (Bazaar lists you after the first settled call).",
          }),
    },
    {
      id: "protocol_version",
      label: "x402 protocol version",
      state: "info",
      detail:
        protocolVersion > 0
          ? `Your discovery docs emit x402 version ${protocolVersion}.`
          : "Could not read the emitted x402 version from the discovery doc.",
    },
  ];

  return {
    agentId: agent.id,
    slug: agent.slug,
    protocolVersion,
    checks,
  };
}
