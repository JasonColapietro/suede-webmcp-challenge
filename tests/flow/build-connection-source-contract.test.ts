import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const buildSource = readFileSync("src/app/build/[flowId]/builder.tsx", "utf8");
const inspectorSource = readFileSync("src/components/canvas/Inspector.tsx", "utf8");

describe("Build connection metadata source contract", () => {
  it("loads only bounded metadata through the strict browser client", () => {
    expect(buildSource).toContain('from "@/lib/connections/client"');
    expect(buildSource).toContain("createConnectionClient");
    expect(buildSource).toContain("connectionChoices");
    expect(buildSource).toMatch(/\.list\(\{\s*limit:\s*100\s*\}\)/u);
    expect(buildSource).not.toContain("resolveHeaders(");
    expect(buildSource).not.toContain("getConnectionRepository(");
  });

  it("keeps explicit loading, ready, error, and unavailable states isolated from graph loading", () => {
    expect(inspectorSource).toContain('"loading" | "ready" | "error" | "unavailable"');
    expect(buildSource).toContain('status: "loading"');
    expect(buildSource).toContain('status: "ready"');
    expect(buildSource).toContain("setConnectionMetadataState");
    expect(buildSource).not.toMatch(/setLoadError\([^)]*connection/iu);
    expect(buildSource).not.toMatch(/recordAuthoritativeGraph\([^)]*connection/iu);
  });

  it("passes metadata choices and status to Inspector without recovery persistence", () => {
    expect(buildSource).toContain("connectionChoices={visibleConnectionMetadataState.choices}");
    expect(buildSource).toContain("connectionChoicesStatus={visibleConnectionMetadataState.status}");
    expect(inspectorSource).toContain("connectionChoices?: readonly ConnectionChoice[]");
    expect(inspectorSource).toContain("connectionChoicesStatus?: ConnectionChoicesStatus");
    expect(buildSource).not.toMatch(/(?:write|encode|rekey)StudioRecovery\([^)]*connection/iu);
    expect(buildSource).not.toMatch(/(?:localStorage|sessionStorage)\.setItem\([^)]*connection/iu);
  });
});
