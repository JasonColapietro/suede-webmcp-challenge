import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("service-specific CDP Bazaar metadata", () => {
  it("projects typed examples and canonical slugs into every x402 discovery surface", async () => {
    const [rootIndex, perAgent, runRoute] = await Promise.all([
      source("src/app/.well-known/x402/route.ts"),
      source("src/app/api/agents/[agent]/.well-known/x402/route.ts"),
      source("src/app/api/agents/[agent]/run/route.ts"),
    ]);

    for (const emitter of [rootIndex, perAgent, runRoute]) {
      expect(emitter).toContain("buildX402BazaarExtensions");
      expect(emitter).toContain("outputSchema");
    }
    expect(perAgent).toContain("exampleInput");
    expect(runRoute).toContain("agent.slug}/run");
    expect(rootIndex).toContain("e.description ?? e.summary");
    expect(rootIndex).not.toContain("X402_AGENT_RUN_RESOURCE_DESCRIPTION");
    expect(rootIndex).toContain("e.extensions");
    for (const directEmitter of [perAgent, runRoute]) {
      expect(directEmitter).toContain("RESOURCE_CONTRACT_EXTENSION_URI");
    }
    expect(RESOURCE_CONTRACT_EXTENSION_URI).toBe(
      "https://agents.suedeai.ai/extensions/resource/v1",
    );
  });
});
