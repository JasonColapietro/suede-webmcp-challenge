import { describe, expect, it } from "vitest";
import { isTestAgent } from "@/lib/catalog";

describe("public catalog test-agent filtering", () => {
  it("excludes the CLI stable roundtrip artifact from public surfaces", () => {
    expect(isTestAgent("cli-stable-roundtrip-uf8rm", "CLI Stable Roundtrip")).toBe(true);
  });

  it("keeps real launched agents in the public catalog", () => {
    expect(isTestAgent("daily-lyric-drop-s4f7x", "Daily Lyric Drop")).toBe(false);
    expect(isTestAgent("the-ownership-loop-dwbjc", "The Ownership Loop")).toBe(false);
  });

  it("still excludes a CLI-prefixed test fixture", () => {
    expect(isTestAgent("cli-test-owner-ab12c", "CLI Test Owner")).toBe(true);
  });

  it("does not exclude a real template whose name contains the bare word 'test'", () => {
    expect(isTestAgent("function-to-test-cases-b7zz5", "Function-to-Test-Cases")).toBe(false);
  });
});
