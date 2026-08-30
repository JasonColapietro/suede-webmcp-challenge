/**
 * Pure handler logic for POST /api/agents/[agent]/webhook/rotate.
 *
 * Extracted from the route (src/app/api/agents/[agent]/webhook/rotate/route.ts)
 * so vitest can exercise it directly, mirroring src/lib/webhook-handler.ts and
 * src/lib/cli/settlement-handler.ts's conventions in this codebase.
 *
 * Ownership check mirrors settlement-handler.ts's handleSettlementToggle
 * exactly: resolve the agent (id or slug), load its flow, and require
 * flow.ownerId === the caller's resolved owner id. A caller who isn't the
 * owner gets the same `not_found` discriminant a caller for a nonexistent
 * agent gets — the route maps both to 404, so a non-owner can't use this
 * endpoint to learn whether a given agent id/slug even exists.
 *
 * Rotation itself reuses generateWebhookSecret() (the same derivation used
 * once at launch — see webhook-auth.ts for why the returned hex digest IS
 * the credential) and calls the existing upsertWebhookEndpoint(), which is a
 * genuine INSERT ... ON CONFLICT DO UPDATE / upsert — see
 * tests/db/webhook-endpoints.test.ts "upserts in place" — so the old
 * secret_hash is atomically replaced by the new one. There is no window
 * where two secrets are simultaneously valid, and no separate "revoke" step
 * is needed for the old secret to stop working.
 */
import type { FlowRepo } from "@/lib/db/repo";
import { resolveAgent } from "@/lib/agents";
import { generateWebhookSecret } from "@/lib/webhook-auth";
import type { RateLimitOptions } from "@/lib/rate-limit";

/**
 * Shared rate-limit shape for both owner-mutation routes in this file's
 * blast radius (rotate and revoke). Deliberately tighter than the per-call
 * hot-path buckets (run/webhook default to a 10-30 request burst): these are
 * sensitive, rare mutations, not something a legitimate owner ever needs to
 * call in a tight loop.
 */
export const WEBHOOK_MUTATION_RATE_LIMIT: RateLimitOptions = { capacity: 5, refillPerSec: 1 / 60 };

export type WebhookRotateError =
  | { kind: "not_found" }
  | { kind: "no_webhook" };

export interface WebhookRotateResult {
  agentId: string;
  slug: string;
  /** The new secret. Shown exactly once — it cannot be recovered later, same as launch. */
  secret: string;
}

/**
 * Rotate the webhook secret for `agentParam` (id or slug), on behalf of
 * `ownerId`. Returns the new secret once, or an error discriminant:
 *   - `not_found`: no such agent, OR the agent exists but isn't owned by
 *     `ownerId` (deliberately indistinguishable, same as settlement-handler).
 *   - `no_webhook`: the agent exists and is owned by the caller, but has no
 *     webhook_endpoints row (never launched with a webhook node, or one was
 *     never provisioned). Rotating something that doesn't exist is a clean
 *     4xx, not a 500.
 */
export async function handleWebhookRotate(
  agentParam: string,
  ownerId: string,
  repo: FlowRepo,
): Promise<WebhookRotateResult | WebhookRotateError> {
  const agent = await resolveAgent(agentParam);
  if (!agent) {
    return { kind: "not_found" };
  }

  const flow = await repo.getFlow(agent.flowId);
  if (!flow || flow.ownerId !== ownerId) {
    return { kind: "not_found" };
  }

  const existing = await repo.getWebhookEndpoint(agent.id);
  if (!existing) {
    return { kind: "no_webhook" };
  }

  const secret = generateWebhookSecret();
  await repo.upsertWebhookEndpoint({ agentId: agent.id, secretHash: secret });

  return { agentId: agent.id, slug: agent.slug, secret };
}

export interface WebhookRevokeResult {
  agentId: string;
  slug: string;
  revoked: boolean;
}

/**
 * Delete (revoke) the webhook endpoint for `agentParam`, on behalf of
 * `ownerId`. Same ownership semantics as handleWebhookRotate. Unlike
 * rotation, this disables inbound webhooks entirely rather than minting a
 * new secret — useful when a compromised secret needs to be killed
 * immediately and the owner isn't ready to reconfigure a sender yet.
 */
export async function handleWebhookRevoke(
  agentParam: string,
  ownerId: string,
  repo: FlowRepo,
): Promise<WebhookRevokeResult | WebhookRotateError> {
  const agent = await resolveAgent(agentParam);
  if (!agent) {
    return { kind: "not_found" };
  }

  const flow = await repo.getFlow(agent.flowId);
  if (!flow || flow.ownerId !== ownerId) {
    return { kind: "not_found" };
  }

  const existing = await repo.getWebhookEndpoint(agent.id);
  if (!existing) {
    return { kind: "no_webhook" };
  }

  const revoked = await repo.deleteWebhookEndpoint(agent.id);
  return { agentId: agent.id, slug: agent.slug, revoked };
}
