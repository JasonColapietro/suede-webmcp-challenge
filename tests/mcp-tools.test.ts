/**
 * Tool projection for the MCP endpoint (src/lib/mcp/tools.ts) and the input
 * contract it derives from a flow graph (src/lib/flow/input-contract.ts).
 *
 * Pure functions only — no database, no engine.
 */
import { describe, it, expect } from "vitest";
import { deriveInputSchema } from "@/lib/flow/input-contract";
import type { JsonObjectSchema } from "@/lib/flow/input-contract";
import { catalogEntryToTool, mcpEligibility, toolNameForSlug } from "@/lib/mcp/tools";
import type { CatalogEntry } from "@/lib/catalog";
import { RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";

function graph(nodes: Array<{ type: string; params?: Record<string, unknown> }>) {
  return {
    nodes: nodes.map((node, i) => ({
      id: `n${i}`,
      type: node.type,
      params: node.params ?? {},
    })),
    edges: [],
  };
}

describe("deriveInputSchema", () => {
  it("turns the input node's default fields into typed schema properties", () => {
    const schema = deriveInputSchema(
      graph([{ type: "input", params: { fields: { topic: "", count: 3, live: true } } }]),
    );
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        topic: { type: "string" },
        count: { type: "number" },
        live: { type: "boolean" },
      },
    });
  });

  it("marks no field as required, since every field has a default", () => {
    const schema = deriveInputSchema(
      graph([{ type: "input", params: { fields: { topic: "" } } }]),
    );
    expect(schema.required).toBeUndefined();
  });

  it("accepts only an empty object when the flow has no forwarding trigger", () => {
    // With no trigger node that forwards its payload, nothing in the graph
    // reads trigger input, so advertising free-form properties would invite
    // the model to send data that is dropped.
    const schema = deriveInputSchema(graph([{ type: "llm" }, { type: "output" }]));
    expect(schema).toEqual({ type: "object", additionalProperties: false });
  });

  // schedule and webhook forward the run's trigger payload exactly as input
  // does, so a scheduled or webhook-triggered agent reached over MCP accepts
  // arguments too. Claiming additionalProperties:false for them would tell a
  // calling model to send nothing to a prompt that interpolates {{in}}.
  it.each(["schedule", "webhook"] as const)(
    "treats a %s node as a trigger that accepts arguments",
    (type) => {
      const schema = deriveInputSchema(
        graph([{ type, params: { fields: { topic: "", count: 3 } } }]),
      );
      expect(schema).toMatchObject({
        type: "object",
        properties: { topic: { type: "string" }, count: { type: "number" } },
      });
      expect(schema.additionalProperties).toBeUndefined();
    },
  );

  it.each(["schedule", "webhook"] as const)(
    "accepts any object when a %s node declares no default fields",
    (type) => {
      expect(deriveInputSchema(graph([{ type }]))).toEqual({ type: "object" });
    },
  );

  // "we cannot name this agent's arguments" and "this agent takes no
  // arguments" are different claims. An omitted `fields` is the first; an
  // explicit empty `fields: {}` is the second, and closes the schema so a
  // calling model does not send data a param-driven graph would drop.
  it.each(["input", "schedule", "webhook"] as const)(
    "closes the schema when a %s node authors an explicit empty fields object",
    (type) => {
      expect(deriveInputSchema(graph([{ type, params: { fields: {} } }]))).toEqual({
        type: "object",
        additionalProperties: false,
      });
    },
  );

  it("stays open when one trigger claims empty but another never authored fields", () => {
    // The unauthored trigger may still carry arguments we cannot see, so the
    // empty claim from its sibling is not enough to close the whole schema.
    const schema = deriveInputSchema(
      graph([{ type: "input", params: { fields: {} } }, { type: "schedule" }]),
    );
    expect(schema).toEqual({ type: "object" });
  });

  it("merges fields across mixed trigger types", () => {
    const schema = deriveInputSchema(
      graph([
        { type: "input", params: { fields: { a: "" } } },
        { type: "schedule", params: { fields: { b: 1 } } },
      ]),
    );
    expect(Object.keys((schema.properties ?? {}) as object).sort()).toEqual(["a", "b"]);
  });

  it("accepts any object when the input node declares no default fields", () => {
    const schema = deriveInputSchema(graph([{ type: "input" }]));
    expect(schema).toEqual({ type: "object" });
  });

  it("merges the fields of every input node in the graph", () => {
    const schema = deriveInputSchema(
      graph([
        { type: "input", params: { fields: { a: "" } } },
        { type: "input", params: { fields: { b: 1 } } },
      ]),
    );
    expect(Object.keys((schema.properties ?? {}) as object).sort()).toEqual(["a", "b"]);
  });

  it("falls back to an untyped property when a default value is null", () => {
    const schema = deriveInputSchema(
      graph([{ type: "input", params: { fields: { maybe: null } } }]),
    );
    expect((schema.properties as Record<string, unknown>).maybe).toEqual({});
  });

  it("ignores a fields value that is not a JSON object", () => {
    const schema = deriveInputSchema(
      graph([{ type: "input", params: { fields: "not-an-object" } }]),
    );
    expect(schema).toEqual({ type: "object" });
  });
});

describe("toolNameForSlug", () => {
  it("prefixes the slug so the tool reads as an action", () => {
    expect(toolNameForSlug("lead-scorer")).toBe("run_lead-scorer");
  });

  it("replaces characters outside the MCP tool-name set", () => {
    expect(toolNameForSlug("lead scorer!v2")).toBe("run_lead_scorer_v2");
  });

  it("truncates to the 128-character tool-name ceiling", () => {
    expect(toolNameForSlug("a".repeat(200))).toHaveLength(128);
  });
});

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return Object.assign({
    id: "agent-1",
    slug: "lead-scorer",
    name: "Lead Scorer",
    summary: "Input › LLM › Output",
    description: "Scores an inbound lead against your ICP.",
    priceUsdc: 0.25,
    calls: 12,
    settledCalls: 0,
    lastCallAt: null,
    createdAt: 0,
    settlementLive: true,
    acceptsPayment: true,
    paymentState: "payment-enabled" as const,
    previewAvailable: true,
    payTo: "0xabc",
    schedule: null,
    inputSchema: { type: "object", properties: { lead: { type: "string" } } },
    publishedLive: true,
    urls: {
      public: "/a/lead-scorer",
      run: "/api/agents/agent-1/run",
      x402: "/api/agents/lead-scorer/.well-known/x402",
      agentCard: "/api/agents/lead-scorer/.well-known/agent-card",
      a2a: "/api/agents/lead-scorer/a2a",
    },
  }, overrides);
}

describe("catalogEntryToTool", () => {
  it("names the tool from the slug and titles it from the flow name", () => {
    const tool = catalogEntryToTool(entry());
    expect(tool.name).toBe("run_lead-scorer");
    expect(tool.title).toBe("Lead Scorer");
  });

  it("states the per-call price in the description so the model sees the cost", () => {
    const tool = catalogEntryToTool(entry());
    expect(tool.description).toContain("0.25");
    expect(tool.description).toContain("USDC");
  });

  it("says a zero-price agent is free rather than printing 0 USDC", () => {
    const tool = catalogEntryToTool(entry({ priceUsdc: 0 }));
    expect(tool.description).toContain("Free");
    expect(tool.description).not.toContain("0 USDC");
  });

  it("prefers the creator's pitch over the derived node chain", () => {
    const tool = catalogEntryToTool(entry());
    expect(tool.description).toContain("Scores an inbound lead against your ICP.");
  });

  it("falls back to the node-chain summary when there is no creator pitch", () => {
    const tool = catalogEntryToTool(entry({ description: null }));
    expect(tool.description).toContain("Input › LLM › Output");
  });

  it("carries the derived input schema through to the tool", () => {
    const tool = catalogEntryToTool(entry());
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: { lead: { type: "string" } },
    });
  });

  it("publishes a structured result contract and safe execution annotations", () => {
    const tool = catalogEntryToTool(entry({
      outputSchema: {
        type: "object",
        properties: { score: { type: "number" } },
      },
    }));
    expect(tool.outputSchema).toMatchObject({
      required: ["runId", "outputs", "chargedUsdc"],
      properties: { result: { properties: { score: { type: "number" } } } },
    });
    expect(tool.annotations).toEqual({
      title: "Lead Scorer",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("projects the registered resource contract into namespaced MCP metadata only", () => {
    const resourceContract = {
      extensionUri: RESOURCE_CONTRACT_EXTENSION_URI,
      resourceProductId: "resource-product-1",
      resourceVersion: "pack-version-1",
      semanticHash: "a".repeat(64),
    };
    expect(catalogEntryToTool(entry({
      extensions: { [RESOURCE_CONTRACT_EXTENSION_URI]: resourceContract },
    }))._meta).toEqual({ [RESOURCE_CONTRACT_EXTENSION_URI]: resourceContract });
    expect(catalogEntryToTool(entry())._meta).toBeUndefined();
  });

  it("advertises the strict shared ResourceRunEnvelope for resource tools only", () => {
    const outputSchema = {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string" } },
      },
    } as unknown as JsonObjectSchema;
    const ordinary = catalogEntryToTool(entry({ outputSchema }));
    const resource = catalogEntryToTool(entry({
      outputSchema,
      extensions: {
        [RESOURCE_CONTRACT_EXTENSION_URI]: {
          extensionUri: RESOURCE_CONTRACT_EXTENSION_URI,
          resourceProductId: "resource-product-1",
          resourceVersion: "pack-version-1",
          semanticHash: "a".repeat(64),
        },
      },
    }));

    expect(ordinary.outputSchema).toMatchObject({
      required: ["runId", "outputs", "chargedUsdc"],
      properties: { chargedUsdc: { type: "number" } },
    });
    expect(resource.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["result", "resourceReceipt", "payment"],
      properties: {
        result: outputSchema,
        resourceReceipt: {
          type: "object",
          additionalProperties: false,
          required: [
            "resourceProductId", "resourceVersion", "semanticHash", "freshness",
            "evidence", "unknowns", "conflicts", "outputSchemaValid",
          ],
        },
        payment: {
          type: "object",
          additionalProperties: false,
          required: ["priceUsdc", "state", "receiptId"],
          properties: {
            state: { enum: ["free", "challenged", "credited", "settled", "refunded", "failed"] },
          },
        },
      },
    });
  });
});

describe("mcpEligibility", () => {
  it("admits an ordinary agent with a live published deployment", () => {
    expect(
      mcpEligibility({
        isCompanyEmployee: false,
        hasRelay: false,
        hasPublishedDeployment: true,
      }),
    ).toEqual({ eligible: true });
  });

  it("excludes an agent with no published live deployment, which cannot serve a paid call", () => {
    // buildCatalog falls back to the draft graph for listing, but a paid run
    // resolves the immutable published version. Without one there is nothing
    // to charge for, so the tool must not be advertised at all.
    const verdict = mcpEligibility({
      isCompanyEmployee: false,
      hasRelay: false,
      hasPublishedDeployment: false,
    });
    if (verdict.eligible) throw new Error("expected an unpublished agent to be excluded");
    expect(verdict.reason).toContain("published");
  });

  it("excludes a company employee, whose budget and approval gates live on the x402 route", () => {
    const verdict = mcpEligibility({ isCompanyEmployee: true, hasRelay: false, hasPublishedDeployment: true });
    if (verdict.eligible) throw new Error("expected a company employee to be excluded");
    expect(verdict.reason).toContain("company");
  });

  it("excludes a relay-backed agent, which forwards to a creator-hosted process", () => {
    const verdict = mcpEligibility({ isCompanyEmployee: false, hasRelay: true, hasPublishedDeployment: true });
    if (verdict.eligible) throw new Error("expected a relay-backed agent to be excluded");
    expect(verdict.reason).toContain("relay");
  });
})
