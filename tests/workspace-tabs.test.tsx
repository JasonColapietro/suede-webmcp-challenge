import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...props }, children),
}));

import WorkspaceTabs from "@/components/workspace/WorkspaceTabs";

describe("WorkspaceTabs Resources entry", () => {
  it("keeps Resources in the operator strip with a 44px tab target", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceTabs, { active: "/resources" }));
    expect(markup).toContain('href="/resources"');
    expect(markup).toMatch(/href="\/resources"[^>]*aria-current="page"[^>]*>Resources</);
    expect(markup).toContain("New agent →");
  });
});
