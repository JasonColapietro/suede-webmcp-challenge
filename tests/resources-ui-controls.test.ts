import { describe, expect, it } from "vitest";
import { buildTypedResourceBrief } from "@/components/resources/ResourceCreateForm";
import { parseResourceJsonRows } from "@/components/resources/ResourceSourcesPanel";
import { CreateResourceRequestSchema } from "@/lib/resources/service";

describe("Resource Foundry no-code controls", () => {
  it("persists typed fields, filters, returns, taxonomy, and the Job Contract", () => {
    const brief = buildTypedResourceBrief({
      jobStatement: "Return one reviewed price.",
      buyerIntent: "Compare a price without rereading the source.",
      fields: "name:string, price:number, active:boolean",
      filterFields: "name, active",
      returnFields: "name, price",
      taxonomy: "priority, enterprise",
    });
    const parsed = CreateResourceRequestSchema.parse({
      name: "Pricing", slug: "pricing", executionAccess: "paid", discoveryAccess: "public", brief,
    });
    expect(parsed).toMatchObject({
      executionAccess: "paid", discoveryAccess: "public",
      brief: {
        filterFields: ["name", "active"], returnFields: ["name", "price"],
        taxonomy: [{ id: "priority", label: "priority" }, { id: "enterprise", label: "enterprise" }],
      },
    });
    expect(parsed.brief.recordSchema).toMatchObject({
      properties: { name: { type: "string" }, price: { type: "number" }, active: { type: "boolean" } },
    });
  });

  it("parses bounded JSON-row intake and rejects non-row input", () => {
    expect(parseResourceJsonRows('[{"name":"Alpha","price":2}]')).toEqual([{ name: "Alpha", price: 2 }]);
    expect(() => parseResourceJsonRows('{"name":"Alpha"}')).toThrow(/non-empty array/u);
    expect(() => parseResourceJsonRows('["Alpha"]')).toThrow(/non-empty array/u);
  });
});
