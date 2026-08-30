import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SITE_URL } from "@/lib/site";
import { RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";

const rootAgentCardRoute = await import("@/app/.well-known/agent-card.json/route");
const aiPluginRoute = await import("@/app/.well-known/ai-plugin.json/route");
const publicOpenApiRoute = await import("@/app/openapi.json/route");

async function optionalImport<T>(specifier: string): Promise<T | null> {
  try {
    return await import(specifier) as T;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error.message.includes("Cannot find module") || error.message.includes("Failed to load url"))
    ) {
      return null;
    }
    throw error;
  }
}

describe("non-ranking route metadata", () => {
  it("noindexes owner and builder routes while stripping query strings from canonicals", async () => {
    const seo = await optionalImport<{
      noIndexFollowMetadata: (canonical: string) => {
        alternates?: { canonical?: string };
        robots?: { index?: boolean; follow?: boolean; googleBot?: { index?: boolean; follow?: boolean } };
      };
    }>("@/lib/seo-metadata");
    expect(seo).not.toBeNull();
    if (!seo) return;

    expect(seo.noIndexFollowMetadata("/build/new?template=lead-qualifier")).toEqual({
      alternates: { canonical: "/build/new" },
      robots: {
        index: false,
        follow: true,
        googleBot: { index: false, follow: true },
      },
    });

    const buildLayout = await optionalImport<{
      generateMetadata: (input: { params: Promise<{ flowId: string }> }) => Promise<unknown>;
    }>("@/app/build/[flowId]/layout");
    const flowsLayout = await optionalImport<{ metadata: unknown }>("@/app/flows/layout");
    const portfolioLayout = await optionalImport<{ metadata: unknown }>("@/app/portfolio/layout");
    const portfolioDetailLayout = await optionalImport<{
      generateMetadata: (input: { params: Promise<{ id: string }> }) => Promise<unknown>;
    }>("@/app/portfolio/[id]/layout");

    expect(buildLayout).not.toBeNull();
    expect(flowsLayout).not.toBeNull();
    expect(portfolioLayout).not.toBeNull();
    expect(portfolioDetailLayout).not.toBeNull();
    if (!buildLayout || !flowsLayout || !portfolioLayout || !portfolioDetailLayout) return;

    expect(await buildLayout.generateMetadata({ params: Promise.resolve({ flowId: "new" }) }))
      .toMatchObject({
        alternates: { canonical: "/build/new" },
        robots: { index: false, follow: true },
      });
    expect(flowsLayout.metadata).toMatchObject({
      alternates: { canonical: "/flows" },
      robots: { index: false, follow: true },
    });
    expect(portfolioLayout.metadata).toMatchObject({
      alternates: { canonical: "/portfolio" },
      robots: { index: false, follow: true },
    });
    expect(await portfolioDetailLayout.generateMetadata({ params: Promise.resolve({ id: "agent/unsafe" }) }))
      .toMatchObject({
        alternates: { canonical: "/portfolio/agent%2Funsafe" },
        robots: { index: false, follow: true },
      });
  });

  it("keeps public durable route metadata indexable", async () => {
    const [rootLayout, agentsPage] = await Promise.all([
      readFile(new URL("../src/app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/app/agents/page.tsx", import.meta.url), "utf8"),
    ]);
    expect(rootLayout).toContain("robots: {");
    expect(rootLayout).toContain("index: true");
    expect(rootLayout).toContain("follow: true");
    expect(agentsPage).toContain('alternates: { canonical: "/agents" }');
    expect(agentsPage).not.toContain("noIndexFollowMetadata");
    expect(agentsPage).not.toContain("index: false");
  });
});

describe("root machine discovery", () => {
  it("publishes a live-catalog agent card at the conventional JSON route", async () => {
    const response = await rootAgentCardRoute.GET();
    const body = await response.json() as {
      name: string;
      supportedInterfaces: Array<Record<string, unknown>>;
      skills: unknown[];
      "x-suede": {
        site: string;
        catalog: string;
        curatedServices: string;
        x402: string;
        openapi: string;
        count: number;
        agents: unknown[];
      };
    };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      name: "Suede Agent Studio",
      version: "1.0.0",
      supportedInterfaces: [{ protocolBinding: "MCP" }],
      provider: { organization: "Suede Labs AI" },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      "x-suede": {
        site: SITE_URL,
        catalog: `${SITE_URL}/api/catalog`,
        curatedServices: `${SITE_URL}/api/services`,
        x402: `${SITE_URL}/.well-known/x402`,
        openapi: `${SITE_URL}/openapi.json`,
      },
    });
    expect(body["x-suede"].count).toBe(body["x-suede"].agents.length);
    expect(body.skills).toHaveLength(body["x-suede"].count);
  });

  it("points machine callers at the MCP endpoint and the machine-payable topup", async () => {
    // A crawler that finds only the run routes cannot FUND a call. The card
    // must link the working billing path end to end: MCP endpoint plus the
    // x402 topup that fills the workspace credit MCP tools bill against.
    const response = await rootAgentCardRoute.GET();
    const body = await response.json() as {
      "x-suede": {
        mcp: string;
        funding: { topup: string; cardCheckout: string; rail: string };
      };
    };
    expect(body["x-suede"].mcp).toBe(`${SITE_URL}/api/mcp`);
    expect(body["x-suede"].funding).toMatchObject({
      topup: `${SITE_URL}/api/gateway/topup`,
      cardCheckout: `${SITE_URL}/api/gateway/topup/stripe`,
      rail: "x402",
    });
  });

  it("publishes an AI plugin manifest that points to the same canonical OpenAPI contract", async () => {
    const response = await aiPluginRoute.GET();
    const body = await response.json() as Record<string, unknown> & {
      api: { type: string; url: string; is_user_authenticated: boolean };
      auth: { type: string };
    };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      schema_version: "v1",
      name_for_human: "Suede Agent Studio",
      name_for_model: "suede_agent_studio",
      auth: { type: "none" },
      api: {
        type: "openapi",
        url: `${SITE_URL}/openapi.json`,
        is_user_authenticated: false,
      },
      logo_url: `${SITE_URL}/icon`,
      contact_email: "support@suedeai.ai",
      legal_info_url: "https://suedeai.ai/privacy",
    });
  });

  it("describes only the current public discovery and run routes in OpenAPI 3.1", async () => {
    const response = await publicOpenApiRoute.GET();
    const body = await response.json() as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, Record<string, unknown>> };
      "x-suede-resource-contracts": { extensionUri: string; contracts: unknown[] };
    };
    expect(response.status).toBe(200);
    expect(body.openapi).toBe("3.1.0");
    expect(body.servers).toEqual([{ url: SITE_URL }]);
    // DELIBERATE pin update (2026-08-09, machine distribution): /api/mcp and
    // /api/gateway/topup join the public contract so a crawler reading only
    // openapi.json can find the MCP tool surface AND the endpoint that funds
    // it. Both routes already existed; the contract was just silent on them.
    expect(Object.keys(body.paths).sort()).toEqual([
      "/.well-known/agent-card.json",
      "/.well-known/x402",
      "/api/agents/{agent}/.well-known/agent-card.json",
      "/api/agents/{agent}/.well-known/x402",
      "/api/agents/{agent}/a2a",
      "/api/agents/{agent}/a2a/message:send",
      "/api/agents/{agent}/a2a/message:stream",
      "/api/agents/{agent}/a2a/tasks",
      "/api/agents/{agent}/a2a/tasks/{taskId}",
      "/api/agents/{agent}/a2a/tasks/{taskId}:cancel",
      "/api/agents/{agent}/run",
      "/api/agents/{agent}/template",
      "/api/catalog",
      "/api/gateway/topup",
      "/api/mcp",
      "/api/services",
    ].sort());
    expect(body.paths["/api/mcp"]?.post).toBeDefined();
    expect(body.paths["/api/gateway/topup"]?.post).toBeDefined();
    expect(body.paths["/api/services"]?.get).toBeDefined();
    expect(body.paths["/api/agents/{agent}/a2a/message:send"]?.post).toBeDefined();
    expect(body.paths["/api/agents/{agent}/run"]?.post).toBeDefined();
    expect(body.paths["/api/me"]).toBeUndefined();
    expect(body.paths["/api/flows"]).toBeUndefined();
    expect(body["x-suede-resource-contracts"].extensionUri).toBe(
      RESOURCE_CONTRACT_EXTENSION_URI,
    );
    expect(body.components.schemas.ResourceRunEnvelope).toMatchObject({
      required: ["result", "resourceReceipt", "payment"],
      properties: {
        payment: {
          properties: {
            state: {
              enum: ["free", "challenged", "credited", "settled", "refunded", "failed"],
            },
          },
        },
      },
    });
  });
});

describe("public claim boundaries", () => {
  it("links AI assistants to each conventional root discovery document", async () => {
    const llms = await readFile(new URL("../public/llms.txt", import.meta.url), "utf8");
    expect(llms).toContain("https://agents.suedeai.ai/.well-known/agent-card.json");
    expect(llms).toContain("https://agents.suedeai.ai/.well-known/ai-plugin.json");
    expect(llms).toContain("https://agents.suedeai.ai/openapi.json");
    // The one billing path that works today must be findable from llms.txt:
    // the MCP tool surface plus the machine-payable credit topup behind it.
    expect(llms).toContain("https://agents.suedeai.ai/api/mcp");
    expect(llms).toContain("https://agents.suedeai.ai/api/gateway/topup");
    expect(llms).toContain("https://agents.suedeai.ai/api/services");
    expect(llms).toContain("https://agents.suedeai.ai/api/agents/<slug>/a2a/message:send");
    expect(llms).toContain(RESOURCE_CONTRACT_EXTENSION_URI);
    expect(llms).toContain("credited");
  });

  it("does not assert the disputed subsidiary relationship or JCIG founding year", async () => {
    const llms = await readFile(new URL("../public/llms.txt", import.meta.url), "utf8");
    expect(llms).not.toMatch(/Suede Labs AI is a subsidiary of JC Investment Group LLC/i);
    expect(llms).not.toMatch(/JC Investment Group LLC[^\n]*founded 2016/i);
    expect(llms).toMatch(
      /verify legal structure and formation\s+claims against current company records/i,
    );
    expect(llms).not.toMatch(/Forbes contributor/i);

    const layout = await readFile(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
    const founder = await readFile(
      new URL("../src/app/founder/page.tsx", import.meta.url),
      "utf8",
    );
    expect(layout).not.toMatch(
      /parentOrganization|foundingDate:\s*["']2016["']|Forbes contributor/i,
    );
    expect(founder).not.toMatch(/Forbes contributor/i);
  });
});

describe("indexable page discovery", () => {
  it("keeps every audited public route in the sitemap and crawl graph", async () => {
    const [sitemap, footer, templates, featuredPages] = await Promise.all([
      readFile(new URL("../src/app/sitemap.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/components/site/SiteFooter.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/app/templates/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/lib/featured-templates.ts", import.meta.url), "utf8"),
    ]);

    const activeRoutes = [
      "/compare/gumloop-alternative",
      "/pricing",
      "/rankings/best-ai-agent-builders",
      "/templates",
      "/templates/grade-rebuilder",
      "/templates/competitor-tracker",
      "/templates/invoice-chaser",
      "/templates/lead-qualifier",
      "/templates/review-responder",
      "/x402-agent-builder",
    ];

    for (const route of activeRoutes) {
      expect(sitemap).toContain(`\${SITE_URL}${route}`);
    }

    expect(footer).toContain('href="/x402-agent-builder"');
    // The hub links every detail page through the derived featured cards:
    // hrefs render as /templates/${t.route}, with routes enumerated in
    // FEATURED_TEMPLATE_PAGES. Both halves of that chain stay pinned here.
    expect(templates).toContain("href={`/templates/${t.route}`}");
    for (const route of activeRoutes.filter((route) => route.startsWith("/templates/"))) {
      expect(featuredPages).toContain(`route: "${route.replace("/templates/", "")}"`);
    }
  });

  it("does not reintroduce retired agent slugs into the sitemap", async () => {
    const sitemap = await readFile(new URL("../src/app/sitemap.ts", import.meta.url), "utf8");
    expect(sitemap).not.toContain("daily-lyric-drop-s4f7x");
    expect(sitemap).not.toContain("the-ownership-loop-dwbjc");
  });
});
