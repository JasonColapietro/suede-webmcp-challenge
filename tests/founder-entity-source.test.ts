import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("founder entity name parity", () => {
  const layout = read("src/app/layout.tsx");
  const founder = read("src/app/founder/page.tsx");
  const llms = read("public/llms.txt");

  it("keeps Jason canonical and publishes only the one declared alias", () => {
    for (const source of [layout, founder]) {
      expect(source).toContain('name: "Jason Colapietro"');
      expect(source).toContain('alternateName: ["Johnny Suede"]');
      expect(source).toContain('"https://jasoncolapietro.com/"');
      expect(source).toContain('"https://johnnysuede.com/"');
    }
  });

  it("never publishes 'Jay Colapietro', which is not a declared alias", () => {
    for (const source of [layout, founder, llms]) {
      expect(source).not.toContain("Jay Colapietro");
    }
  });

  it("mirrors the identity statement in the founder page and LLM feed", () => {
    expect(founder).toContain("creates under the declared alias");
    expect(llms).toContain(
      "Jason Colapietro and Johnny Suede are the same person; Johnny Suede is the declared creative alias.",
    );
    expect(llms).toContain("https://jasoncolapietro.com");
    expect(llms).toContain("https://johnnysuede.com");
  });
});
