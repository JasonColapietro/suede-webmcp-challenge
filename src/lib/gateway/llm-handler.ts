/**
 * Gateway LLM handler — metered LLM proxy for external SDK agents.
 *
 * Auth: Authorization: Bearer <workspaceKey>
 * Rate limit: 20 burst / 20 per minute per owner.
 * Free tier: FREE_MONTHLY_GATEWAY_TOKENS tokens/month per owner before 402.
 * Writes a usage row after each call.
 */
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { checkRateLimit, peekTokenBudget, chargeTokenBudget } from "@/lib/rate-limit";
import {
  FREE_MONTHLY_GATEWAY_TOKENS,
  IP_DAILY_GATEWAY_TOKEN_BUDGET,
  gatewayCostUsdc,
} from "@/lib/billing";
import { topupInstructions } from "@/lib/gateway/topup-handler";
import { freeAllowanceEligible } from "@/lib/gateway/eligibility";
import type { FlowRepo } from "@/lib/db/repo";

// Per-IP request rate limit for the gateway (separate from the per-owner limit
// below). A fresh workspace key resets the per-owner bucket, but the source IP
// does not — this is what catches UUID-farming bursts. 30 burst / 30 per minute.
const GATEWAY_IP_BURST = 30;
const GATEWAY_IP_REFILL_PER_SEC = 0.5;

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const GatewayLlmBodySchema = z.object({
  system: z.string().optional(),
  prompt: z.string().min(1, "prompt is required"),
  model: z.string().optional(),
});

export type GatewayLlmBody = z.infer<typeof GatewayLlmBodySchema>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type GatewayLlmResult =
  | { ok: true; text: string; tokens: number; costUsdc: number }
  | {
      ok: false;
      status: 400 | 401 | 402 | 429 | 500 | 503;
      error: string;
      /** Machine-readable topup info — present on 402 only. */
      topup?: { topupEndpoint: string; tiers: readonly number[] };
    };

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Process a gateway LLM request.
 *
 * @param ownerId    - Resolved workspace owner (already authenticated).
 * @param body       - Parsed + validated request body.
 * @param repo       - FlowRepo for usage reads/writes.
 * @param nowMs      - Optional clock override for tests.
 * @param ip         - Client IP for per-IP caps (omit/"unknown" → per-IP caps skipped).
 */
export async function handleGatewayLlm(
  ownerId: string,
  body: GatewayLlmBody,
  repo: FlowRepo,
  nowMs: number = Date.now(),
  ip?: string,
): Promise<GatewayLlmResult> {
  // Rate limit: 20 burst, 20 per minute (= refillPerSec 20/60), keyed per owner.
  const rl = checkRateLimit(`gateway-llm:${ownerId}`, { capacity: 20, refillPerSec: 20 / 60 }, nowMs);
  if (!rl.allowed) {
    return { ok: false, status: 429, error: `Rate limited. Retry after ${rl.retryAfterSec}s.` };
  }

  // Per-IP request rate limit — a fresh workspace key resets the per-owner
  // bucket above, so this is the layer that throttles UUID-farming bursts.
  const ipKnown = typeof ip === "string" && ip.length > 0 && ip !== "unknown";
  if (ipKnown) {
    const ipRl = checkRateLimit(
      `gateway-llm-ip:${ip}`,
      { capacity: GATEWAY_IP_BURST, refillPerSec: GATEWAY_IP_REFILL_PER_SEC },
      nowMs,
    );
    if (!ipRl.allowed) {
      return { ok: false, status: 429, error: `Rate limited (network). Retry after ${ipRl.retryAfterSec}s.` };
    }
  }

  // Provisioning probe + monthly quota check — before calling the LLM.
  // A missing usage/credits table means billing is dark: clean 503, never a
  // raw driver error leaking through the route's generic 500.
  let monthlyUnits: number;
  let spendingCredit = false;
  try {
    monthlyUnits = await repo.sumMonthlyUsage(ownerId, "llm");
  } catch {
    return { ok: false, status: 503, error: "billing not provisioned" };
  }
  if (monthlyUnits >= FREE_MONTHLY_GATEWAY_TOKENS) {
    // Over the free allowance: paid credit (topup) keeps the gateway open.
    const balance = await repo.getCreditBalance(ownerId).catch(() => 0);
    if (balance > 0) {
      spendingCredit = true;
    } else {
      const info = topupInstructions();
      return {
        ok: false,
        status: 402,
        error: `Monthly gateway token limit (${FREE_MONTHLY_GATEWAY_TOKENS.toLocaleString()}) reached. ${info.message}`,
        topup: { topupEndpoint: info.topupEndpoint, tiers: info.tiers },
      };
    }
  } else {
    // Within the free allowance: it is an entitlement earned by having paid,
    // not a default. A workspace holding live credit is obviously eligible and
    // is checked as a fallback below.
    const eligible = await freeAllowanceEligible(ownerId, repo, nowMs);
    if (!eligible) {
      const balance = await repo.getCreditBalance(ownerId).catch(() => 0);
      if (balance > 0) {
        spendingCredit = true;
      } else {
        const info = topupInstructions();
        return {
          ok: false,
          status: 402,
          error: `The free monthly gateway allowance is included with any paid workspace. ${info.message}`,
          topup: { topupEndpoint: info.topupEndpoint, tiers: info.tiers },
        };
      }
    }
  }

  // Per-IP daily token budget — the hard backstop on free-tier consumption from
  // one source IP, summed across every workspace key it cycles through. Only
  // free usage is charged/gated; paid (credit) usage is real money and exempt.
  let ipBudgetKey = ipKnown && !spendingCredit ? `gateway-ip-tokens:${ip}` : null;
  if (ipBudgetKey) {
    const peek = peekTokenBudget(ipBudgetKey, { capacity: IP_DAILY_GATEWAY_TOKEN_BUDGET }, nowMs);
    if (peek.remaining < 1) {
      // The network's daily FREE budget is spent. A workspace with credit
      // transparently falls back to paid credit (the paid path is never blocked
      // by the free-tier cap); everyone else waits for the daily refill.
      const balance = await repo.getCreditBalance(ownerId).catch(() => 0);
      if (balance > 0) {
        spendingCredit = true;
        ipBudgetKey = null; // paid usage isn't charged against the free IP budget
      } else {
        return {
          ok: false,
          status: 429,
          error: "Daily free-tier token budget for this network is exhausted. Retry tomorrow or top up.",
        };
      }
    }
  }

  // Build the model — same priority as createLlmFromEnv.
  let model: LanguageModel;
  if (process.env.ANTHROPIC_API_KEY) {
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const modelId = body.model ?? "claude-sonnet-4-6";
    model = anthropic(modelId) as LanguageModel;
  } else if (process.env.OPENROUTER_API_KEY) {
    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
    });
    const modelId = body.model ?? (process.env.LLM_DEFAULT_MODEL ?? "google/gemini-2.5-flash-lite");
    model = openrouter(modelId) as LanguageModel;
  } else {
    // Stub mode — return deterministic text without hitting any API.
    const stubText = `stub:${body.prompt}`;
    const tokens = Math.ceil(stubText.length / 4);
    const costUsdc = gatewayCostUsdc(tokens);
    await repo.createUsage({ ownerId, kind: "llm", units: tokens, costUsdc });
    if (ipBudgetKey) {
      chargeTokenBudget(ipBudgetKey, tokens, { capacity: IP_DAILY_GATEWAY_TOKEN_BUDGET }, nowMs);
    }
    return { ok: true, text: stubText, tokens, costUsdc };
  }

  try {
    const result = await generateText({
      model,
      system: body.system,
      prompt: body.prompt,
    });

    const tokens = result.usage?.totalTokens ?? 0;
    const costUsdc = gatewayCostUsdc(tokens);

    // Write usage row; debit credit when past the free allowance. Best-effort
    // (probe above guarantees provisioning; a race here must not fail the call).
    await repo.createUsage({ ownerId, kind: "llm", units: tokens, costUsdc }).catch(() => undefined);
    if (spendingCredit && costUsdc > 0) {
      await repo
        .createCredit({ ownerId, deltaUsdc: -costUsdc, reason: "gateway:llm", tx: null })
        .catch(() => undefined);
    }
    if (ipBudgetKey) {
      chargeTokenBudget(ipBudgetKey, tokens, { capacity: IP_DAILY_GATEWAY_TOKEN_BUDGET }, nowMs);
    }

    return { ok: true, text: result.text, tokens, costUsdc };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "LLM error";
    return { ok: false, status: 500, error: message };
  }
}
