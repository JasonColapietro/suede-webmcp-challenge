/**
 * Pure handler logic for /api/cli/agents/[slug]/relay (POST + GET).
 *
 * Extracted from the Next.js route so vitest can import it without next/server.
 *
 * POST — register or update a relay URL for an agent; returns the secret ONCE.
 * GET  — returns { url, linked: true } but NEVER the secret.
 *
 * Ownership: the bearer token (ownerId) must match the flow's owner_id.
 */
import { generateRelaySecret } from "@/lib/relay";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-url";
import type { FlowRepo } from "@/lib/db/repo";

export interface RelayPostOk {
  ok: true;
  secret: string;
  url: string;
  protocolVersion: 1 | 2;
}

export interface RelayPostError {
  ok: false;
  reason: string;
  status: number;
}

export type RelayPostResult = RelayPostOk | RelayPostError;

export interface RelayGetResult {
  url: string;
  linked: true;
  protocolVersion: 1 | 2;
}

/**
 * Register or replace the relay endpoint for `slug`.
 *
 * Ownership check: resolves the agent by slug, then verifies the agent's flow
 * belongs to `ownerId`.
 *
 * Returns the secret exactly once on success; subsequent calls regenerate it.
 */
export async function handleRelayPost(
  slug: string,
  ownerId: string,
  url: string,
  repo: FlowRepo,
  protocolVersion: 1 | 2 = 1,
): Promise<RelayPostResult> {
  const agent = await repo.getAgentBySlug(slug);
  if (!agent) return { ok: false, reason: "agent not found", status: 404 };

  // Ownership check via the flow
  const flow = await repo.getFlow(agent.flowId);
  if (!flow) return { ok: false, reason: "flow not found", status: 404 };
  if (flow.ownerId !== ownerId) return { ok: false, reason: "not found", status: 404 };
  if (flow.graph.meta?.resourceProduct !== undefined) {
    return { ok: false, reason: "Resource agents do not support relay execution.", status: 409 };
  }

  // SSRF guard: reject relay URLs that point at localhost, cloud metadata,
  // or any other internal/RFC1918 address. Re-validated again at fetch
  // time in forwardToRelay() since DNS answers can change after this call.
  try {
    await assertSafeUrl(url);
  } catch (e) {
    const reason = e instanceof UnsafeUrlError ? e.message : "Invalid relay URL";
    return { ok: false, reason, status: 400 };
  }

  const secret = generateRelaySecret();
  await repo.upsertRelayEndpoint({ agentId: agent.id, url, secret, protocolVersion });

  return { ok: true, secret, url, protocolVersion };
}

/**
 * Return the relay endpoint info for `slug` (no secret).
 * Returns null if no relay is registered or the owner doesn't match.
 */
export async function handleRelayGet(
  slug: string,
  ownerId: string,
  repo: FlowRepo,
): Promise<RelayGetResult | null> {
  const agent = await repo.getAgentBySlug(slug);
  if (!agent) return null;

  const flow = await repo.getFlow(agent.flowId);
  if (!flow || flow.ownerId !== ownerId) return null;

  const relay = await repo.getRelayEndpoint(agent.id);
  if (!relay) return null;

  return { url: relay.url, linked: true, protocolVersion: relay.protocolVersion };
}
