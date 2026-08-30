import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import EditorialProofFigure from "@/components/site/EditorialProofFigure";
import SiteFooter from "@/components/site/SiteFooter";
import { EDITORIAL_VISUALS, getEditorialVisualForPath } from "@/lib/editorial-visuals";

vi.mock("next/navigation", () => ({
  usePathname: () => "/company",
}));

describe("editorial proof route selection", () => {
  test("falls back safely while router state is unavailable", () => {
    expect(getEditorialVisualForPath(null).id).toBe("seat-flow-service");
  });

  test.each([
    ["/company", "company-as-software"],
    ["/company/operations", "company-as-software"],
    ["/from-website", "website-grounded-service"],
    ["/launch", "draft-live-control"],
    ["/docs/reliability", "draft-live-control"],
    ["/security", "draft-live-control"],
    ["/pricing", "verified-product-inventory"],
    ["/agents", "verified-product-inventory"],
    ["/docs/nodes", "verified-product-inventory"],
    ["/rankings/best-ai-agent-builders", "verified-product-inventory"],
    ["/status", "verified-product-inventory"],
    ["/founder", "staff-company-sell-work"],
    ["/about", "staff-company-sell-work"],
    ["/articles/how-agents-get-paid", "staff-company-sell-work"],
    ["/templates/lead-qualifier", "seat-flow-service"],
    ["/a/sales-call-scorecard", "seat-flow-service"],
    ["/unmapped-public-page", "seat-flow-service"],
  ])("maps %s to %s", (pathname, expectedId) => {
    expect(getEditorialVisualForPath(pathname).id).toBe(expectedId);
  });

  test("renders product evidence as an accessible figure", () => {
    const markup = renderToStaticMarkup(
      <EditorialProofFigure visual={EDITORIAL_VISUALS["seat-flow-service"]} />,
    );

    expect(markup).toContain("<figure");
    expect(markup).toContain("<img");
    expect(markup).toContain(
      'alt="Three connected Agent Studio views showing one agent as an org-chart seat, a workflow, and a paid service endpoint."',
    );
    expect(markup).toContain("Seat, flow, service");
    expect(markup).toContain("The same agent as a seat, a flow, and a service.");
    expect(markup).toContain("<figcaption");
  });

  test("qualifies the inventory artwork as a dated snapshot", () => {
    const visual = getEditorialVisualForPath("/pricing");
    const markup = renderToStaticMarkup(<EditorialProofFigure visual={visual} />);

    expect(visual.id).toBe("verified-product-inventory");
    expect(markup).toContain("Snapshot · July 28, 2026");
    expect(markup).toContain("The catalog as it stood in July.");
    // The dated snapshot is a receipt: its label links to the live catalog.
    expect(markup).toContain('href="/agents"');
  });

  test("mounts route-aware product proof before the existing footer content", () => {
    const markup = renderToStaticMarkup(<SiteFooter />);
    const proofIndex = markup.indexOf('data-editorial-proof="company-as-software"');
    const footerContentIndex = markup.indexOf("lp-footer-inner");

    expect(proofIndex).toBeGreaterThan(-1);
    expect(footerContentIndex).toBeGreaterThan(proofIndex);
  });
});
