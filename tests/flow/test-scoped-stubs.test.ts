import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeContext, NodeResult } from "@/lib/flow/executor";
import { NODE_DEFINITIONS } from "@/lib/flow/node-definitions";
import { NODE_DEFS } from "@/lib/flow/nodes";
import { inspectTestInput } from "@/lib/flow/test-input-safety";
import { scopedTestStubFor } from "@/lib/flow/test-scoped-stubs";

function successfulOutputs(result: NodeResult): Record<string, unknown> {
  expect(result).toMatchObject({ ok: true, costUsdc: 0 });
  if (!result.ok) throw new Error("Expected scoped test stub success.");
  return result.outputs;
}

function deniedContext(spies: {
  readonly llm: ReturnType<typeof vi.fn>;
  readonly x402: ReturnType<typeof vi.fn>;
  readonly secret: ReturnType<typeof vi.fn>;
}): NodeContext {
  return {
    runId: "scoped-test",
    dryRun: true,
    ownerId: null,
    wallet: { address: null, network: "base-mainnet" },
    llm: { generate: spies.llm },
    x402: { call: spies.x402 } as unknown as NodeContext["x402"],
    logger: { emit: vi.fn() } as unknown as NodeContext["logger"],
    loadSubflow: vi.fn(),
    resolveSubflow: vi.fn(),
    resolveResourcePack: vi.fn(),
    registry: {},
    depth: 0,
    flowAncestry: Object.freeze([]),
    costCeiling: { limitUsdc: 0, spentUsdc: 0, reservedUsdc: 0 },
    runVariables: Object.freeze({}),
    resolveSecretReference: spies.secret,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scoped test stub registry", () => {
  it("maps exactly every canonical stub type and no native, refuse, or unknown type", () => {
    const runtimeTypes = NODE_DEFS.map((definition) => definition.type).sort();
    const canonicalTypes = NODE_DEFINITIONS.map((definition) => definition.type).sort();
    expect(runtimeTypes).toEqual(canonicalTypes);

    for (const definition of NODE_DEFINITIONS) {
      const stub = scopedTestStubFor(definition.type);
      if (definition.testMode === "stub") {
        expect(stub, definition.type).toBeTypeOf("function");
      } else {
        expect(stub, definition.type).toBeUndefined();
      }
    }

    for (const unknown of [
      "unknown.future.node",
      "constructor",
      "toString",
      "__proto__",
    ]) {
      expect(scopedTestStubFor(unknown), unknown).toBeUndefined();
    }
  });

  it("returns only shape-compatible, zero-cost, JSON-safe constants", async () => {
    const context = deniedContext({ llm: vi.fn(), x402: vi.fn(), secret: vi.fn() });

    for (const definition of NODE_DEFS.filter(({ definition }) => definition.testMode === "stub")) {
      const stub = scopedTestStubFor(definition.type);
      expect(stub, definition.type).toBeTypeOf("function");
      if (!stub) continue;

      const result = await stub(context, {}, {});
      const outputs = successfulOutputs(result);
      expect(Object.keys(outputs).sort(), definition.type).toEqual([...definition.outputs].sort());
      expect(inspectTestInput(result), definition.type).toMatchObject({ ok: true });

      if (definition.type === "api.operation") {
        expect(outputs).toEqual({ result: { status: 0, body: null } });
      } else if (definition.type === "llm") {
        expect(outputs).toEqual({ result: "[Scoped test stub]" });
      } else if (
        definition.type === "http" ||
        definition.type === "comms.slackMessage" ||
        definition.type === "comms.crmWebhook" ||
        definition.type === "devops.githubIssue" ||
        definition.type === "devops.githubRead" ||
        definition.type === "devops.githubWorkflowDispatch"
      ) {
        expect(outputs).toEqual({ result: { status: 200, body: null } });
      } else if (definition.type === "suede.promo") {
        expect(outputs).toEqual({ campaign: { testMode: "stub" } });
      } else if (definition.type === "suede.promoClaims") {
        expect(outputs).toEqual({ claims: { claims: [], total: 0, testMode: "stub" } });
      } else {
        expect(outputs).toEqual({ result: { testMode: "stub" } });
      }
    }
  });

  it("does not inspect, echo, or call capabilities with hostile params and inputs", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const spies = { llm: vi.fn(), x402: vi.fn(), secret: vi.fn() };
    const context = deniedContext(spies);
    const canary = "SCOPED-STUB-CANARY-7f4ec9";
    const hostile = new Proxy({ canary }, {
      get() {
        throw new Error(canary);
      },
      ownKeys() {
        throw new Error(canary);
      },
    });

    for (const definition of NODE_DEFS.filter(({ definition }) => definition.testMode === "stub")) {
      const stub = scopedTestStubFor(definition.type);
      if (!stub) throw new Error(`Missing scoped stub for ${definition.type}`);
      const result = await stub(context, hostile, hostile as Record<string, unknown>);
      expect(JSON.stringify(result), definition.type).not.toContain(canary);
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spies.llm).not.toHaveBeenCalled();
    expect(spies.x402).not.toHaveBeenCalled();
    expect(spies.secret).not.toHaveBeenCalled();
  });

  it("returns fresh detached outputs whose mutation cannot affect later calls", async () => {
    const context = deniedContext({ llm: vi.fn(), x402: vi.fn(), secret: vi.fn() });

    for (const definition of NODE_DEFS.filter(({ definition }) => definition.testMode === "stub")) {
      const stub = scopedTestStubFor(definition.type);
      if (!stub) throw new Error(`Missing scoped stub for ${definition.type}`);
      const first = successfulOutputs(await stub(context, {}, {}));
      const second = successfulOutputs(await stub(context, {}, {}));
      const pristine = JSON.stringify(second);

      expect(first).not.toBe(second);
      const firstValue = Object.values(first)[0];
      const secondValue = Object.values(second)[0];
      if (firstValue !== null && typeof firstValue === "object") {
        expect(firstValue).not.toBe(secondValue);
        (firstValue as Record<string, unknown>).mutated = true;
      }
      expect(JSON.stringify(second), definition.type).toBe(pristine);
    }
  });

  it("has no runtime dependency on node executors, providers, rails, or ambient services", () => {
    const source = readFileSync("src/lib/flow/test-scoped-stubs.ts", "utf8");
    const runtimeImports = [...source.matchAll(/import(?!\s+type\b)[\s\S]*?from\s+["']([^"']+)["']/gu)]
      .map((match) => match[1]);

    expect(runtimeImports).toEqual([]);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:\/nodes(?:\/|["'])|providers?|rails|gateway|run-context|run-service|db|projects|api)[^"']*["']/u);
    expect(source).not.toMatch(/\b(?:fetch|process\.env|resolveSecretReference|\.llm|\.x402|getRepo|createRun|appendStep|finishRun)\b/u);
  });
});
