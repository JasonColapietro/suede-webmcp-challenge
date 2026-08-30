import { describe, expect, it } from "vitest";
import { NODE_DEFINITIONS, getNodeDefinition } from "@/lib/flow/node-definitions";
import type { JsonSchema } from "@/lib/flow/node-definition-types";

function isJsonSafe(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonSafe);
  if (typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>)
    .every(([key, child]) => key.length > 0 && isJsonSafe(child));
}

function expectMeaningful(schema: JsonSchema): void {
  expect(Object.keys(schema).length).toBeGreaterThan(0);
}

describe("canonical node port schemas", () => {
  it("enumerates unique IDs per direction and JSON-safe schemas", () => {
    for (const definition of NODE_DEFINITIONS) {
      for (const ports of [definition.inputPorts, definition.outputPorts]) {
        expect(new Set(ports.map((port) => port.id)).size, definition.type).toBe(ports.length);
        for (const port of ports) expect(isJsonSafe(port.schema), `${definition.type}.${port.id}`).toBe(true);
      }
    }
  });

  it("types stable built-in data paths without inventing provider payloads", () => {
    for (const type of ["input", "output", "llm", "http", "branch", "transform", "webhook"] as const) {
      const definition = getNodeDefinition(type);
      for (const port of [...definition.inputPorts, ...definition.outputPorts]) {
        expectMeaningful(port.schema);
      }
    }
    const loop = getNodeDefinition("loop");
    expect(loop.inputPorts[0]?.schema).toEqual({});
    for (const port of loop.outputPorts) expectMeaningful(port.schema);
    expect(getNodeDefinition("suede.styleCoach").outputPorts[0]?.schema).toEqual({});
    expect(getNodeDefinition("suede.lyrics").inputPorts[0]?.schema).toEqual({});
  });
});
