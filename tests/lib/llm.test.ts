import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LlmClient } from "@/lib/llm";

// We mock "ai" and both @ai-sdk providers so no real network calls happen.
vi.mock("ai", () => ({
  generateText: vi.fn().mockResolvedValue({ text: "mocked-response" }),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ provider: "anthropic", modelId: "claude-sonnet-4-6" }))),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(({ baseURL }: { baseURL: string }) =>
    vi.fn((modelId: string) => ({ provider: "openai-compat", baseURL, modelId }))
  ),
}));

describe("createLlmFromEnv — provider selection", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns Anthropic client when ANTHROPIC_API_KEY is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const { createLlmFromEnv } = await import("@/lib/llm");

    const client = createLlmFromEnv();
    await client.generate("hello");

    expect(createAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-ant-test" })
    );
  });

  it("returns OpenRouter client when only OPENROUTER_API_KEY is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "or-test-key");

    const { createOpenAI } = await import("@ai-sdk/openai");
    const { createLlmFromEnv } = await import("@/lib/llm");

    const client = createLlmFromEnv();
    await client.generate("hello");

    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://openrouter.ai/api/v1", apiKey: "or-test-key" })
    );
  });

  it("returns stub client when no API keys are set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const { createLlmFromEnv } = await import("@/lib/llm");

    const client = createLlmFromEnv();
    const result = await client.generate("hello");

    // Stub returns "stub:<prompt>"
    expect(result).toBe("stub:hello");
  });

  it("prefers Anthropic over OpenRouter when both keys are set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("OPENROUTER_API_KEY", "or-test-key");

    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const { createLlmFromEnv } = await import("@/lib/llm");

    const client = createLlmFromEnv();
    // Anthropic path goes through generateText mock which returns "mocked-response"
    const result = await client.generate("test");

    expect(createAnthropic).toHaveBeenCalled();
    expect(result).toBe("mocked-response");
  });

  it("falls back to the default model when opts.model is an empty string", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const { createLlm } = await import("@/lib/llm");

    const mockModelFn = vi.fn(() => ({}));
    vi.mocked(createAnthropic).mockReturnValueOnce(mockModelFn as unknown as ReturnType<typeof createAnthropic>);

    const client = createLlm();
    await client.generate("hello", { model: "" });

    expect(mockModelFn).toHaveBeenCalledWith("claude-haiku-4-5-20251001");
  });
});

describe("createOpenRouterLlm — client construction", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes the OpenRouter baseURL to createOpenAI", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "or-key");

    const { createOpenAI } = await import("@ai-sdk/openai");
    const { createOpenRouterLlm } = await import("@/lib/llm");

    createOpenRouterLlm();

    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://openrouter.ai/api/v1" })
    );
  });

  it("uses google/gemini-2.5-flash-lite as the default model when LLM_DEFAULT_MODEL is not set", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "or-key");
    // Do NOT stub LLM_DEFAULT_MODEL so the default kicks in

    const { createOpenAI } = await import("@ai-sdk/openai");
    const { createOpenRouterLlm } = await import("@/lib/llm");

    const mockModelFn = vi.fn(() => ({}));
    vi.mocked(createOpenAI).mockReturnValueOnce(mockModelFn as unknown as ReturnType<typeof createOpenAI>);

    const client = createOpenRouterLlm();
    await client.generate("test");

    expect(mockModelFn).toHaveBeenCalledWith("google/gemini-2.5-flash-lite");
  });

  it("respects LLM_DEFAULT_MODEL env override", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "or-key");
    vi.stubEnv("LLM_DEFAULT_MODEL", "anthropic/claude-3-haiku");

    const { createOpenAI } = await import("@ai-sdk/openai");
    const { createOpenRouterLlm } = await import("@/lib/llm");

    const mockModelFn = vi.fn(() => ({}));
    vi.mocked(createOpenAI).mockReturnValueOnce(mockModelFn as unknown as ReturnType<typeof createOpenAI>);

    const client = createOpenRouterLlm();
    await client.generate("test");

    expect(mockModelFn).toHaveBeenCalledWith("anthropic/claude-3-haiku");
  });
});

describe("createStubLlm — deterministic, no network", () => {
  it("returns stub:prompt by default", async () => {
    const { createStubLlm } = await import("@/lib/llm");
    const client: LlmClient = createStubLlm();
    const result = await client.generate("hello world");
    expect(result).toBe("stub:hello world");
  });

  it("accepts a custom reply function", async () => {
    const { createStubLlm } = await import("@/lib/llm");
    const client: LlmClient = createStubLlm(() => "fixed-reply");
    const result = await client.generate("anything");
    expect(result).toBe("fixed-reply");
  });
});
