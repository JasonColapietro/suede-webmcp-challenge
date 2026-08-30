/** Vercel AI SDK wrapper — provider selection: Anthropic > OpenRouter > stub. */
import { generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

export interface LlmGenerateOptions {
  system?: string;
  model?: string;
}

/** Provider-reported token usage for a single generate call. */
export interface LlmUsage {
  /** Total tokens (input + output) this call consumed. */
  totalTokens: number;
}

export interface LlmGeneration {
  text: string;
  usage: LlmUsage;
}

export interface LlmClient {
  generate(prompt: string, opts?: LlmGenerateOptions): Promise<string>;
  /**
   * Usage-reporting variant of `generate`. `generate` discards the provider's
   * token usage, which made real flow-run inference invisible to metering —
   * this is the metered path's source of truth for how many tokens a call
   * actually consumed. Optional so minimal test doubles (`{ generate }`)
   * still satisfy the interface; every client this module constructs
   * implements it.
   */
  generateWithUsage?(prompt: string, opts?: LlmGenerateOptions): Promise<LlmGeneration>;
}

/**
 * Rough token estimate (~4 chars/token) used only when a provider response
 * carries no usable usage numbers. Deliberately conservative in intent:
 * metering falls back to an estimate rather than booking the call as free.
 */
export function estimateLlmTokens(prompt: string, text: string, system?: string): number {
  const chars = prompt.length + text.length + (system?.length ?? 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/** Normalize the AI SDK's reported usage; estimate when it is absent/NaN. */
function totalTokensOrEstimate(
  usage: { totalTokens?: number } | undefined,
  prompt: string,
  text: string,
  system?: string,
): number {
  const reported = usage?.totalTokens;
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
    return reported;
  }
  return estimateLlmTokens(prompt, text, system);
}

/** Whether a real (funded) provider key is configured in this environment. */
export function hasRealLlmProvider(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY);
}

export interface CreateLlmConfig {
  apiKey?: string;
  defaultModel?: string;
}

export interface CreateOpenRouterConfig {
  apiKey?: string;
  defaultModel?: string;
}

export function createLlm(config: CreateLlmConfig = {}): LlmClient {
  const anthropic = createAnthropic({
    apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
  });
  const defaultModel = config.defaultModel ?? "claude-haiku-4-5-20251001";

  const generateWithUsage = async (
    prompt: string,
    opts: LlmGenerateOptions = {},
  ): Promise<LlmGeneration> => {
    const { text, usage } = await generateText({
      model: anthropic(opts.model || defaultModel) as LanguageModel,
      system: opts.system,
      prompt,
    });
    return { text, usage: { totalTokens: totalTokensOrEstimate(usage, prompt, text, opts.system) } };
  };

  return {
    async generate(prompt: string, opts: LlmGenerateOptions = {}): Promise<string> {
      return (await generateWithUsage(prompt, opts)).text;
    },
    generateWithUsage,
  };
}

export function createOpenRouterLlm(config: CreateOpenRouterConfig = {}): LlmClient {
  const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
  const openrouter = createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
  });
  const defaultModel =
    config.defaultModel ?? process.env.LLM_DEFAULT_MODEL ?? "google/gemini-2.5-flash-lite";

  const generateWithUsage = async (
    prompt: string,
    opts: LlmGenerateOptions = {},
  ): Promise<LlmGeneration> => {
    const { text, usage } = await generateText({
      model: openrouter(opts.model || defaultModel) as LanguageModel,
      system: opts.system,
      prompt,
    });
    return { text, usage: { totalTokens: totalTokensOrEstimate(usage, prompt, text, opts.system) } };
  };

  return {
    async generate(prompt: string, opts: LlmGenerateOptions = {}): Promise<string> {
      return (await generateWithUsage(prompt, opts)).text;
    },
    generateWithUsage,
  };
}

/** A deterministic stub for tests and dry-run flows with no API key. */
export function createStubLlm(reply: (prompt: string) => string = (p) => `stub:${p}`): LlmClient {
  return {
    async generate(prompt: string): Promise<string> {
      return reply(prompt);
    },
    // The stub performs no provider call, so its usage is genuinely zero —
    // metering must never bill for stubbed inference.
    async generateWithUsage(prompt: string): Promise<LlmGeneration> {
      return { text: reply(prompt), usage: { totalTokens: 0 } };
    },
  };
}

/**
 * Selects the best available LLM client from the environment.
 * Priority: ANTHROPIC_API_KEY → OPENROUTER_API_KEY → deterministic stub.
 */
export function createLlmFromEnv(): LlmClient {
  if (process.env.ANTHROPIC_API_KEY) {
    return createLlm();
  }
  if (process.env.OPENROUTER_API_KEY) {
    return createOpenRouterLlm();
  }
  return createStubLlm();
}
