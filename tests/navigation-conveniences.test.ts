import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(path, "utf8");

describe("owner workspace navigation conveniences", () => {
  it("names the private flows and portfolio browser surfaces in document metadata", () => {
    expect(source("src/app/flows/layout.tsx")).toContain('title: "My flows"');
    expect(source("src/app/portfolio/layout.tsx")).toContain('title: "Portfolio"');
  });

  it("permanently routes the bare comparison path to the only current comparison", () => {
    const path = "src/app/compare/page.tsx";
    expect(existsSync(path)).toBe(true);
    expect(source(path)).toContain('permanentRedirect("/compare/gumloop-alternative")');
  });
});
