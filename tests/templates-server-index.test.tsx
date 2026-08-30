import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TemplatesPage from "@/app/templates/page";
import { listTemplateDetailPageSlugs } from "@/lib/template-summaries";

describe("server-rendered template index", () => {
  it("links every derived detail page in the raw templates HTML", () => {
    const html = renderToStaticMarkup(<TemplatesPage />);
    const hrefs = new Set(
      Array.from(html.matchAll(/href="([^"]+)"/g), (match) => match[1]),
    );

    const detailSlugs = listTemplateDetailPageSlugs();
    expect(detailSlugs.length).toBeGreaterThan(0);
    for (const slug of detailSlugs) {
      expect(hrefs, `missing server-rendered link for ${slug}`).toContain(`/templates/${slug}`);
    }

    expect(html).toContain("The full catalog");
  });
});
