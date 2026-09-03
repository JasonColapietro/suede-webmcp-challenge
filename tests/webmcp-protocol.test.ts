/**
 * WebMCP namespace resolution and Chrome's character budgets.
 *
 * Pure functions only — resolveModelContext takes its host as a parameter and
 * never reads a global, so the whole surface runs in the node environment with
 * no browser and no DOM shim.
 */
import { describe, it, expect } from "vitest";
import {
  clampText,
  registerWebMcpTools,
  resolveModelContext,
  WEBMCP_BUDGETS,
  withinBudgets,
} from "@/lib/webmcp/protocol";
import type { WebMcpToolDescriptor } from "@/lib/webmcp/protocol";
import type { JsonObjectSchema } from "@/lib/flow/input-contract";

const context = { registerTool: async (): Promise<void> => {} };

describe("resolveModelContext", () => {
  it("prefers document.modelContext, the Chrome 150+ namespace", () => {
    const documentContext = { registerTool: async (): Promise<void> => {} };
    const resolved = resolveModelContext({
      document: { modelContext: documentContext },
      navigator: { modelContext: context },
    });
    expect(resolved).toBe(documentContext);
  });

  it("falls back to navigator.modelContext for the Chrome 149 origin trial", () => {
    expect(resolveModelContext({ navigator: { modelContext: context } })).toBe(context);
  });

  it("resolves to null when the browser has no WebMCP support", () => {
    expect(resolveModelContext({})).toBeNull();
    expect(resolveModelContext({ document: {}, navigator: {} })).toBeNull();
  });

  it("rejects a namespace without a callable registerTool", () => {
    expect(resolveModelContext({ document: { modelContext: {} } })).toBeNull();
    expect(resolveModelContext({ document: { modelContext: { registerTool: 1 } } })).toBeNull();
    expect(resolveModelContext({ document: { modelContext: null } })).toBeNull();
  });
});

describe("registerWebMcpTools", () => {
  it("registers every descriptor when the browser returns void synchronously", () => {
    const descriptors: readonly WebMcpToolDescriptor[] = [
      "find_services",
      "get_service",
      "preview_service",
      "buy_service",
    ].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      execute: async () => null,
    }));
    const registered: string[] = [];

    registerWebMcpTools(
      {
        registerTool: (descriptor) => {
          registered.push(descriptor.name);
        },
      },
      descriptors,
    );

    expect(registered).toEqual([
      "find_services",
      "get_service",
      "preview_service",
      "buy_service",
    ]);
  });
});

describe("clampText", () => {
  it("collapses whitespace and leaves short text intact", () => {
    expect(clampText("  a   b \n c ", 100)).toBe("a b c");
  });

  it("truncates to the limit including the ellipsis", () => {
    const out = clampText("x".repeat(50), 10);
    expect(out.length).toBe(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never exceeds the limit at the boundary", () => {
    for (const limit of [1, 2, 5, 30, 150, 500]) {
      expect(clampText("y".repeat(1000), limit).length).toBeLessThanOrEqual(limit);
    }
  });
});

describe("WEBMCP_BUDGETS", () => {
  it("matches the limits Chrome enforces by silent truncation", () => {
    expect(WEBMCP_BUDGETS).toEqual({
      toolName: 30,
      toolDescription: 500,
      parameterName: 30,
      parameterDescription: 150,
      toolOutput: 1_500,
    });
  });
});

describe("withinBudgets", () => {
  const schema = (properties: Record<string, Record<string, unknown>>): JsonObjectSchema => ({
    type: "object",
    properties,
  });

  it("accepts a descriptor inside every budget", () => {
    expect(
      withinBudgets({
        name: "find_services",
        description: "Short.",
        inputSchema: schema({ need: { type: "string", description: "A need." } }),
      }),
    ).toBe(true);
  });

  it("rejects an over-budget tool name", () => {
    expect(
      withinBudgets({ name: "n".repeat(31), description: "d", inputSchema: schema({}) }),
    ).toBe(false);
  });

  it("rejects an over-budget description", () => {
    expect(
      withinBudgets({ name: "ok", description: "d".repeat(501), inputSchema: schema({}) }),
    ).toBe(false);
  });

  it("rejects an over-budget parameter description", () => {
    expect(
      withinBudgets({
        name: "ok",
        description: "d",
        inputSchema: schema({ need: { type: "string", description: "p".repeat(151) } }),
      }),
    ).toBe(false);
  });

  it("rejects an over-budget parameter name", () => {
    expect(
      withinBudgets({
        name: "ok",
        description: "d",
        inputSchema: schema({ ["p".repeat(31)]: { type: "string" } }),
      }),
    ).toBe(false);
  });
});
