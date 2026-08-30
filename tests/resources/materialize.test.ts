import { describe, expect, it } from "vitest";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { canonicalResourceAgentSlug, materializeResourceGraph } from "@/lib/resources/materialize";
import { resourcePack } from "./fixture";

const PRODUCT = {
  id: "resource-product-1",
  ownerId: "owner-a",
  name: "Pricing signals",
  slug: "pricing-signals",
  status: "test" as const,
  executionAccess: "paid" as const,
  discoveryAccess: "public" as const,
};

const PACK = {
  resourceProductId: PRODUCT.id,
  packVersionId: "pack-version-1",
  semanticHash: "a".repeat(64),
  freshness: "fresh" as const,
  content: resourcePack(),
};

describe("materializeResourceGraph", () => {
  it("preserves the product identity suffix at the maximum slug length", () => {
    const slug = "a".repeat(160);
    const first = canonicalResourceAgentSlug({ id: "resource-product-1", slug });
    const second = canonicalResourceAgentSlug({ id: "resource-product-2", slug });

    expect(first).toHaveLength(160);
    expect(second).toHaveLength(160);
    expect(first).not.toBe(second);
    expect(first).toMatch(/-[a-f0-9]{10}$/u);
    expect(second).toMatch(/-[a-f0-9]{10}$/u);
  });

  it("builds one stable typed Input -> resource.query -> Output graph and repeatable semantic identity", () => {
    const existingMeta = {
      canvas: { x: 12, y: 18, zoom: 0.8, privateSource: "NEVER-PUBLISH-CANVAS" },
      viewport: { x: 1, y: 2, zoom: 1.1, provenance: "NEVER-PUBLISH-VIEWPORT" },
      description: "NEVER-PUBLISH-DESCRIPTION",
      comments: { text: "NEVER-PUBLISH-COMMENT", sourceBody: "NEVER-PUBLISH-NESTED-BODY" },
      createdBy: { name: "NEVER-PUBLISH-CREATOR", privateRecord: "NEVER-PUBLISH-PRIVATE-RECORD" },
      template: { id: "NEVER-PUBLISH-TEMPLATE", provenanceNote: "NEVER-PUBLISH-NESTED-PROVENANCE" },
      display: { accent: "violet", source: { body: "NEVER-PUBLISH-DISPLAY" } },
      privateSourceBody: "NEVER-PUBLISH-BODY",
      provenanceNote: "NEVER-PUBLISH-PROVENANCE",
    };
    const sourceDisclosure = { sourceCount: 1, sourceKinds: ["manual"] } as const;
    const first = materializeResourceGraph({ product: PRODUCT, pack: PACK, sourceDisclosure, existingMeta });
    const second = materializeResourceGraph({ product: PRODUCT, pack: PACK, sourceDisclosure, existingMeta });

    expect(first).toEqual(second);
    expect(first.semanticHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.fullHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.graph.nodes.map((node) => node.id)).toEqual([
      "resource-input", "resource-query", "resource-output",
    ]);
    expect(first.graph.edges.map((edge) => edge.id)).toEqual([
      "resource-input-query", "resource-query-output",
    ]);
    expect(first.graph.nodes[1]).toMatchObject({
      type: "resource.query",
      params: {
        resourceProductId: PRODUCT.id,
        packVersionId: PACK.packVersionId,
        resourcePackContentHash: PACK.semanticHash,
        filterFields: ["tier"],
        returnFields: ["name", "tier"],
      },
    });
    expect(first.graph.callableInterface?.inputs[0]?.schema).toEqual(PACK.content.jobContract.inputSchema);
    expect(first.graph.callableInterface?.outputs.map((port) => port.id)).toEqual(["result", "resourceReceipt"]);
    expect(first.graph.callableInterface?.outputs[0]?.schema).toEqual(PACK.content.jobContract.outputSchema);
    expect(parseSupportedFlowGraph(first.graph)).toEqual(first.graph);

    expect(first.graph.meta).toMatchObject({
      description: PACK.content.jobContract.jobStatement,
      canvas: { x: 12, y: 18, zoom: 0.8 },
      viewport: { x: 1, y: 2, zoom: 1.1 },
      display: { accent: "violet" },
      resourceProduct: {
        id: PRODUCT.id,
        packVersionId: PACK.packVersionId,
        semanticHash: PACK.semanticHash,
        filterFields: ["tier"],
        returnFields: ["name", "tier"],
        sourceDisclosure: {
          corpus: "private",
          sourceCount: 1,
          sourceKinds: ["manual"],
          freshness: "fresh",
        },
      },
    });
    const serialized = JSON.stringify(first.graph);
    expect(serialized).not.toContain("NEVER-PUBLISH");
    expect(serialized).not.toContain("record-1");
    expect(serialized).not.toContain("snapshot-contract");
    expect(serialized).not.toContain("manual://");
  });
});
