import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const layout = readFileSync(resolve(process.cwd(), "src/app/layout.tsx"), "utf8");
const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const subsetScript = readFileSync(resolve(process.cwd(), "scripts/subset-geist-fonts.mjs"), "utf8");

const fontBytes = (name: string): number =>
  statSync(resolve(process.cwd(), "src/app/fonts", name)).size;

describe("root typography source contract", () => {
  it("self-hosts the brand faces without remote font fetching", () => {
    // Zero egress: no Google-hosted fonts at build or runtime.
    expect(`${layout}\n${tokens}`).not.toMatch(
      /next\/font\/google|fonts\.(?:googleapis|gstatic)\.com/iu,
    );
    // The display face is repo-local woff2 wired through next/font/local.
    expect(layout).toContain('from "next/font/local"');
    expect(layout).toContain("./fonts/instrument-serif-latin-400-normal.woff2");
    expect(
      existsSync(resolve(process.cwd(), "src/app/fonts/instrument-serif-latin-400-normal.woff2")),
    ).toBe(true);
    // Geist ships as repo-local subset woff2 (no network); both variables reach <html>.
    expect(layout).toContain("./fonts/geist-sans-latin-variable.woff2");
    expect(layout).toContain("./fonts/geist-mono-latin-variable.woff2");
    expect(layout).toContain("geistSans.variable");
    expect(layout).toContain("geistMono.variable");
  });

  it("keeps deterministic system-local fallback stacks behind each brand face", () => {
    expect(tokens).toContain(
      '--font-display: var(--font-instrument-serif, "Iowan Old Style"), "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, "Times New Roman", Times, serif;',
    );
    expect(tokens).toContain(
      '--font-ui: var(--font-geist-sans, ui-sans-serif), ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;',
    );
    expect(tokens).toContain(
      '--font-mono: var(--font-geist-mono, ui-monospace), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;',
    );
  });
});

/**
 * Critical-path weight guard.
 *
 * Every face wired into the root layout is emitted as `<link rel="preload">`,
 * so their combined size is downloaded at highest priority on every cold visit.
 * The upstream `geist` package ships full variable faces (Geist-Variable.woff2
 * = 69,652 B, GeistMono-Variable.woff2 = 71,368 B) carrying Cyrillic, Greek,
 * Vietnamese, and 172 box-drawing glyphs this site never renders. Both faces
 * are used above the fold, so the weight cannot be deferred — it has to be
 * subset instead (see scripts/subset-geist-fonts.mjs).
 *
 * These budgets sit below the upstream sizes on purpose: reverting to
 * `geist/font/sans` / `geist/font/mono`, or regenerating without the subset
 * step, blows the budget and fails here.
 */
describe("preloaded font weight budget", () => {
  const BUDGETS: Record<string, number> = {
    // Subset faces: ~34.5 KB / ~28.2 KB today. Upstream full faces are ~69.7 KB
    // / ~71.4 KB, so a revert cannot slip through either ceiling.
    "geist-sans-latin-variable.woff2": 40_000,
    "geist-mono-latin-variable.woff2": 34_000,
    // Pre-existing self-hosted display face, already latin-subset.
    "instrument-serif-latin-400-normal.woff2": 24_000,
    "instrument-serif-latin-400-italic.woff2": 25_000,
  };

  it.each(Object.entries(BUDGETS))("keeps %s under its byte budget", (name, budget) => {
    expect(existsSync(resolve(process.cwd(), "src/app/fonts", name))).toBe(true);
    expect(fontBytes(name)).toBeLessThanOrEqual(budget);
  });

  it("keeps total preloaded brand-font weight under 120 KB", () => {
    const total = Object.keys(BUDGETS).reduce((sum, name) => sum + fontBytes(name), 0);
    expect(total).toBeLessThanOrEqual(120_000);
  });

  it("never reintroduces the unsubset geist package faces in the root layout", () => {
    expect(layout).not.toMatch(/from\s+"geist\/font\/(?:sans|mono)"/u);
    expect(layout).not.toMatch(/Geist(?:Sans|Mono)\.variable/u);
  });

  /**
   * Guards the other direction: a subset regenerated with a narrower range
   * would stay under budget but silently drop glyphs the site renders. A crawl
   * of every sitemap URL finds 108 distinct characters; these ranges cover the
   * non-ASCII ones that Geist actually ships.
   *
   * (U+2713/U+2717 — ✓ ✗ — are also rendered by the site but are absent from
   * upstream Geist itself, so they resolve through the browser's fallback font
   * both before and after subsetting. U+2713-2718 is kept in the subset range
   * as headroom in case a future Geist release adds them.)
   */
  it("keeps the subset covering every unicode range the site renders", () => {
    for (const range of [
      "U+0020-007E", // Basic Latin
      "U+00A0-00FF", // © · ×
      "U+2000-206F", // – — ' " … ›
      "U+2190-21BB", // ← → ↓
      "U+2713-2718", // ✓ ✗ headroom (see note above)
    ]) {
      expect(subsetScript).toContain(range);
    }
    // `.tabular` sets font-feature-settings: "tnum" 1, "lnum" 1 — pyftsubset
    // drops both unless they are retained explicitly.
    expect(subsetScript).toMatch(/--layout-features\+=[^"']*\btnum\b/u);
    expect(subsetScript).toMatch(/--layout-features\+=[^"']*\blnum\b/u);
  });
});
