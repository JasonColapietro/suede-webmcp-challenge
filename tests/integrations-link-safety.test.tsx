import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntegrationsPage, { metadata } from "@/app/integrations/page";

describe("integrations endpoint links", () => {
  it("labels the POST-only MCP endpoint without linking browsers to a GET 405", () => {
    const html = renderToStaticMarkup(<IntegrationsPage />);
    expect(html).toContain("POST /api/mcp");
    expect(html).not.toMatch(/<a[^>]+href="\/api\/mcp"/);
    expect(html).toMatch(/<a[^>]+href="\/docs\/mcp"/);
  });

  it("labels Agentic.Market as automatic with no manual registration claim", () => {
    const html = renderToStaticMarkup(<IntegrationsPage />);
    const agenticMarket = html.slice(html.indexOf("Agentic.Market"));

    expect(agenticMarket).toContain("auto");
    expect(agenticMarket).toContain("No manual registration.");
    expect(agenticMarket).not.toContain("Send the generated outreach");
  });

  it("uses the reviewed search-result description", () => {
    expect(metadata.description).toBe(
      "See how Suede Agent Studio implements x402, AP2, A2A, MCP, WebMCP, and AgentCash discovery, with dated receipts and live verification paths.",
    );
  });
});
