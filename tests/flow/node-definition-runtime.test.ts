import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineExecutableNode,
  requiresDryRunStub,
  withDryRunGuard,
  type CanonicalNodeDef,
  type NodeDef,
  type NodeExecutor,
} from "@/lib/flow/executor";
import {
  getNodeDefinition,
  NODE_DEFINITIONS,
} from "@/lib/flow/node-definitions";
import { NODE_DEFS } from "@/lib/flow/nodes";
import { getRegistry } from "@/lib/flow/registry";
import { inputNode } from "@/lib/flow/nodes/input";
import { outputNode } from "@/lib/flow/nodes/output";
import { branchNode } from "@/lib/flow/nodes/branch";
import { transformNode } from "@/lib/flow/nodes/transform";
import { scheduleNode } from "@/lib/flow/nodes/schedule";
import { webhookNode } from "@/lib/flow/nodes/webhook";
import { subflowNode } from "@/lib/flow/nodes/subflow";
import { loopNode } from "@/lib/flow/nodes/loop";
import { suedeNode } from "@/lib/flow/nodes/suede/factory";
import { SUEDE_ENDPOINTS } from "@/lib/rails/suede-endpoints";
import { makeCtx } from "../_helpers";

const LOCAL_BUILT_INS = [
  inputNode,
  outputNode,
  branchNode,
  transformNode,
  scheduleNode,
  webhookNode,
  subflowNode,
  loopNode,
] as const;

const passthrough: NodeExecutor = async (_ctx, _params, inputs) => ({
  ok: true,
  outputs: { result: inputs },
  costUsdc: 0,
});

function schemaKeyVariants(schema: z.ZodTypeAny): string[][] {
  if (schema instanceof z.ZodUnion) {
    return schema.options.flatMap((option: z.ZodTypeAny) => schemaKeyVariants(option));
  }
  if (schema instanceof z.ZodEffects) return schemaKeyVariants(schema.innerType());
  if (schema instanceof z.ZodObject) return [Object.keys(schema.shape).sort()];
  return [];
}

function expectedKeyVariants(def: CanonicalNodeDef): string[][] {
  const described = Object.keys(
    def.definition.configSchema.properties as Record<string, unknown>,
  ).sort();
  if (def.type === "subflow") return [described, ["reference"]];
  if (def.type === "loop") {
    return [
      described,
      [...described.filter((key) => key !== "flowId" && key !== "itemsPath"), "reference"].sort(),
    ];
  }
  return [described];
}

function sortedVariants(variants: string[][]): string[][] {
  return variants.map((keys) => [...keys].sort()).sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0")));
}

describe("canonical executable node definitions", () => {
  it("enumerates every catalog type exactly once as a canonical definition", () => {
    const canonicalDefs: readonly CanonicalNodeDef[] = NODE_DEFS;
    const runtimeTypes = canonicalDefs.map((def) => def.type);
    const catalogTypes = NODE_DEFINITIONS.map((definition) => definition.type);

    expect(runtimeTypes).toHaveLength(43);
    expect(new Set(runtimeTypes).size).toBe(43);
    expect([...runtimeTypes].sort()).toEqual([...catalogTypes].sort());

    for (const def of canonicalDefs) {
      expect(def.definition).toBe(getNodeDefinition(def.type));
    }
  });

  it("fails fast when built-in runtime definitions contain a duplicate type", () => {
    const mutableDefinitions = NODE_DEFS as CanonicalNodeDef[];
    mutableDefinitions.push(NODE_DEFS[0]!);
    try {
      expect(() => getRegistry()).toThrow(/duplicate.*input/i);
    } finally {
      mutableDefinitions.pop();
    }
  });

  it("derives every built-in dry-run classification from canonical testMode", () => {
    for (const def of NODE_DEFS) {
      const guarded = requiresDryRunStub(def);

      expect(def.definition.testMode === "native", def.type).toBe(!guarded);
      if (def.definition.testMode === "stub") {
        expect(guarded, def.type).toBe(true);
        expect(def.dryRunStub, def.type).toBeTypeOf("function");
      }
      if (def.definition.testMode === "refuse") {
        expect(guarded, def.type).toBe(true);
        expect(def.dryRunStub, def.type).toBeUndefined();
      }
    }
  });

  it("keeps every estimated descriptor price equal to its runtime price", () => {
    for (const def of NODE_DEFS) {
      if (def.definition.cost.kind === "estimated") {
        expect(def.priceUsdc, def.type).toBe(def.definition.cost.amount);
      }
    }
  });

  it("keeps every runtime Zod variant aligned with canonical config keys", () => {
    for (const def of NODE_DEFS) {
      expect(sortedVariants(schemaKeyVariants(def.paramsSchema)), def.type).toEqual(
        sortedVariants(expectedKeyVariants(def)),
      );
    }
  });

  it("rejects Suede endpoint and estimated descriptor price drift at construction", () => {
    const definition = {
      ...getNodeDefinition("suede.styleCoach"),
      cost: {
        kind: "estimated" as const,
        currency: "USDC" as const,
        amount: SUEDE_ENDPOINTS.styleCoach.priceUsdc + 0.01,
      },
    };

    expect(() =>
      suedeNode(
        definition,
        SUEDE_ENDPOINTS.styleCoach,
        z.object({ seed: z.string().optional() }),
        (params) => params,
      ),
    ).toThrow(/price/i);
  });

  it("projects every local built-in from the canonical catalog object", () => {
    for (const def of LOCAL_BUILT_INS) {
      expect(def.definition).toBe(getNodeDefinition(def.type));
      expect(def.label).toBe(def.definition.label);
      expect(def.group).toBe(def.definition.category);
      expect(def.inputs).toEqual(
        def.definition.inputPorts.map((port) => port.id),
      );
      expect(def.outputs).toEqual(
        def.definition.outputPorts.map((port) => port.id),
      );
    }
  });

  it("uses testMode rather than inherited capability disclosure to gate wrappers", () => {
    for (const def of [subflowNode, loopNode]) {
      expect(def.definition.capabilityMode).toBe("inherits-graph");
      expect(def.definition.effects).toContain("spend");
      expect(def.definition.cost.kind).toBe("variable");
      expect(def.definition.testMode).toBe("native");
      expect(def.costBearing).toBe(false);
      expect(def.sideEffecting).toBe(false);
    }
  });

  it("derives guarded runtime flags and finite estimated prices", () => {
    const definition = {
      ...getNodeDefinition("transform"),
      testMode: "stub" as const,
      effects: ["write", "spend"] as const,
      cost: {
        kind: "estimated" as const,
        currency: "USDC" as const,
        amount: 0.25,
      },
    };
    const dryRunStub: NodeExecutor = async () => ({
      ok: true,
      outputs: { result: "stub" },
      costUsdc: 0,
    });

    const def = defineExecutableNode(definition, {
      paramsSchema: z.unknown(),
      executor: passthrough,
      dryRunStub,
    });

    expect(def.definition).toBe(definition);
    expect(def.priceUsdc).toBe(0.25);
    expect(def.costBearing).toBe(true);
    expect(def.sideEffecting).toBe(true);
    expect(def.executor).toBe(passthrough);
    expect(def.dryRunStub).toBe(dryRunStub);
  });

  it("keeps refuse fail-closed and omits non-finite estimated prices", () => {
    const definition = {
      ...getNodeDefinition("transform"),
      testMode: "refuse" as const,
      cost: {
        kind: "estimated" as const,
        currency: "USDC" as const,
        amount: Number.POSITIVE_INFINITY,
      },
    };

    const def = defineExecutableNode(definition, {
      paramsSchema: z.unknown(),
      executor: passthrough,
    });

    expect(def.priceUsdc).toBeUndefined();
    expect(def.costBearing).toBe(true);
    expect(def.dryRunStub).toBeUndefined();
  });

  it("preserves canonical identity when adding the redundant direct-executor guard", () => {
    const canonical = defineExecutableNode(getNodeDefinition("llm"), {
      paramsSchema: z.unknown(),
      executor: passthrough,
      dryRunStub: passthrough,
    });
    const guarded: CanonicalNodeDef = withDryRunGuard(canonical, passthrough);

    expect(guarded.definition).toBe(canonical.definition);
  });

  it("preserves plain structural NodeDef literals and execution", async () => {
    const probe: NodeDef = {
      type: "probe" as never,
      label: "Probe",
      group: "Logic",
      costBearing: false,
      paramsSchema: z.unknown(),
      inputs: ["in"],
      outputs: ["result"],
      executor: passthrough,
    };

    const result = await probe.executor(makeCtx(), {}, { in: "value" });

    expect(result).toEqual({
      ok: true,
      outputs: { result: { in: "value" } },
      costUsdc: 0,
    });
  });
});
