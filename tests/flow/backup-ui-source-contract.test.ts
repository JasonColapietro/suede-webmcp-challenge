import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/app/flows/dashboard.tsx", "utf8");

describe("flows dashboard recovery controls", () => {
  it("keeps backup and restore obvious without overstating the recovery scope", () => {
    expect(source).toContain("Flow recovery");
    expect(source).toContain("Back up all flows");
    expect(source).toContain("Restore backup");
    expect(source).toContain("Restore adds only missing flow IDs and never overwrites a current flow.");
    expect(source).toContain("run and agent history is not included");
    expect(source).not.toContain("not backed up elsewhere yet");
  });

  it("uses the private archive API for both download and bounded JSON restore", () => {
    expect(source.match(/fetch\("\/api\/flows\/backup"/gu)).toHaveLength(2);
    expect(source).toContain('method: "POST"');
    expect(source).toContain('accept="application/json,.json"');
    expect(source).toContain("MAX_FLOW_BACKUP_FILE_BYTES");
    expect(source).toContain('aria-label="Choose a flow backup to restore"');
  });
});
