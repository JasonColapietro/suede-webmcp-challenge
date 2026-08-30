import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NODE_DEFINITIONS,
  NODE_GROUP_ORDER as CATALOG_NODE_GROUP_ORDER,
  NODE_TYPE_SET as CATALOG_NODE_TYPE_SET,
  getNodeDefinition,
} from "@/lib/flow/node-definitions";
import {
  NODE_GROUP_ORDER,
  NODE_META,
  NODE_TYPE_SET,
} from "@/lib/flow/node-meta";

const FLOW_DIR = path.join(process.cwd(), "src/lib/flow");
const ROOT_MODULE = path.join(FLOW_DIR, "node-definitions.ts");
const FORBIDDEN_IMPORT =
  /(?:^|\/)(?:executor|nodes?|registry|llm|rails|wallet|auth|process|server(?:-only)?|providers?|env(?:ironment)?|env-[^/]+)(?:\/|$)|^node:/i;
const ROOT_ALLOWED_RELATIVE_IMPORT = /^\.\/(?:types|node-definition-types)$/;

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^"'\n]+?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveRelativeModule(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Unable to resolve ${specifier} from ${fromFile}`);
}

function relativeImportGraph(root: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = [root];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (graph.has(file)) continue;
    const specifiers = importSpecifiers(fs.readFileSync(file, "utf8"));
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      pending.push(resolveRelativeModule(file, specifier));
    }
  }
  return graph;
}

function expectJsonDescriptor(value: unknown, pathLabel: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    expect(Number.isFinite(value), pathLabel).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      expectJsonDescriptor(child, `${pathLabel}[${index}]`),
    );
    return;
  }
  expect(typeof value, pathLabel).toBe("object");
  expect(Object.getPrototypeOf(value), pathLabel).toBe(Object.prototype);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    expectJsonDescriptor(child, `${pathLabel}.${key}`);
  }
}

describe("client-safe canonical node metadata", () => {
  it("rejects server, provider, and environment imports by path segment", () => {
    const forbiddenByCategory = {
      server: ["./server", "@/lib/server-only"],
      provider: ["../providers/openai", "@/lib/provider"],
      environment: ["./env", "@/config/environment"],
      "env-*": ["../env-loader", "@/lib/env-config"],
    };

    for (const [category, specifiers] of Object.entries(forbiddenByCategory)) {
      for (const specifier of specifiers) {
        expect(specifier, category).toMatch(FORBIDDEN_IMPORT);
      }
    }

    for (const specifier of [
      "./types",
      "./node-definition-types",
      "@/lib/flow/node-definition-types",
    ]) {
      expect(specifier, "allowed catalog import").not.toMatch(FORBIDDEN_IMPORT);
    }
  });

  it("projects the compatibility metadata exactly from canonical definitions", () => {
    expect(NODE_META).toEqual(
      NODE_DEFINITIONS.map((definition) => ({
        type: definition.type,
        label: definition.label,
        group: definition.category,
        ...(definition.cost.kind === "estimated"
          ? { priceUsdc: definition.cost.amount }
          : {}),
        inputs: definition.inputPorts.map((port) => port.id),
        outputs: definition.outputPorts.map((port) => port.id),
        fields: definition.ui.fields,
        ...(definition.prototype ? { prototype: definition.prototype } : {}),
      })),
    );
    expect(NODE_GROUP_ORDER).toBe(CATALOG_NODE_GROUP_ORDER);
    expect(NODE_TYPE_SET).toBe(CATALOG_NODE_TYPE_SET);
  });

  it("projects promo hashtags as a JSON field from the canonical descriptor", () => {
    const canonicalField = getNodeDefinition("suede.promo").ui.fields.find(
      (field) => field.key === "hashtags",
    );
    const clientField = NODE_META.find(
      (metadata) => metadata.type === "suede.promo",
    )?.fields.find((field) => field.key === "hashtags");

    expect(canonicalField?.kind).toBe("json");
    expect(clientField?.kind).toBe("json");
  });

  it("keeps exported descriptors recursively JSON-only", () => {
    for (const definition of NODE_DEFINITIONS) {
      expectJsonDescriptor(definition, definition.type);
    }
  });

  it("keeps the canonical catalog import graph inside the client boundary", () => {
    const graph = relativeImportGraph(ROOT_MODULE);
    const rootSource = fs.readFileSync(ROOT_MODULE, "utf8");

    expect(rootSource).not.toMatch(/process\.env/);
    for (const specifier of importSpecifiers(rootSource)) {
      if (specifier.startsWith(".")) {
        expect(specifier, "root catalog import").toMatch(
          ROOT_ALLOWED_RELATIVE_IMPORT,
        );
      }
    }

    for (const [file, specifiers] of graph) {
      for (const specifier of specifiers) {
        expect(
          specifier,
          `${path.relative(process.cwd(), file)} import`,
        ).not.toMatch(FORBIDDEN_IMPORT);
      }
    }
  });
});
