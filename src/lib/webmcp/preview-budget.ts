/**
 * A per-target-agent ceiling on free dry-run previews.
 *
 * THE EXPOSURE. The dry-run branch of POST /api/agents/[agent]/run resolves no
 * session, and no free-tier entitlement check reaches it — by design, because
 * the free human preview must never hit the x402 paywall (that was the cause of
 * the App Store 2.1 rejection). Yet every anonymous preview still writes a
 * durable runs row through repo.createRun. Model spend is NOT the exposure: the
 * executor substitutes a stub for every cost-bearing node, so a dry-run burns
 * no inference. The exposure is durable database writes and unmetered CPU. The
 * per-agent daily cost cap cannot bound it either, because a dry-run's
 * costUsdc is 0 and the cap counts spend.
 *
 * The existing limiter is `run:<ip>` — one bucket per source IP across every
 * agent. That bounds a single caller but not a distributed set of callers
 * pointed at one target. This adds the missing dimension: a bucket per agent,
 * checked BEFORE the run row is written.
 *
 * The ceiling is deliberately generous. It exists to stop a machine loop, not
 * to ration humans, and it is shared across everyone previewing the same agent
 * — so a tight bucket here would break exactly the free preview path the App
 * Store requires us to keep open. Previews are never put behind payment.
 */
import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";

/**
 * 120 burst, refilling 5/sec. A human clicking "Try it" is orders of magnitude
 * below this; an agent looping previews is orders of magnitude above it.
 */
export const PREVIEW_BUDGET = { capacity: 120, refillPerSec: 5 } as const;

export function previewBudgetKey(agentSlug: string): string {
  return `preview:${agentSlug}`;
}

/**
 * Whether one more free preview of this agent may run.
 *
 * `nowMs` is threaded through so the decision is deterministic under test.
 */
export function checkPreviewBudget(
  agentSlug: string,
  nowMs: number = Date.now(),
): RateLimitResult {
  return checkRateLimit(previewBudgetKey(agentSlug), PREVIEW_BUDGET, nowMs);
}
