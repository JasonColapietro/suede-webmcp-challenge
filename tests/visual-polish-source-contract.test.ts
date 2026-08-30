import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("visual polish source contract", () => {
  it("keeps Guided in the first frame with a labeled, named action", () => {
    const guided = source("src/app/start/guided-client.tsx");

    expect(guided).toContain('htmlFor="guided-job"');
    expect(guided).toContain('id="guided-job"');
    expect(guided).toContain('role="log"');
    expect(guided).toContain("Start guided build");
    expect(guided).toContain('prefers-reduced-motion: reduce');
    expect(guided).not.toContain("autoFocus");
  });

  it("stacks ledger rows and actions at the phone breakpoint", () => {
    const css = source("src/app/site.css");

    expect(css).toContain("@media (max-width: 620px)");
    expect(css).toContain(".lp-row > .grow");
    expect(css).toContain("flex: 1 0 100%");
    expect(css).toContain(".lp-row-actions .lp-claim-input");
  });

  it("keeps semantic text separate from decorative signal colors", () => {
    const tokens = source("src/styles/tokens.css");

    expect(tokens).toContain("--text-success: #047857");
    expect(tokens).toContain("--text-info: #0369a1");
    expect(tokens).toContain("--text-warning: #92400e");
  });

  it("keeps catalog controls and cards touch-safe at phone widths", () => {
    const css = source("src/app/site.css");

    expect(css).toContain("minmax(min(100%, 260px), 1fr)");
    expect(css).toMatch(/\.lp-cat-chip\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/\.lp-catalog-search input\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/\.lp-load-more \.lp-btn\s*\{[^}]*min-height:\s*44px/s);
  });

  it("keeps the setting switch touch-safe and class-backed", () => {
    const tokens = source("src/styles/tokens.css");
    const css = source("src/app/site.css");
    const modeSwitch = source("src/components/mode-switch.tsx");

    expect(tokens).toContain("--control-h: 44px");
    expect(css).toMatch(/\.mode-switch__item\s*\{[^}]*min-height:\s*var\(--control-h\)/s);
    expect(modeSwitch).toContain('className="mode-switch__item"');
    expect(modeSwitch).not.toContain("height: 32");
  });

  it("stacks Guided review content and actions on small screens", () => {
    const css = source("src/app/site.css");
    const guided = source("src/app/start/guided-client.tsx");

    expect(guided).toContain('className="guided-review-grid"');
    expect(guided).toContain('className="guided-review-actions"');
    expect(css).toMatch(/@media \(max-width: 620px\)[\s\S]*?\.guided-review-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
    expect(css).toMatch(/@media \(max-width: 620px\)[\s\S]*?\.guided-review-actions\s*\{[^}]*flex-direction:\s*column/s);
  });

  it("does not suppress keyboard focus on the edited form controls", () => {
    for (const path of [
      "src/app/build/[flowId]/builder.tsx",
      "src/app/grade/grade-client.tsx",
      "src/components/canvas/RunDock.tsx",
    ]) {
      expect(source(path)).not.toContain('outline: "none"');
    }

    expect(source("src/app/globals.css")).toContain(":focus-visible");
  });

  it("keeps the public shell and catalog hierarchy explicit", () => {
    const homepage = source("src/app/page.tsx");
    const nav = source("src/components/site/SiteNav.tsx");
    const footer = source("src/components/site/SiteFooter.tsx");
    const templates = source("src/app/templates/page.tsx");
    const css = source("src/app/site.css");

    expect(nav).toContain('href="#main-content"');
    expect(homepage).toContain('<main id="main-content">');
    expect(footer).toContain('<nav className="lp-footer-nav" aria-label="Footer">');
    expect(footer).toContain('<Link href="/pricing">Pricing</Link>');
    expect(templates).toContain('aria-labelledby="featured-templates-title"');
    expect(templates).toContain("All {allTemplates.length} templates, by category.");
    expect(css).toMatch(/\.lp-featured-template\s*\{[^}]*transition:/s);
  });

  it("keeps the Studio canvas legible before and after the first node", () => {
    const canvas = source("src/components/canvas/FlowCanvas.tsx");
    const node = source("src/components/canvas/SuedeNode.tsx");

    expect(canvas).toContain('className="canvas-empty-state"');
    expect(canvas).toContain("Add your first node");
    expect(node).toContain("width: 24");
    expect(node).toContain('fontSize: "var(--text-label)"');
  });
  /* The rail's rows carry minimum floors (190px variables + 220px inspector) on
     top of two auto rows, so its content has a hard minimum height. Under
     `overflow: hidden` that minimum was amputated instead of scrolled: at
     1440x768 the "Select a node" heading rendered 10px below the run dock
     boundary and was sliced mid-glyph, and by 700px tall it was gone entirely.
     The rail must scroll when the floors cannot be honored. */
  it("scrolls the inspector rail instead of clipping it when the floors do not fit", () => {
    // Declarations only — the rule's own comment explains the old `overflow:
    // hidden` behaviour by name, and a raw match would read that prose as code.
    const css = source("src/app/site.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const rail = /\.studio-inspector-rail\s*\{[^}]*\}/s.exec(css)?.[0] ?? "";

    expect(rail).toContain("overflow-y: auto");
    expect(rail).not.toMatch(/overflow:\s*hidden/);
    expect(rail).toContain("minmax(190px, 0.8fr) minmax(220px, 1fr)");
  });
});
