import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import StudioRecoveryBanner from "@/components/canvas/StudioRecoveryBanner";

describe("StudioRecoveryBanner", () => {
  it("offers explicit workflow graph recovery choices without claiming settings recovery", () => {
    const markup = renderToStaticMarkup(createElement(StudioRecoveryBanner, {
      state: "conflict", message: "A browser draft and saved workflow differ.",
      onSaveRecovered: vi.fn(), onDiscardRecovered: vi.fn(), onRecoverConflict: vi.fn(), onKeepSaved: vi.fn(),
    }));
    expect(markup).toContain("Workflow recovery");
    expect(markup).toContain("Recover browser workflow");
    expect(markup).toContain("Keep saved workflow");
    expect(markup).not.toMatch(/price|payout|wallet/i);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('class="studio-recovery-banner"');
    expect(markup).toContain('class="lp-btn lp-btn--primary lp-btn--sm"');
  });

  it("disables competing recovery choices while a save is settling", () => {
    const markup = renderToStaticMarkup(createElement(StudioRecoveryBanner, {
      state: "restored", message: "Recovered.", busy: true,
      onSaveRecovered: vi.fn(), onDiscardRecovered: vi.fn(), onRecoverConflict: vi.fn(), onKeepSaved: vi.fn(),
    }));
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain('aria-busy="true"');
  });
});
