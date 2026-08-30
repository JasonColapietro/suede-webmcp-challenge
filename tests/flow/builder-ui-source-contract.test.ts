import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

describe("builder command UI source contract", () => {
  const flowCanvas = source("src/components/canvas/FlowCanvas.tsx");
  const buildPage = source("src/app/build/[flowId]/builder.tsx");
  const inspector = source("src/components/canvas/Inspector.tsx");
  const palette = source("src/components/canvas/NodePalette.tsx");

  it("keeps React Flow as a gesture adapter with one command outlet", () => {
    expect(flowCanvas).toContain("onCommand");
    expect(flowCanvas).toContain("deleteKeyCode={null}");
    expect(flowCanvas).toContain('selectionKeyCode="Shift"');
    expect(flowCanvas).toContain("multiSelectionKeyCode");
    expect(flowCanvas).toContain("onSelectionChange");
    expect(flowCanvas).toContain("onNodeDragStop");
    expect(flowCanvas).toContain("onPointerDownCapture");
    expect(flowCanvas).toContain("modifierSelectionRef.current");
    expect(flowCanvas).toContain("rf.getInternalNode(id)");
    expect(flowCanvas).not.toContain("fromRfNode");
    expect(flowCanvas).not.toContain("fromRfEdge");
    expect(flowCanvas).not.toContain("const emit");
    expect(flowCanvas).not.toContain("applyNodeChanges");
    expect(flowCanvas).not.toContain("applyEdgeChanges");
    expect(flowCanvas).not.toContain("addEdge");
  });

  it("gives BuildPage sole graph history and persistence ownership", () => {
    expect(buildPage).toContain("createGraphHistory");
    expect(buildPage).toContain("resetGraphHistory");
    expect(buildPage).toContain("dispatchGraphCommand");
    expect(buildPage).toContain("undoGraphCommand");
    expect(buildPage).toContain("redoGraphCommand");
    expect(buildPage).toContain("saveCoordinatorRef.current!.retryLatest()");
    expect(buildPage).toContain("scheduleSave(next.graph)");
    expect(buildPage).not.toMatch(/nodes:\s*\[\.\.\.prev\.nodes/);
    expect(buildPage).not.toMatch(/nodes:\s*prev\.nodes\.map/);
    expect(buildPage).not.toContain("handleGraphChange");
  });

  it("does not persist a template merely because its builder route was viewed", () => {
    expect(buildPage).not.toContain("autoPersistTemplate");
    expect(buildPage).not.toContain("pendingWarningTemplatePersistRef");
    expect(buildPage).not.toContain("void persist(chosen)");
    expect(buildPage).toContain("prepareRun={persistedId ? undefined");
  });

  it("routes palette, name, and Inspector edits through typed commands", () => {
    expect(buildPage).toContain('kind: "node.add"');
    expect(buildPage).toContain('kind: "graph.rename"');
    expect(buildPage).toContain('kind: "node.patch"');
    expect(inspector).toContain("onPatch");
    expect(inspector).toContain("JsonPatchOp");
    expect(inspector).toContain("onFocus");
    expect(inspector).toContain("onBlur");
    expect(palette).toContain("selectNodePaletteDefinition(def.type, onAdd, onBrowseApiOperations)");
  });

  it("keeps all client command surfaces outside server dependency boundaries", () => {
    const clients = [flowCanvas, buildPage, inspector, palette].join("\n");
    expect(clients).not.toMatch(/@\/lib\/flow\/(?:registry|executor)/);
    expect(clients).not.toMatch(/@\/lib\/(?:db|repository|run-service|settlement|x402)/);
    expect(clients).not.toMatch(/from\s+["']node:/);
    expect(clients).not.toMatch(/better-sqlite3|@supabase\/supabase-js/);
  });

  it("keeps measured bounds and selection transient", () => {
    expect(buildPage).toContain("GraphSelection");
    expect(buildPage).toContain("NodeBounds");
    expect(buildPage).toContain("setMeasuredBounds");
    expect(buildPage).not.toMatch(/JSON\.stringify\([^)]*(?:selection|measuredBounds)/);
    expect(flowCanvas).toContain("measuredBoundsForNodes");
    expect(flowCanvas).toContain('stroke: "var(--primary)", strokeWidth: 3');
  });

  it("puts the execution state on React Flow's focusable node wrapper", () => {
    const suedeNode = source("src/components/canvas/SuedeNode.tsx");

    expect(flowCanvas).toContain("ariaLabel:");
    expect(flowCanvas).toContain("suedeNodeStatusLabel(status)");
    expect(suedeNode).not.toContain('role="group"');
    expect(suedeNode).toContain('className="suede-node-status mono"');
  });
});
