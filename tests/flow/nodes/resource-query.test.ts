import { describe, expect, it, vi } from "vitest";
import { getNodeDefinition } from "@/lib/flow/node-definitions";
import {
  createResourceQueryExecutor,
  RESOURCE_QUERY_NODE_REFUSAL,
  resourceQueryNode,
} from "@/lib/flow/nodes/resources/query";
import { resourcePackSemanticHash } from "@/lib/resources/pack-hash";
import { resourcePack } from "../../resources/fixture";
import { makeCtx } from "../../_helpers";
import { buildRunContext } from "@/lib/run-context";
import { buildGatewayRunContext } from "@/lib/gateway/run-context";
import { loadGatewayNode } from "@/lib/gateway/node-loader";
import { RunLogger } from "@/lib/log";

const content = resourcePack();
const contentHash = resourcePackSemanticHash(content).semanticHash;
const bundle = Object.freeze({
  resourceProductId: "resource-1",
  packVersionId: "pack-1",
  semanticHash: contentHash,
  freshness: "fresh" as const,
  content,
});
const params = Object.freeze({
  resourceProductId: "resource-1",
  packVersionId: "pack-1",
  resourcePackContentHash: contentHash,
  filterFields: ["tier"],
  returnFields: ["name", "tier"],
  limit: 5,
});

describe("resource.query node", () => {
  it("publishes one typed, read-only, free, native, safely retryable definition", () => {
    const definition = getNodeDefinition("resource.query");

    expect(resourceQueryNode.definition).toBe(definition);
    expect(definition.inputPorts).toEqual([{
      id: "filters",
      label: "Filters",
      schema: { type: "object" },
      required: true,
      cardinality: "one",
    }]);
    expect(definition.outputPorts.map(({ id, schema }) => ({ id, schema }))).toEqual([
      { id: "result", schema: { type: "array", items: { type: "object" } } },
      {
        id: "resourceReceipt",
        schema: {
          type: "object",
          required: [
            "resourceProductId",
            "resourceVersion",
            "semanticHash",
            "freshness",
            "evidence",
            "unknowns",
            "conflicts",
            "outputSchemaValid",
          ],
          properties: {
            resourceProductId: { type: "string" },
            resourceVersion: { type: "string" },
            semanticHash: { type: "string" },
            freshness: { enum: ["fresh", "stale", "mixed"] },
            evidence: { type: "array", items: { type: "object" } },
            unknowns: { type: "array", items: { type: "string" } },
            conflicts: { type: "array", items: { type: "string" } },
            outputSchemaValid: { type: "boolean" },
          },
        },
      },
    ]);
    expect(definition.effects).toEqual(["read"]);
    expect(definition.cost).toEqual({ kind: "free" });
    expect(definition.testMode).toBe("native");
    expect(definition.retry).toBe("safe");
    expect(resourceQueryNode.costBearing).toBe(false);
    expect(resourceQueryNode.sideEffecting).toBe(false);
    expect(resourceQueryNode.priceUsdc).toBeUndefined();
  });

  it("resolves one exact approved pack and returns only strict query output plus its safe receipt", async () => {
    const resolveResourcePack = vi.fn(async () => ({ status: "approved" as const, bundle }));
    const result = await resourceQueryNode.executor(
      makeCtx({ dryRun: true, resolveResourcePack }),
      params,
      { filters: { tier: "paid" } },
    );

    expect(resolveResourcePack).toHaveBeenCalledWith({
      resourceProductId: "resource-1",
      packVersionId: "pack-1",
      contentHash,
    });
    expect(result).toMatchObject({
      ok: true,
      costUsdc: 0,
      outputs: {
        result: [{ name: "Alpha", tier: "paid" }],
        resourceReceipt: {
          resourceProductId: "resource-1",
          resourceVersion: "pack-1",
          semanticHash: contentHash,
          freshness: "fresh",
          outputSchemaValid: true,
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/recordSchema|jobContract|sourceSnapshotIds|records|content/);
  });

  it("fails closed with one fixed refusal for the kill switch, non-live status, and exact-reference drift", async () => {
    const disabled = createResourceQueryExecutor(false);
    await expect(disabled(makeCtx(), params, { filters: { tier: "paid" } }))
      .resolves.toEqual({ ok: false, error: RESOURCE_QUERY_NODE_REFUSAL, costUsdc: 0 });

    for (const resolved of [
      null,
      { status: "candidate" as const, bundle },
      { status: "approved" as const, bundle: { ...bundle, resourceProductId: "foreign" } },
      { status: "live" as const, bundle: { ...bundle, packVersionId: "other" } },
      { status: "live" as const, bundle: { ...bundle, semanticHash: "f".repeat(64) } },
      { status: "live" as const, bundle: { ...bundle, freshness: "stale" as const } },
      { status: "approved" as const, bundle: { ...bundle, freshness: "mixed" as const } },
    ]) {
      const executor = createResourceQueryExecutor(true);
      const result = await executor(
        makeCtx({ resolveResourcePack: async () => resolved as never }),
        params,
        { filters: { tier: "paid" } },
      );
      expect(result).toEqual({ ok: false, error: RESOURCE_QUERY_NODE_REFUSAL, costUsdc: 0 });
    }
  });

  it("accepts only pinned graph params and never accepts corpus or source bodies", async () => {
    const exactKeys = [
      "filterFields",
      "limit",
      "packVersionId",
      "resourcePackContentHash",
      "resourceProductId",
      "returnFields",
    ];
    expect(Object.keys(resourceQueryNode.paramsSchema.parse(params)).sort()).toEqual(exactKeys);
    for (const privateKey of ["filters", "records", "content", "sourceBody", "corpus"]) {
      expect(() => resourceQueryNode.paramsSchema.parse({ ...params, [privateKey]: "CANARY" }))
        .toThrow();
    }
  });

  it("keeps the owner-scoped resolver mandatory in both real execution contexts", async () => {
    const normal = buildRunContext({ runId: "resource-normal", logger: new RunLogger(), ownerId: null });
    const gateway = buildGatewayRunContext("owner-resource", "resource-gateway", resourceQueryNode);
    expect(normal.resolveResourcePack).toBeTypeOf("function");
    expect(gateway.resolveResourcePack).toBeTypeOf("function");
    await expect(normal.resolveResourcePack({
      resourceProductId: "resource-1",
      packVersionId: "pack-1",
      contentHash,
    })).resolves.toBeNull();
    await expect(loadGatewayNode("resource.query")).resolves.toBe(resourceQueryNode);
  });
});
