import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PinnedReferenceBanner from "@/components/projects/PinnedReferenceBanner";

describe("PinnedReferenceBanner", () => {
  it("clearly separates an immutable parent pin from the editable current draft", () => {
    const markup = renderToStaticMarkup(createElement(PinnedReferenceBanner, {
      state: {
        kind: "ready",
        parentLabel: "Release workflow",
        versionLabel: "Version 7",
        contentHash: "b".repeat(64),
      },
    }));
    expect(markup).toContain("immutable version");
    expect(markup).toContain("Version 7");
    expect(markup).not.toContain("interface hash");
    expect(markup).toContain("content hash");
    expect(markup).toContain("current draft");
    expect(markup).not.toContain("undefined");
  });

  it.each(["loading", "empty", "error"] as const)("uses stable ID-free %s copy", (kind) => {
    const markup = renderToStaticMarkup(createElement(PinnedReferenceBanner, { state: { kind } }));
    expect(markup).not.toMatch(/flow:|version:|node:|raw error/i);
  });

  it("refuses a partial or drifted pin with generic copy", () => {
    const markup = renderToStaticMarkup(createElement(PinnedReferenceBanner, {
      state: {
        kind: "ready", parentLabel: "Parent", versionLabel: "Version 3",
        contentHash: "not-a-hash",
      },
    }));
    expect(markup).toContain("Pinned reference unavailable");
    expect(markup).not.toContain("Version 3");
  });
});
