import { describe, expect, it } from "vitest";
import { isIP } from "node:net";
import { generateSchemaSentinel, parseConnectorSchemaV1 } from "@/lib/connectors/sentinel";

function validFormat(format: string, value: string): boolean {
  if (format === "date-time") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) && !Number.isNaN(Date.parse(value));
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (format === "time") return /^\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value);
  if (format === "email") {
    const [local, host, extra] = value.split("@");
    return extra === undefined && Boolean(local) && local!.length <= 64 && value.length <= 254 && validFormat("hostname", host ?? "");
  }
  if (format === "hostname") {
    return value.length >= 1 && value.length <= 253 && value.split(".").every((label) =>
      label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label));
  }
  if (format === "ipv4") return isIP(value) === 4;
  if (format === "ipv6") return isIP(value) === 6;
  if (format === "uri") { try { return new URL(value).href.length > 0; } catch { return false; } }
  if (format === "uuid") return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
  return false;
}

describe("connector schema sentinel", () => {
  it("generates deterministic values for required nested fields, bounded arrays, and nullable types", () => {
    const schema = {
      type: "object",
      properties: {
        requiredText: { type: "string", minLength: 3, maxLength: 5 },
        optionalText: { type: "string" },
        rows: {
          type: "array",
          minItems: 2,
          maxItems: 3,
          items: {
            type: "object",
            properties: { value: { type: ["integer", "null"], minimum: 4, maximum: 8 } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
      required: ["requiredText", "rows"],
      additionalProperties: false,
    };
    const parsed = parseConnectorSchemaV1(schema);
    expect(generateSchemaSentinel(parsed)).toEqual({
      requiredText: "xxx",
      rows: [{ value: 4 }, { value: 4 }],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(generateSchemaSentinel(parsed))).toBe(true);
  });

  it.each([
    ["date-time", "2000-01-01T00:00:00Z"],
    ["date", "2000-01-01"],
    ["time", "00:00:00Z"],
    ["email", "sentinel@example.invalid"],
    ["hostname", "sentinel.invalid"],
    ["ipv4", "192.0.2.1"],
    ["ipv6", "2001:db8::1"],
    ["uri", "https://example.invalid/"],
    ["uuid", "00000000-0000-4000-8000-000000000000"],
  ])("uses a trusted %s sentinel", (format, expected) => {
    expect(generateSchemaSentinel({ type: "string", format })).toBe(expected);
  });

  it.each([
    ["date-time", [[20, 20], ...Array.from({ length: 107 }, (_, index) => [22 + index, 22 + index])]],
    ["date", [[0, 10], [10, 10]]],
    ["time", [[9, 9], ...Array.from({ length: 118 }, (_, index) => [11 + index, 11 + index])]],
    ["email", Array.from({ length: 252 }, (_, index) => [3 + index, 3 + index])],
    ["hostname", Array.from({ length: 253 }, (_, index) => [1 + index, 1 + index])],
    ["ipv4", Array.from({ length: 9 }, (_, index) => [7 + index, 7 + index])],
    ["ipv6", Array.from({ length: 38 }, (_, index) => [2 + index, 2 + index])],
    ["uri", Array.from({ length: 255 }, (_, index) => [2 + index, 2 + index])],
    ["uuid", [[36, 36]]],
  ] as const)("generates a format-valid %s value for every satisfiable tested interval", (format, intervals) => {
    for (const [minLength, maxLength] of intervals) {
      const value = generateSchemaSentinel({ type: "string", format, minLength, maxLength });
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThanOrEqual(minLength);
      expect((value as string).length).toBeLessThanOrEqual(maxLength);
      expect(validFormat(format, value as string)).toBe(true);
      expect(generateSchemaSentinel({ type: "string", format, minLength, maxLength })).toBe(value);
    }
  });

  it.each([
    ["date-time", 21, 21], ["date", 0, 9], ["date", 11, 20],
    ["time", 10, 10], ["email", 0, 2], ["email", 255, 300],
    ["hostname", 254, 300], ["ipv4", 0, 6], ["ipv4", 16, 20],
    ["ipv6", 0, 1], ["ipv6", 40, 50], ["uuid", 0, 35], ["uuid", 37, 50],
  ])("refuses an unsatisfiable %s interval", (format, minLength, maxLength) => {
    expect(() => generateSchemaSentinel({ type: "string", format, minLength, maxLength })).toThrow("SCHEMA_UNSATISFIABLE");
  });

  it("chooses deterministic numbers inside satisfiable intervals", () => {
    expect(generateSchemaSentinel({ type: "number", minimum: -5, maximum: -2 })).toBe(-2);
    expect(generateSchemaSentinel({ type: "integer", minimum: 1.2, maximum: 4.8 })).toBe(2);
    expect(generateSchemaSentinel({ type: "boolean" })).toBe(false);
    expect(generateSchemaSentinel({ type: "null" })).toBeNull();
  });

  it.each([
    [{ type: "object", properties: {}, required: [] }, "additionalProperties"],
    [{ type: "object", properties: {}, required: ["missing"], additionalProperties: false }, "SCHEMA_UNSATISFIABLE"],
    [{ type: "string", minLength: 3, maxLength: 2 }, "SCHEMA_UNSATISFIABLE"],
    [{ type: "array", minItems: 2, maxItems: 1, items: { type: "string" } }, "SCHEMA_UNSATISFIABLE"],
    [{ type: "integer", minimum: 1.2, maximum: 1.8 }, "SCHEMA_UNSATISFIABLE"],
    [{ type: "string", pattern: "secret" }, "Invalid connector schema"],
    [{ type: "string", format: "regex" }, "Invalid connector schema"],
    [{ type: ["string", "number"] }, "Invalid connector schema"],
    [{ type: "object", properties: { fixture: { type: "string" } }, required: [], additionalProperties: false, fixture: "CANARY" }, "Invalid connector schema"],
  ])("refuses unsupported or impossible schema %#", (schema, message) => {
    expect(() => generateSchemaSentinel(schema)).toThrow(message);
  });

  it("refuses excessive schema depth and output size without evaluating getters", () => {
    let nested: unknown = { type: "string" };
    for (let index = 0; index < 33; index += 1) {
      nested = { type: "array", items: nested, minItems: 1, maxItems: 1 };
    }
    expect(() => generateSchemaSentinel(nested)).toThrow(/schema depth/i);
    expect(() => generateSchemaSentinel({ type: "string", minLength: 300_000 })).toThrow(/SCHEMA_UNSATISFIABLE/);

    let calls = 0;
    const hostile = Object.defineProperty({}, "type", { enumerable: true, get() { calls += 1; return "string"; } });
    expect(() => generateSchemaSentinel(hostile)).toThrow(/Invalid connector schema/);
    expect(calls).toBe(0);
  });
});
