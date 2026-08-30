import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const landingCss = readFileSync(
  new URL("../src/app/chrome.css", import.meta.url),
  "utf8",
);

describe("persistent site navigation", () => {
  it("keeps the shared top bar fixed without covering page content", () => {
    expect(landingCss).toMatch(/\.lp\s*\{[^}]*--lp-nav-h:\s*64px/s);
    expect(landingCss).toMatch(
      /\.lp\s*\{[^}]*padding-top:\s*var\(--lp-nav-h\)/s,
    );
    expect(landingCss).toMatch(/\.lp-nav\s*\{[^}]*position:\s*fixed/s);
    expect(landingCss).toMatch(/\.lp-nav\s*\{[^}]*inset:\s*0 0 auto/s);
    expect(landingCss).toMatch(
      /\.lp-nav-inner\s*\{[^}]*height:\s*var\(--lp-nav-h\)/s,
    );
  });

  it("keeps linked sections visible below the persistent bar", () => {
    expect(landingCss).toMatch(
      /\.lp :where\(\[id\]\)\s*\{[^}]*scroll-margin-top:\s*calc\(var\(--lp-nav-h\) \+ 1rem\)/s,
    );
  });
});
