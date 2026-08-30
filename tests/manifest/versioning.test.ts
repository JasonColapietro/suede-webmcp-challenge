import { describe, expect, it } from "vitest";
import { codegen } from "@/lib/manifest/codegen";
import { flowToManifest } from "@/lib/manifest/from-flow";
import { AgentManifestSchema } from "@/lib/manifest/schema";
import { manifestToFlow } from "@/lib/manifest/to-flow";
import { hashFlowGraph } from "@/lib/projects/hash";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const VERSIONING = {
  schemaVersion: 1 as const,
  resourceVersion: {
    resourceId: "flow:opaque/id",
    versionId: "version:opaque/id",
    versionNumber: 7,
    semanticHash: HASH_A,
    fullHash: HASH_B,
  },
  dependencies: [
    {
      kind: "skill" as const,
      resourceId: "skill:zeta",
      version: "2.0.0",
      contentHash: "sha256:zeta",
    },
    {
      kind: "connector" as const,
      resourceId: "connector:alpha",
      version: "1.0.0",
    },
    {
      kind: "resource" as const,
      resourceId: "resource:pricing",
      version: "pack-7",
      contentHash: HASH_A,
    },
  ],
};

function versionedManifestInput() {
  return {
    manifestVersion: 1,
    name: "Versioned agent",
    description: "Pinned and immutable.",
    triggers: [{ kind: "manual" }],
    steps: [{ id: "input", type: "input", config: {}, after: [] }],
    meta: {},
    schemaVersion: VERSIONING.schemaVersion,
    resourceVersion: { ...VERSIONING.resourceVersion },
    dependencies: VERSIONING.dependencies.map((dependency) => ({ ...dependency })),
  };
}

describe("versioned AgentManifest schema", () => {
  it("keeps optional version fields absent for a legacy manifest", () => {
    const parsed = AgentManifestSchema.parse({
      manifestVersion: 1,
      name: "Legacy",
      triggers: [{ kind: "manual" }],
      steps: [{ id: "input", type: "input" }],
    });

    expect(Object.hasOwn(parsed, "schemaVersion")).toBe(false);
    expect(Object.hasOwn(parsed, "resourceVersion")).toBe(false);
    expect(Object.hasOwn(parsed, "dependencies")).toBe(false);
  });

  it("accepts and canonically sorts version metadata", () => {
    const parsed = AgentManifestSchema.parse(versionedManifestInput()) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      resourceVersion: VERSIONING.resourceVersion,
      dependencies: [VERSIONING.dependencies[1], VERSIONING.dependencies[2], VERSIONING.dependencies[0]],
    });
  });

  it("rejects unsupported schema versions", () => {
    expect(
      AgentManifestSchema.safeParse({ ...versionedManifestInput(), schemaVersion: 2 }).success,
    ).toBe(false);
  });

  it("rejects non-lowercase or non-SHA-256 resource hashes", () => {
    const input = versionedManifestInput();
    input.resourceVersion.semanticHash = "A".repeat(64);

    expect(AgentManifestSchema.safeParse(input).success).toBe(false);
  });

  it("rejects unknown resource-version keys", () => {
    const input = {
      ...versionedManifestInput(),
      resourceVersion: { ...VERSIONING.resourceVersion, surprise: true },
    };

    expect(AgentManifestSchema.safeParse(input).success).toBe(false);
  });

  it("rejects unknown top-level manifest fields instead of silently stripping them", () => {
    expect(
      AgentManifestSchema.safeParse({ ...versionedManifestInput(), futurePlatformField: true })
        .success,
    ).toBe(false);
  });

  it("rejects duplicate dependency kind and resource pairs", () => {
    const input = {
      ...versionedManifestInput(),
      dependencies: [
        { kind: "skill", resourceId: "same", version: "1" },
        { kind: "skill", resourceId: "same", version: "2" },
      ],
    };

    expect(AgentManifestSchema.safeParse(input).success).toBe(false);
  });
});

describe("versioned manifest compilers", () => {
  it("deep-round-trips version metadata without adding enumerable graph fields", () => {
    const manifest = AgentManifestSchema.parse(versionedManifestInput());
    const graph = manifestToFlow(manifest);

    expect(flowToManifest(graph)).toEqual(manifest);
    expect(Object.keys(graph)).toEqual(["id", "name", "nodes", "edges", "meta"]);
    expect(JSON.parse(JSON.stringify(graph))).not.toHaveProperty("resourceVersion");
    expect(graph.meta).not.toHaveProperty("resourceVersion");
  });

  it("accepts explicit version metadata after a graph JSON round-trip", () => {
    const manifest = AgentManifestSchema.parse(versionedManifestInput());
    const graph = JSON.parse(JSON.stringify(manifestToFlow(manifest)));

    expect(flowToManifest(graph, { versionMetadata: VERSIONING })).toEqual(manifest);
  });

  it("leaves semantic and full graph hashes unchanged by transport metadata", () => {
    const manifest = AgentManifestSchema.parse(versionedManifestInput());
    const graph = manifestToFlow(manifest);
    const jsonGraph = JSON.parse(JSON.stringify(graph));

    expect(hashFlowGraph(graph, { semantic: true })).toBe(
      hashFlowGraph(jsonGraph, { semantic: true }),
    );
    expect(hashFlowGraph(graph, { semantic: false })).toBe(
      hashFlowGraph(jsonGraph, { semantic: false }),
    );
  });
});

describe("versioned manifest codegen", () => {
  it("conditionally emits deterministic version metadata before defineAgent", () => {
    const manifest = AgentManifestSchema.parse(versionedManifestInput());
    const first = codegen(manifest);
    const second = codegen(manifest);

    expect(first).toBe(second);
    expect(first).toContain("export const suedeVersion = {");
    expect(first.indexOf("export const suedeVersion")).toBeLessThan(
      first.indexOf("export default defineAgent"),
    );
    expect(first).not.toContain("exportedAt");
    expect(first).not.toContain(process.cwd());
  });

  it("emits identical version metadata across object and dependency insertion order", () => {
    const first = AgentManifestSchema.parse(versionedManifestInput());
    const second = {
      ...first,
      resourceVersion: {
        fullHash: HASH_B,
        semanticHash: HASH_A,
        versionNumber: 7,
        versionId: "version:opaque/id",
        resourceId: "flow:opaque/id",
      },
      dependencies: [...(first.dependencies ?? [])].reverse(),
    };

    expect(codegen(first)).toBe(codegen(second));
  });

  it("does not emit a version constant for legacy manifests", () => {
    const legacy = AgentManifestSchema.parse({
      manifestVersion: 1,
      name: "Legacy",
      triggers: [{ kind: "manual" }],
      steps: [{ id: "input", type: "input" }],
    });

    expect(codegen(legacy)).not.toContain("suedeVersion");
  });
});
