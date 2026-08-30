import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import { SITE_URL } from "@/lib/site";

const ROOT = process.cwd();

describe("mystery landing", () => {
  it("renders the approved public entry and shared sign-in handoff", () => {
    const markup = renderToStaticMarkup(createElement(Home));

    expect(markup.match(/<h1(?:\s[^>]*)?>/g)).toHaveLength(1);
    expect(markup).toContain("Build agents that can earn while you sleep.");
    expect(markup).toContain("Publish repeatable work as callable services.");
    expect(markup).toContain("You decide what goes live and when paid calls are enabled.");
    expect(markup.match(/https:\/\/app\.suedeai\.ai\//g)).toHaveLength(2);
    expect(markup).toContain(encodeURIComponent(`${SITE_URL}/enter`));
    expect(markup).toContain('id="main-content"');
    expect(markup).toContain('<main id="main-content" class="mystery-main">');
    expect(markup).not.toMatch(/Templates|Pricing|Directory|FAQ|settled calls|x402|USDC/u);
  });

  it("uses the established Suede theme with accessible, motion-safe sizing", () => {
    const css = readFileSync(`${ROOT}/src/app/mystery-landing.css`, "utf8");

    expect(css).toContain("min-height: 100svh");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("88px");
    expect(css).toContain("72px");
    expect(css).toContain("52px");
    expect(css).toContain("44px");
    expect(css).toContain("var(--ink-deep)");
    expect(css).toContain("var(--primary)");
    expect(css).toContain("var(--registry-cyan)");
    expect(css).toContain("26px");
    expect(css).toMatch(/(?:linear|radial)-gradient/u);
    expect(css).not.toMatch(/\d(?:vw|svw|lvw|dvw)/u);
  });
});
