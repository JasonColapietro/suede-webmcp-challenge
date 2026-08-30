#!/usr/bin/env node
/**
 * Regenerates the repo-local Geist Sans / Geist Mono latin subsets that
 * `src/app/layout.tsx` loads through `next/font/local`.
 *
 * Why this exists
 * ---------------
 * The `geist` npm package ships the *full* variable faces: Geist-Variable.woff2
 * (69,652 B) and GeistMono-Variable.woff2 (71,368 B). Between them that is
 * ~141 KB of `<link rel="preload">` on the critical path of every cold visit,
 * and both faces are used above the fold (nav, wordmark, hero stats, buttons),
 * so neither preload can simply be dropped without a visible FOUT.
 *
 * Most of that weight is coverage this site never renders: Cyrillic, Greek,
 * Vietnamese (Latin Extended Additional), and — in the mono face — 172
 * box-drawing glyphs. A crawl of every URL in the sitemap finds 108 distinct
 * characters in use, all Latin plus a handful of punctuation/arrow symbols.
 *
 * Subsetting to the range below keeps every glyph the site can render (with
 * generous headroom for accented names and currency), preserves the `wght`
 * 100..900 variable axis, preserves the `tnum`/`lnum` numeric features the
 * `.tabular` styles depend on, and leaves every vertical metric byte-identical
 * so `next/font`'s metric-adjusted fallback face stays valid (no CLS change).
 *
 * Usage
 * -----
 *   pip install fonttools brotli      # provides `pyftsubset`
 *   node scripts/subset-geist-fonts.mjs
 *
 * The generated .woff2 files are committed; this script only needs to be re-run
 * when the `geist` dependency is upgraded.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `geist` does not export "./package.json", so resolve the shipped faces by path.
const geistFonts = resolve(repoRoot, "node_modules/geist/dist/fonts");
const outDir = resolve(repoRoot, "src/app/fonts");

if (!existsSync(geistFonts)) {
  throw new Error(`Cannot find geist fonts at ${geistFonts} — run npm install first.`);
}

/**
 * Retained codepoints. Deliberately wider than the 108 characters the site
 * currently renders so that new copy, template names, and agent titles cannot
 * silently lose a glyph.
 */
const UNICODES = [
  "U+0020-007E", // Basic Latin
  "U+00A0-00FF", // Latin-1 Supplement (© · × ° accented letters)
  "U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC", // common Latin extras
  "U+0300-0304,U+0308-0309,U+0323,U+0329", // combining marks
  "U+2000-206F", // General Punctuation (– — ' " … ‹ ›)
  "U+20A0-20BF", // Currency symbols
  "U+2105,U+2113,U+2122", // ℅ ℓ ™
  "U+2190-21BB", // Arrows (← → ↓ ↑)
  "U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2217,U+2219,U+221A,U+221E,U+222B",
  "U+2248,U+2260,U+2264-2265", // ≈ ≠ ≤ ≥
  "U+25A0-25CF", // Geometric shapes (bullets/markers)
  "U+2713-2718", // ✓ ✗ ✔ ✘
  "U+FEFF,U+FFFD",
].join(",");

/**
 * `pyftsubset` keeps a default set of layout features that does NOT include the
 * numeric ones. `src/app/site.css` sets `font-feature-settings: "tnum" 1,
 * "lnum" 1` on `.tabular`, so these must be retained explicitly.
 */
const LAYOUT_FEATURES =
  "--layout-features+=tnum,lnum,onum,pnum,zero,frac,numr,dnom,sups,subs,case,ss01,ss02,ss03,salt,cv01";

/** @type {{ src: string; out: string; label: string }[]} */
const TARGETS = [
  {
    src: resolve(geistFonts, "geist-sans/Geist-Variable.woff2"),
    out: resolve(outDir, "geist-sans-latin-variable.woff2"),
    label: "Geist Sans",
  },
  {
    src: resolve(geistFonts, "geist-mono/GeistMono-Variable.woff2"),
    out: resolve(outDir, "geist-mono-latin-variable.woff2"),
    label: "Geist Mono",
  },
];

let totalBefore = 0;
let totalAfter = 0;

for (const { src, out, label } of TARGETS) {
  execFileSync(
    "pyftsubset",
    [
      src,
      `--output-file=${out}`,
      "--flavor=woff2",
      `--unicodes=${UNICODES}`,
      LAYOUT_FEATURES,
      "--name-IDs=*",
      "--notdef-outline",
      "--no-hinting",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const before = statSync(src).size;
  const after = statSync(out).size;
  totalBefore += before;
  totalAfter += after;
  const pct = ((1 - after / before) * 100).toFixed(1);
  console.log(`${label.padEnd(12)} ${before} B -> ${after} B (-${before - after} B, -${pct}%)`);
}

const pct = ((1 - totalAfter / totalBefore) * 100).toFixed(1);
console.log(`${"TOTAL".padEnd(12)} ${totalBefore} B -> ${totalAfter} B (-${totalBefore - totalAfter} B, -${pct}%)`);
