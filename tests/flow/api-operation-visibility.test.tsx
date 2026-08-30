import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  isNodeTypeAvailable,
  projectAvailableNodeDefinitions,
} from "@/lib/flow/node-definitions";
import { projectAvailableNodeMeta } from "@/lib/flow/node-meta";

vi.stubEnv("NEXT_PUBLIC_CONNECTOR_LAB_ENABLED", "");
const paletteModule = await import("@/components/canvas/NodePalette");
const NodePalette = paletteModule.default;
const { buildSystemPrompt } = await import("@/lib/guided/draft");

afterAll(() => vi.unstubAllEnvs());

describe("api.operation public availability", () => {
  it("keeps exhaustive registries while default-off palette and guided projections omit the prototype", () => {
    expect(projectAvailableNodeDefinitions({ enabled: false }, "visible").some(({ type }) => type === "api.operation")).toBe(false);
    expect(projectAvailableNodeMeta({ enabled: false }, "visible").some(({ type }) => type === "api.operation")).toBe(false);
    expect(projectAvailableNodeDefinitions({ enabled: true }, "visible").some(({ type }) => type === "api.operation")).toBe(true);
    expect(isNodeTypeAvailable("api.operation", { enabled: false }, "executable")).toBe(false);
    expect(isNodeTypeAvailable("api.operation", { enabled: true }, "executable")).toBe(false);

    const palette = renderToStaticMarkup(createElement(NodePalette, { onAdd: () => undefined }));
    expect(palette).not.toContain("api.operation");
    expect(palette).not.toContain("API Operation");
    expect(buildSystemPrompt()).not.toContain("api.operation");
    expect(buildSystemPrompt()).not.toContain("API Operation");
  });

  it("wires palette and guided copy through the shared availability projection", () => {
    const palette = readFileSync(join(process.cwd(), "src/components/canvas/NodePalette.tsx"), "utf8");
    const guided = readFileSync(join(process.cwd(), "src/lib/guided/draft.ts"), "utf8");
    expect(palette).toContain("projectAvailableNodeDefinitions(CONNECTOR_LAB_FLAG, \"visible\")");
    expect(guided).toContain("projectAvailableNodeMeta(CONNECTOR_LAB_FLAG, \"visible\")");
    expect(guided).toContain('filter((node) => node.type !== "api.operation")');
    expect(palette).toContain("onBrowseApiOperations");
    expect(palette).toContain("Prototype: simulation only");
    expect(palette).toContain("Cannot run in published workflows");
  });

  it("routes API Operation only to the picker and keeps generic add/drag closed", () => {
    const added: string[] = [];
    let browseCount = 0;
    expect(paletteModule.nodePaletteDefinitionDraggable("api.operation")).toBe(false);
    expect(paletteModule.nodePaletteDefinitionDraggable("http")).toBe(true);
    expect(paletteModule.selectNodePaletteDefinition("api.operation", (type) => added.push(type), () => { browseCount += 1; })).toBe(true);
    expect(added).toEqual([]);
    expect(browseCount).toBe(1);
    expect(paletteModule.selectNodePaletteDefinition("api.operation", (type) => added.push(type))).toBe(false);
    expect(paletteModule.selectNodePaletteDefinition("http", (type) => added.push(type), () => { browseCount += 1; })).toBe(true);
    expect(added).toEqual(["http"]);
    expect(browseCount).toBe(1);
  });
});
