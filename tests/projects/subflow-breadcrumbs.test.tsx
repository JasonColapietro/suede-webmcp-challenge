import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SubflowBreadcrumbs from "@/components/projects/SubflowBreadcrumbs";

describe("SubflowBreadcrumbs", () => {
  it.each([
    ["loading", "Loading flow trail"],
    ["empty", "Opened directly"],
    ["error", "Flow trail unavailable"],
  ] as const)("renders one ID-free accessible nav for %s", (kind, copy) => {
    const markup = renderToStaticMarkup(createElement(SubflowBreadcrumbs, { state: { kind } }));
    expect(markup.match(/<nav/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Flow trail breadcrumb"');
    expect(markup).toContain(copy);
    expect(markup).not.toMatch(/flow:|version:|node:/);
  });

  it("renders one responsive full trail with native keyboard links, 44px targets, and current last", () => {
    const onNavigate = vi.fn();
    const markup = renderToStaticMarkup(createElement(SubflowBreadcrumbs, {
      state: {
        kind: "ready",
        items: [
          { flowId: "flow a", label: "Parent workflow" },
          { flowId: "flow/b", label: "Reusable step" },
          { flowId: "flow:current", label: "Current workflow", current: true },
        ],
      },
      onNavigate,
    }));
    expect(markup.match(/<nav/g)).toHaveLength(1);
    expect(markup.match(/<ol/g)).toHaveLength(1);
    expect(markup.match(/<a /g)).toHaveLength(2);
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("min-height:44px");
    expect(markup).toContain("overflow-x:auto");
    expect(markup).toContain('href="/build/flow%20a"');
    expect(markup).toContain('href="/build/flow%2Fb"');
  });

  it("refuses an invalid display trail with generic copy", () => {
    const markup = renderToStaticMarkup(createElement(SubflowBreadcrumbs, {
      state: { kind: "ready", items: [
        { flowId: "same", label: "One" },
        { flowId: "same", label: "Two", current: true },
      ] },
    }));
    expect(markup).toContain("Flow trail unavailable");
    expect(markup).not.toContain("One");
  });

  it("never accepts caller-controlled javascript, external, protocol-relative, or malformed hrefs", () => {
    const markup = renderToStaticMarkup(createElement(SubflowBreadcrumbs, {
      state: { kind: "ready", items: [
        { flowId: "javascript:alert(1)", label: "Script", href: "javascript:alert(1)" },
        { flowId: "//evil.example/path", label: "Protocol", href: "//evil.example/path" },
        { flowId: "https://evil.example", label: "External", href: "https://evil.example" },
        { flowId: "current", label: "Current", current: true, href: "%" },
      ] as never },
    }));
    expect(markup).not.toMatch(/href="(?:javascript:|https?:|\/\/)/);
    expect(markup).toContain('href="/build/javascript%3Aalert(1)"');
    expect(markup).toContain('href="/build/%2F%2Fevil.example%2Fpath"');
    expect(markup).toContain('href="/build/https%3A%2F%2Fevil.example"');
  });
});
