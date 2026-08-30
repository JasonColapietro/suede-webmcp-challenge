import { describe, expect, it } from "vitest";
import { collectRun, runFlow } from "@/lib/flow/engine";
import { getRegistry } from "@/lib/flow/registry";
import { getTemplate } from "@/lib/templates";
import { buildTemplateSummaries } from "@/lib/template-summaries";
import { makeCtx } from "../_helpers";

const FLAGSHIP_NODE_TYPES = {
  "spreadsheet-cleanup-dedupe": ["input", "data.parseSpreadsheet", "data.filterRows", "data.generateSpreadsheet"],
  "spreadsheet-quality-report": ["input", "data.parseSpreadsheet", "data.filterRows", "docs.generateReportPdf"],
  "csv-to-xlsx-converter": ["input", "data.parseSpreadsheet", "data.generateSpreadsheet"],
  "contract-redflag-scan": ["input", "docs.extractText", "llm", "output"],
  "contract-term-extractor": ["input", "docs.extractDocx", "llm", "output"],
  "data-analysis-agent": ["input", "data.parseSpreadsheet", "llm", "output"],
  "invoice-field-extractor": ["input", "finance.generateInvoicePdf", "output"],
  "lead-qualifier": ["input", "llm", "comms.crmWebhook", "output"],
  "call-notes-to-crm": ["input", "llm", "comms.crmWebhook", "output"],
  "support-ticket-triage": ["input", "llm", "comms.slackMessage", "output"],
  "daily-ops-digest": ["schedule", "llm", "comms.slackMessage", "output"],
  "incident-postmortem-draft": ["input", "llm", "devops.githubIssue", "output"],
  "pr-diff-digest": ["input", "llm", "devops.githubIssue", "output"],
  "release-notes-writer": ["input", "llm", "devops.githubWorkflowDispatch", "output"],
  "review-responder": ["input", "branch", "llm", "comms.slackMessage", "output", "output"],
} as const;

describe("flagship business template workflows", () => {
  it("uses the intended local-work and action nodes instead of one-call placeholders", () => {
    for (const [slug, expectedTypes] of Object.entries(FLAGSHIP_NODE_TYPES)) {
      const template = getTemplate(slug);
      expect(template, `${slug} missing`).toBeDefined();
      expect(template!.graph.nodes.map((node) => node.type), slug).toEqual(expectedTypes);
      expect(JSON.stringify(template!.graph), `${slug} must not contain a connection id`)
        .not.toMatch(/connectionId|authorization|bearer\s+[A-Za-z0-9]/iu);
    }
  });

  it("ships deterministic non-secret starter input for every input-triggered flagship", () => {
    for (const slug of Object.keys(FLAGSHIP_NODE_TYPES)) {
      const template = getTemplate(slug)!;
      const input = template.graph.nodes.find((node) => node.type === "input");
      if (!input) continue;
      expect(input.params.fields, `${slug} needs a useful preview fixture`).toBeTypeOf("object");
      expect(Object.keys(input.params.fields as object).length, `${slug} fixture is empty`).toBeGreaterThan(0);
    }
  });

  it("shows the business-work nodes as distinct colored steps in the template gallery", () => {
    const summaries = new Map(buildTemplateSummaries().map((summary) => [summary.slug, summary]));
    for (const [slug, expectedTypes] of Object.entries(FLAGSHIP_NODE_TYPES)) {
      const summary = summaries.get(slug)!;
      expectedTypes.forEach((type, index) => {
        if (type === "input" || type === "output") return;
        expect(summary.dots[index], `${slug} ${type} is visually collapsed`).not.toBe("var(--text-muted)");
      });
    }
  });

  it("previews all fifteen end to end with no provider cost or external side effect", async () => {
    for (const slug of Object.keys(FLAGSHIP_NODE_TYPES)) {
      const template = getTemplate(slug)!;
      const summary = await collectRun(runFlow(template.graph, makeCtx(), getRegistry(), {}));
      expect(summary.status, slug).toBe("done");
      expect(summary.totalCostUsdc, slug).toBe(0);
      const sourceIds = new Set(template.graph.edges.map((edge) => edge.source));
      const terminalIds = template.graph.nodes.filter((node) => !sourceIds.has(node.id)).map((node) => node.id);
      expect(terminalIds.some((id) => Object.hasOwn(summary.outputs, id)), `${slug} has no observable terminal output`)
        .toBe(true);
    }
  }, 30_000);
});
