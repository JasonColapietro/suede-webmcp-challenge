/**
 * The three build settings — Guided, Studio, Code — have to be discoverable at
 * the moment a visitor decides how to build, not only after they have already
 * walked through one of the three doors. Before this contract, ModeSwitch was
 * the only surface that named all three and it renders exclusively on /start,
 * /build/[flowId] and /code/[flowId]; the nav's "Build" link went straight to
 * Guided, so Studio (the canvas) and Code were invisible to anyone who had not
 * already found them.
 *
 * Source-contract style, same as visual-polish-source-contract: these assert
 * the wiring exists, and the unit assertions below exercise the href resolver
 * for real.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_SETTINGS,
  BUILD_SETTINGS_LEDE,
  buildSettingHref,
  type BuildSettingId,
} from "@/lib/build-settings";

const source = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");

describe("build settings catalog", () => {
  it("names exactly the three settings, each with a label and a blurb", () => {
    expect(BUILD_SETTINGS.map((s) => s.id)).toEqual<BuildSettingId[]>([
      "guided",
      "studio",
      "code",
    ]);
    for (const setting of BUILD_SETTINGS) {
      expect(setting.label.length).toBeGreaterThan(0);
      // A bare label is what the old ModeSwitch already had. The blurb is the
      // whole point: it says what the setting *is* before you commit to it.
      expect(setting.blurb.length).toBeGreaterThan(20);
      expect(setting.blurb.trim()).toBe(setting.blurb);
    }
  });

  it("leads with one sentence that separates all three", () => {
    for (const setting of BUILD_SETTINGS) {
      expect(BUILD_SETTINGS_LEDE).toContain(setting.label);
    }
  });
});

describe("buildSettingHref", () => {
  it("routes each setting to its own door when no flow exists yet", () => {
    expect(buildSettingHref("guided", null)).toBe("/start");
    expect(buildSettingHref("studio", null)).toBe("/build/new");
    // Code starts in the terminal, so there is no flow-less canvas to open.
    // It points at the SDK quickstart rather than rendering as disabled — a
    // greyed third option in a three-option menu reads as unfinished product.
    expect(buildSettingHref("code", null)).toBe("/docs#sdk");
  });

  it("carries an existing flow into whichever setting is chosen", () => {
    expect(buildSettingHref("guided", "abc")).toBe("/start?flow=abc");
    expect(buildSettingHref("studio", "abc")).toBe("/build/abc");
    expect(buildSettingHref("code", "abc")).toBe("/code/abc");
  });
});

describe("the nav exposes the choice at the decision point", () => {
  const nav = source("src/components/site/SiteNav.tsx");

  it("renders Build as a disclosure over all three settings, not a link to Guided", () => {
    expect(nav).toContain('from "@/lib/build-settings"');
    expect(nav).toContain("BUILD_SETTINGS");
    expect(nav).toContain("BUILD_SETTINGS_LEDE");
    // <details>/<summary> is the pattern the hamburger already uses here:
    // keyboard-operable and click-driven, so it works on touch.
    expect(nav).toContain("lp-nav-build");
    expect(nav).toContain("<summary");
    // The direct-to-Guided path is not lost — the primary CTA still takes it.
    expect(nav).toContain('<Link href="/start" className="lp-btn lp-btn--primary lp-btn--sm">');
  });

  it("keeps the canvas and the workspace reachable from the Build menu", () => {
    // Workspace drops out of the inline row between 1025-1220px via data-trim.
    // The Build menu is what keeps it (and Templates) one click away there.
    expect(nav).toContain("BUILD_MENU_LINKS");
    expect(nav).toContain('{ href: "/flows", label: "Workspace" }');
    expect(nav).toContain('{ href: "/templates", label: "Templates" }');
  });

  it("still lists Build in the hamburger panel", () => {
    expect(nav).toContain("lp-nav-menu-panel");
  });
});

describe("the settings are defined in one place", () => {
  it("has ModeSwitch read its labels from the catalog", () => {
    const modeSwitch = source("src/components/mode-switch.tsx");
    expect(modeSwitch).toContain('from "@/lib/build-settings"');
    // The old local literal is gone: two lists drift.
    expect(modeSwitch).not.toContain('{ id: "guided", label: "Guided" }');
    // Studio's unsaved-work interception depends on these staying put.
    expect(modeSwitch).toContain("encodeURIComponent(flowId)");
    expect(modeSwitch).toContain("onNavigate(href, event)");
  });

  it("has the docs intro render the same lede rather than restating it", () => {
    const docs = source("src/app/docs/page.tsx");
    expect(docs).toContain("BUILD_SETTINGS_LEDE");
    expect(docs).not.toContain("Three settings to build: Guided walks you through it");
  });
});

describe("the settings switch explains itself in place", () => {
  it("gives every ModeSwitch item its blurb as a title", () => {
    const modeSwitch = source("src/components/mode-switch.tsx");
    expect(modeSwitch).toContain("title={");
    expect(modeSwitch).toContain("blurb");
  });
});

describe("the Build menu's styling resolves", () => {
  it("references only custom properties that are actually defined", () => {
    // An undefined var() fails silently: `background: var(--surface)` on a
    // token that does not exist leaves the dropdown panel transparent, so its
    // text renders straight over the page behind it. Caught exactly that in
    // review, so it gets a test rather than a fixed spelling.
    const chrome = source("src/app/chrome.css");
    const defined = new Set<string>();
    for (const file of ["src/styles/tokens.css", "src/app/chrome.css", "src/app/globals.css"]) {
      for (const [, name] of source(file).matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(name);
    }

    const buildRules = chrome
      .split(/(?=^\.)/m)
      .filter((rule) => rule.startsWith(".lp-nav-build") || rule.startsWith(".lp-nav-menu-build"));
    expect(buildRules.length).toBeGreaterThan(5);

    const missing: string[] = [];
    for (const rule of buildRules) {
      // Only flag bare var(--x); var(--x, fallback) degrades on purpose.
      for (const [, name] of rule.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)) {
        if (!defined.has(name)) missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });
});
