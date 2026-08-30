import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GET as templatesGet } from "@/app/api/templates/route";
import { runFallbackTurn, type ConversationTurn } from "@/lib/guided/draft";
import { buildTemplateSummaries } from "@/lib/template-summaries";

// Lifted 2026-08-04: the Registry is live at ip.suedeai.ai, so these are
// publicly discoverable again. Nothing is held right now.
const LIFTED_TEMPLATE_SLUGS = [
  "song-register-royalty",
] as const;

describe("Registry marketing hold", () => {
  it("publishes the lifted Registry workflows in template cards and the public list", async () => {
    const cardSlugs = buildTemplateSummaries().map((template) => template.slug);
    const response = await templatesGet(
      new Request("https://agents.suedeai.ai/api/templates"),
    );
    const body = await response.json() as {
      templates: Array<{ slug: string }>;
    };
    const apiSlugs = body.templates.map((template) => template.slug);

    for (const slug of LIFTED_TEMPLATE_SLUGS) {
      expect(cardSlugs).toContain(slug);
      expect(apiSlugs).toContain(slug);
    }
  });

  it("can recommend a Registry workflow through Guided fallback", async () => {
    const messages = [
      "generate a song and register my IP",
      "Creator workflow",
      "on demand",
      "0.20",
    ];
    const history: ConversationTurn[] = [];
    let selectedTemplate: string | undefined;

    for (const message of messages) {
      const response = await runFallbackTurn(message, history);
      history.push({ role: "user", content: message });
      if (response.clarifyingQuestion !== null) {
        history.push({
          role: "assistant",
          content: response.clarifyingQuestion,
        });
      }
      if (response.manifest !== null) {
        selectedTemplate = response.manifest.meta.template;
        break;
      }
    }

    // Guided still has to converge on something; it is simply no longer
    // forbidden from landing on a Registry workflow.
    expect(selectedTemplate).toBeDefined();
  });

  it("keeps Registry workflow availability separate from public App routes", async () => {
    const { isPublicTemplateMarketingAllowed, isPublicEndpointMarketingAllowed } =
      await import("@/lib/marketing-holds");

    for (const slug of LIFTED_TEMPLATE_SLUGS) {
      expect(isPublicTemplateMarketingAllowed(slug)).toBe(true);
    }
    expect(isPublicEndpointMarketingAllowed("rightsLookup")).toBe(false);
    expect(isPublicEndpointMarketingAllowed("chainChat")).toBe(false);
  });

  it("removes active Registry claims from public marketing source files", async () => {
    const publicSources = await Promise.all([
      "public/llms.txt",
      "src/app/page.tsx",
      "src/app/layout.tsx",
      "src/app/founder/page.tsx",
      "src/app/docs/page.tsx",
      "src/app/docs/overview/page.tsx",
      "src/app/fit/page.tsx",
      "src/components/landing/Faq.tsx",
    ].map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")));
    const combined = publicSources.join("\n");

    expect(combined).not.toMatch(
      /programmable IP|royalty routing|rights metadata|IP[- ]registry|register IP|on-chain registry|registry attestation|rights-registry/i,
    );
  });
});
