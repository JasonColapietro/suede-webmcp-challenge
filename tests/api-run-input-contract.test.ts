/**
 * Published-input-contract enforcement for the paid run route.
 *
 * The contract a caller sees (catalog/MCP inputSchema, via deriveInputSchema)
 * and the input the run route accepts must be the same thing: a malformed
 * PAID call must 400 before verifyAndSettle can charge it, instead of
 * charging and then running the flow against input it never advertised.
 *
 * The decision logic (triggerInputContractViolations) is unit-tested here;
 * the wired ordering inside the route handler is pinned by a source contract
 * below, because this repo's convention is to not import route handlers into
 * vitest (they pull server-only deps the runner can't resolve).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { deriveInputSchema } from "@/lib/flow/input-contract";
import { runModeResponseFields, triggerInputContractViolations } from "@/lib/run-service";

function inputGraph(fields: Record<string, unknown> | undefined): {
  nodes: { type: string; params?: Record<string, unknown> }[];
} {
  return {
    nodes: [
      { type: "input", params: fields === undefined ? {} : { fields } },
      { type: "output", params: {} },
    ],
  };
}

describe("triggerInputContractViolations — typed published fields", () => {
  const schema = deriveInputSchema(inputGraph({ topic: "", limit: 3, deep: false }));

  it("accepts input matching the published types", () => {
    expect(
      triggerInputContractViolations(schema, { topic: "solar", limit: 10, deep: true }),
    ).toEqual([]);
  });

  it("accepts a partial payload — every declared field has a default", () => {
    expect(triggerInputContractViolations(schema, {})).toEqual([]);
    expect(triggerInputContractViolations(schema, { topic: "solar" })).toEqual([]);
  });

  it("rejects a typed field carrying the wrong JSON type", () => {
    const violations = triggerInputContractViolations(schema, { topic: 123 });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('"topic"');
    expect(violations[0]).toContain("string");
  });

  it("rejects null for a typed field", () => {
    const violations = triggerInputContractViolations(schema, { limit: null });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("null");
  });

  it("allows extra keys when the schema is not explicitly closed", () => {
    // deriveInputSchema publishes named properties without
    // additionalProperties: false, so unknown keys pass through.
    expect(triggerInputContractViolations(schema, { extra: "ok" })).toEqual([]);
  });
});

describe("triggerInputContractViolations — closed and open contracts", () => {
  it("rejects any field when the published contract is explicitly closed", () => {
    // An authored empty fields object means "this agent takes no arguments".
    const schema = deriveInputSchema(inputGraph({}));
    expect(schema.additionalProperties).toBe(false);
    const violations = triggerInputContractViolations(schema, { surprise: 1 });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('"surprise"');
  });

  it("rejects fields for a graph with no forwarding trigger at all", () => {
    const schema = deriveInputSchema({ nodes: [{ type: "output", params: {} }] });
    expect(triggerInputContractViolations(schema, { anything: true })).toHaveLength(1);
  });

  it("accepts anything under the honest-fallback open contract (fields omitted)", () => {
    const schema = deriveInputSchema(inputGraph(undefined));
    expect(triggerInputContractViolations(schema, { free: "form", n: 1 })).toEqual([]);
  });
});

describe("triggerInputContractViolations — explicit curated constraints", () => {
  it("enforces required, minLength, enum, integer, and minimum", () => {
    const schema = {
      type: "object" as const,
      additionalProperties: false,
      required: ["name", "decision", "count"],
      properties: {
        name: { type: "string", minLength: 3 },
        decision: { type: "string", enum: ["approve", "hold"] },
        count: { type: "integer", minimum: 0 },
      },
    };
    expect(triggerInputContractViolations(schema, {})).toHaveLength(3);
    expect(triggerInputContractViolations(schema, {
      name: "x",
      decision: "reject",
      count: -1.5,
    })).toEqual(expect.arrayContaining([
      'field "name" must be at least 3 characters',
      'field "decision" must be one of the declared values',
      'field "count" must be integer, got number',
    ]));
  });
});

describe("runModeResponseFields — machine-readable dry-run marker", () => {
  it("marks a dry-run response with mode: dry-run", () => {
    expect(runModeResponseFields(true)).toEqual({ mode: "dry-run" });
  });

  it("adds nothing to a settled/live response", () => {
    expect(runModeResponseFields(false)).toEqual({});
    expect({ settled: true, ...runModeResponseFields(false) }).toEqual({ settled: true });
  });
});

describe("run route source contract — validate before charging, mark dry-runs", () => {
  const source = readFileSync(
    new URL("../src/app/api/agents/[agent]/run/route.ts", import.meta.url),
    "utf8",
  );

  it("validates trigger input BEFORE verifyAndSettle so malformed paid calls never charge", () => {
    const validateAt = source.indexOf("triggerInputContractViolations(");
    const settleAt = source.indexOf("verifyAndSettle(");
    expect(validateAt).toBeGreaterThan(-1);
    expect(settleAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(settleAt);
    expect(source).toContain('{ status: 400 }');
  });

  it("derives the contract from the same published schema the catalog exposes", () => {
    expect(source).toContain("deriveInputSchema(preparedGraph)");
    expect(source).not.toContain("deriveInputSchema(flow.graph)");
  });

  it("spreads the additive dry-run mode marker into the run response", () => {
    expect(source).toContain("...runModeResponseFields(dryRun)");
  });
});
