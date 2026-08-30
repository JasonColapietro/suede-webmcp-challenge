import { describe, it, expect } from "vitest";
import { SEED_TEMPLATES, getTemplate } from "@/lib/templates";
import { runFlow, collectRun } from "@/lib/flow/engine";
import { getRegistry } from "@/lib/flow/registry";
import { makeCtx } from "../_helpers";

describe("seed templates run end-to-end", () => {
  it("song-register-royalty completes in dry-run with zero cost and produces output", async () => {
    // Arrange
    const template = getTemplate("song-register-royalty");
    if (!template) throw new Error("song-register-royalty template missing");
    const { graph } = template;

    // Act
    const { status, totalCostUsdc, outputs } = await collectRun(
      runFlow(graph, makeCtx(), getRegistry(), { prompt: "test" }),
    );

    // Assert
    expect(status).toBe("done");
    expect(totalCostUsdc).toBe(0);
    expect(Object.keys(outputs).length).toBeGreaterThan(0);
  });

  it("every seed template runs to status done in dry-run", async () => {
    for (const template of SEED_TEMPLATES) {
      const { status } = await collectRun(
        runFlow(template.graph, makeCtx(), getRegistry(), {}),
      );
      expect(status, `template ${template.slug} should complete`).toBe("done");
    }
  });
});
