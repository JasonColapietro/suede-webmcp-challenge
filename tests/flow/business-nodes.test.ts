import { describe, it, expect, vi } from "vitest";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { createNodeExecutionProvenance } from "@/lib/flow/executor";
import { createHttpExecutor } from "@/lib/flow/nodes/http";
import { NODE_DEFS } from "@/lib/flow/nodes";
import { NODE_META } from "@/lib/flow/node-meta";
import { createExtractTextExecutor } from "@/lib/flow/nodes/docs/extractText";
import { createExtractDocxExecutor } from "@/lib/flow/nodes/docs/extractDocx";
import { createParseSpreadsheetExecutor } from "@/lib/flow/nodes/data/parseSpreadsheet";
import { csvToRowObjects } from "@/lib/flow/nodes/data/csv";
import { createSlackMessageExecutor } from "@/lib/flow/nodes/comms/slackMessage";
import { createCrmWebhookExecutor } from "@/lib/flow/nodes/comms/crmWebhook";
import { createGithubIssueExecutor } from "@/lib/flow/nodes/devops/githubIssue";
import { createGithubWorkflowDispatchExecutor } from "@/lib/flow/nodes/devops/githubWorkflowDispatch";
import { createGenerateInvoicePdfExecutor } from "@/lib/flow/nodes/finance/generateInvoicePdf";
import { createFilterRowsExecutor } from "@/lib/flow/nodes/data/filterRows";
import { createGenerateSpreadsheetExecutor } from "@/lib/flow/nodes/data/generateSpreadsheet";
import { createGenerateReportPdfExecutor } from "@/lib/flow/nodes/docs/generateReportPdf";
import { makeCtx } from "../_helpers";

const publicLookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

const NEW_NODE_TYPES = [
  "docs.extractText",
  "docs.extractDocx",
  "data.parseSpreadsheet",
  "data.filterRows",
  "data.generateSpreadsheet",
  "docs.generateReportPdf",
  "comms.slackMessage",
  "comms.crmWebhook",
  "devops.githubIssue",
  "devops.githubWorkflowDispatch",
  "finance.generateInvoicePdf",
] as const;

describe("new business-node registration", () => {
  it("every new node is registered in the server executor list and client-safe meta", () => {
    for (const type of NEW_NODE_TYPES) {
      expect(NODE_DEFS.some((d) => d.type === type), type).toBe(true);
      expect(NODE_META.some((m) => m.type === type), type).toBe(true);
    }
  });
});

async function buildSamplePdf(text: string): Promise<Buffer> {
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));
  doc.text(text);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

describe("docs.extractText", () => {
  it("round-trips text through a real generated PDF", async () => {
    const pdf = await buildSamplePdf("Hello from a test invoice.");
    const executor = createExtractTextExecutor();
    const res = await executor(makeCtx(), { fileBase64: pdf.toString("base64") }, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toMatchObject({ pageCount: 1 });
      expect((res.outputs.result as { text: string }).text).toContain("Hello from a test invoice.");
    }
  });

  it("rejects invalid base64 without throwing", async () => {
    const executor = createExtractTextExecutor();
    const res = await executor(makeCtx(), { fileBase64: "not valid pdf bytes at all" }, {});
    expect(res.ok).toBe(false);
  });

  it("falls back to the upstream string input when fileBase64 is omitted", async () => {
    const pdf = await buildSamplePdf("From upstream.");
    const executor = createExtractTextExecutor();
    const res = await executor(makeCtx(), {}, { in: pdf.toString("base64") });
    expect(res.ok).toBe(true);
  });

  it("reads fileBase64 from a structured Input-node result", async () => {
    const pdf = await buildSamplePdf("From a structured input fixture.");
    const executor = createExtractTextExecutor();
    const res = await executor(makeCtx(), {}, {
      in: { fileBase64: pdf.toString("base64"), filename: "contract.pdf" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.outputs.result as { text: string }).text).toContain("structured input fixture");
    }
  });
});

describe("docs.extractDocx", () => {
  it("rejects invalid base64 without throwing", async () => {
    const executor = createExtractDocxExecutor();
    const res = await executor(makeCtx(), { fileBase64: "====not a docx====" }, {});
    expect(res.ok).toBe(false);
  });

  it("requires fileBase64 or an upstream string input", async () => {
    const executor = createExtractDocxExecutor();
    const res = await executor(makeCtx(), {}, {});
    expect(res.ok).toBe(false);
  });

  it("attempts the DOCX supplied by a structured Input-node result", async () => {
    const executor = createExtractDocxExecutor();
    const res = await executor(makeCtx(), {}, {
      in: { fileBase64: Buffer.from("not a docx", "utf8").toString("base64") },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Failed to parse DOCX");
  });
});

describe("data.parseSpreadsheet", () => {
  it("parses CSV bytes into row objects", async () => {
    const csv = "name,email\nAlice,alice@example.com\nBob,bob@example.com\n";
    const executor = createParseSpreadsheetExecutor();
    const res = await executor(
      makeCtx(),
      { fileBase64: Buffer.from(csv, "utf8").toString("base64"), format: "csv" },
      {},
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toEqual({
        rows: [
          { name: "Alice", email: "alice@example.com" },
          { name: "Bob", email: "bob@example.com" },
        ],
        rowCount: 2,
      });
    }
  });

  it("handles quoted fields with embedded commas", () => {
    const rows = csvToRowObjects('a,b\n"one, two",three\n');
    expect(rows).toEqual([{ a: "one, two", b: "three" }]);
  });

  it("round-trips rows through a real generated XLSX workbook", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["name", "amount"]);
    sheet.addRow(["Widget", 42]);
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;

    const executor = createParseSpreadsheetExecutor();
    const res = await executor(
      makeCtx(),
      { fileBase64: Buffer.from(buffer).toString("base64"), format: "xlsx" },
      {},
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.outputs.result as { rows: Record<string, unknown>[]; rowCount: number };
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]).toEqual({ name: "Widget", amount: 42 });
    }
  });

  it("rejects a file over the size cap", async () => {
    const executor = createParseSpreadsheetExecutor();
    const huge = Buffer.alloc(11 * 1024 * 1024, "a").toString("base64");
    const res = await executor(makeCtx(), { fileBase64: huge, format: "csv" }, {});
    expect(res.ok).toBe(false);
  });

  it("reads CSV bytes from a structured Input-node result", async () => {
    const csv = Buffer.from("segment,revenue\nEnterprise,42000\n", "utf8").toString("base64");
    const executor = createParseSpreadsheetExecutor();
    const res = await executor(makeCtx(), { format: "csv" }, { in: { fileBase64: csv } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toEqual({
        rows: [{ segment: "Enterprise", revenue: "42000" }],
        rowCount: 1,
      });
    }
  });
});

describe("data.filterRows", () => {
  it("filters, drops empty rows, deduplicates, projects, and stable-sorts", async () => {
    const executor = createFilterRowsExecutor();
    const res = await executor(makeCtx(), {
      filters: [{ field: "status", operator: "equals", value: "active" }],
      dropEmptyRows: true,
      dedupe: true,
      dedupeBy: ["email"],
      selectFields: ["email", "revenue"],
      sortBy: "revenue",
      sortDirection: "desc",
    }, { in: { rows: [
      { email: "low@example.com", status: "active", revenue: "12" },
      { email: "high@example.com", status: "active", revenue: "100" },
      { email: "high@example.com", status: "active", revenue: "100" },
      { email: "lead@example.com", status: "lead", revenue: "500" },
      { email: "", status: "", revenue: "" },
    ] } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toEqual({
        rows: [
          { email: "high@example.com", revenue: "100" },
          { email: "low@example.com", revenue: "12" },
        ],
        rowCount: 2,
        sourceRowCount: 5,
        filteredCount: 1,
        duplicateCount: 1,
        emptyCount: 1,
        truncatedCount: 0,
        appliedRules: {
          filters: [{ field: "status", operator: "equals", value: "active" }],
          dropEmptyRows: true,
          dedupe: true,
          dedupeBy: ["email"],
          selectFields: ["email", "revenue"],
          sortBy: "revenue",
          sortDirection: "desc",
          limit: 10_000,
        },
      });
    }
  });

  it("rejects data beyond the 100-column boundary", async () => {
    const wide = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`column_${index}`, index]));
    const res = await createFilterRowsExecutor()(makeCtx(), { rows: [wide] }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("100-column cap");
  });

  it("rejects unknown fields before dedupe or projection can silently destroy rows", async () => {
    const res = await createFilterRowsExecutor()(makeCtx(), {
      dedupe: true,
      dedupeBy: ["emali"],
      selectFields: ["name", "missing"],
    }, { in: { rows: [{ name: "Ada", email: "ada@example.com" }, { name: "Bo", email: "bo@example.com" }] } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Unknown row fields: emali, missing");
  });

  it("requires a filter value except for explicit empty checks", async () => {
    const res = await createFilterRowsExecutor()(makeCtx(), {
      rows: [{ status: "active" }],
      filters: [{ field: "status", operator: "contains" }],
    }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("contains requires a value");
  });

  it("rejects oversized and deeply nested cell data before serialization", async () => {
    const oversized = "x".repeat(32_001);
    const res = await createFilterRowsExecutor()(makeCtx(), { rows: [{ payload: oversized }] }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("32000-byte cap");
  });
});

describe("data.generateSpreadsheet", () => {
  it("generates a parseable XLSX and neutralizes formula-like strings", async () => {
    const executor = createGenerateSpreadsheetExecutor();
    const res = await executor(makeCtx(), { fileName: "contacts", sheetName: "Contacts" }, {
      in: { rows: [{ name: "Ada", email: "ada@example.com", note: "=HYPERLINK(\"https://bad.example\")" }] },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const result = res.outputs.result as {
      fileBase64: string;
      fileName: string;
      mimeType: string;
      rowCount: number;
      columnCount: number;
      byteCount: number;
    };
    expect(result).toMatchObject({
      fileName: "contacts.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      rowCount: 1,
      columnCount: 3,
    });
    expect(result.byteCount).toBeGreaterThan(100);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(result.fileBase64, "base64") as unknown as ArrayBuffer);
    expect(workbook.getWorksheet("Contacts")?.getCell("C2").value).toBe("'=HYPERLINK(\"https://bad.example\")");
  });

  it("requires at least one column", async () => {
    const res = await createGenerateSpreadsheetExecutor()(makeCtx(), { rows: [] }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("At least one data column");
  });

  it("keeps the final generated filename within the downloader boundary", async () => {
    const res = await createGenerateSpreadsheetExecutor()(makeCtx(), {
      rows: [{ ok: true }],
      fileName: "x".repeat(160),
    }, {});
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.outputs.result as { fileName: string }).fileName).toHaveLength(160);
  });
});

describe("docs.generateReportPdf", () => {
  it("generates a bounded PDF from structured sections", async () => {
    const executor = createGenerateReportPdfExecutor();
    const res = await executor(makeCtx(), {
      title: "Quarterly Review",
      fileName: "quarterly-review",
      sections: [
        { heading: "Summary", body: "Revenue increased while support volume stayed flat." },
        { heading: "Next step", body: "Verify the strongest segment before changing spend." },
      ],
    }, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const result = res.outputs.result as { fileBase64: string; fileName: string; mimeType: string; sectionCount: number; byteCount: number };
    expect(result).toMatchObject({ fileName: "quarterly-review.pdf", mimeType: "application/pdf", sectionCount: 2 });
    expect(Buffer.from(result.fileBase64, "base64").subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(result.byteCount).toBeGreaterThan(100);
  });

  it("derives report content from an upstream row-processing result", async () => {
    const res = await createGenerateReportPdfExecutor()(makeCtx(), { title: "Cleanup receipt" }, {
      in: { rowCount: 2, duplicateCount: 1, rows: [{ email: "a@example.com" }] },
    });
    expect(res.ok).toBe(true);
  });

  it("keeps configured identity fields when upstream data contains conflicting keys", async () => {
    const res = await createGenerateReportPdfExecutor()(makeCtx(), {
      title: "Configured title",
      fileName: "configured.pdf",
      sections: [{ heading: "Configured", body: "Trusted configured content" }],
    }, { in: {
      title: "Untrusted upstream title",
      fileName: "upstream.pdf",
      sections: [{ heading: "Upstream", body: "Must not replace configured sections" }],
    } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outputs.result).toMatchObject({ fileName: "configured.pdf", sectionCount: 1 });
  });

  it("keeps the final PDF filename within the downloader boundary", async () => {
    const res = await createGenerateReportPdfExecutor()(makeCtx(), {
      content: "bounded report",
      fileName: "x".repeat(160),
    }, {});
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.outputs.result as { fileName: string }).fileName).toHaveLength(160);
  });

  it("refuses an empty report", async () => {
    const res = await createGenerateReportPdfExecutor()(makeCtx(), {}, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("content or at least one report section");
  });
});

describe("comms.slackMessage", () => {
  it("refuses to run when webhookUrl is not bound to a secret", async () => {
    const executor = createSlackMessageExecutor();
    const res = await executor(makeCtx(), { text: "hello" }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("connection secret");
  });

  it("posts the interpolated text to the resolved webhook URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const httpExecutor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    const executor = createSlackMessageExecutor(httpExecutor);
    const provenance = createNodeExecutionProvenance({
      connection: {
        "X-Suede-Webhook-Url": "https://hooks.slack.com/services/T/B/X",
        Authorization: "Bearer must-not-forward",
      },
    });

    const res = await executor(makeCtx(), { text: "deploy of {{in.service}} finished" }, { in: { service: "api" } }, provenance);
    expect(res.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({ text: "deploy of api finished" });
  });
});

describe("comms.crmWebhook", () => {
  it("refuses to run when url is not bound to a secret", async () => {
    const executor = createCrmWebhookExecutor();
    const res = await executor(makeCtx(), { record: { email: "a@b.com" } }, {});
    expect(res.ok).toBe(false);
  });

  it("sends the record with a bearer token when both secrets are bound", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const httpExecutor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    const executor = createCrmWebhookExecutor(httpExecutor);
    const provenance = createNodeExecutionProvenance({ connection: {
      "X-Suede-Webhook-Url": "https://example.com/crm-webhook",
      Authorization: "Bearer sekret",
    } });

    const res = await executor(makeCtx(), { record: { email: "a@b.com" } }, {}, provenance);
    expect(res.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sekret");
    expect(JSON.parse(String(init.body))).toEqual({ email: "a@b.com" });
  });

  it("recursively interpolates the structured CRM record from upstream data", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const executor = createCrmWebhookExecutor(createHttpExecutor({ fetchFn, lookupFn: publicLookup }));
    const provenance = createNodeExecutionProvenance({ connection: {
      "X-Suede-Webhook-Url": "https://example.com/crm-webhook",
    } });

    const res = await executor(makeCtx(), {
      record: {
        email: "{{in.contact.email}}",
        score: "{{in.score}}",
        detail: { owner: "{{in.owner.name}}" },
        tags: ["qualified", "{{in.segment}}"],
      },
    }, {
      in: {
        contact: { email: "buyer@example.com" },
        score: 92,
        owner: { name: 'Morgan "Mo"' },
        segment: "enterprise",
      },
    }, provenance);

    expect(res.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      email: "buyer@example.com",
      score: "92",
      detail: { owner: 'Morgan "Mo"' },
      tags: ["qualified", "enterprise"],
    });
  });
});

describe("devops.githubIssue", () => {
  it("refuses an invalid repo shape", async () => {
    const executor = createGithubIssueExecutor();
    const provenance = createNodeExecutionProvenance({ connection: { Authorization: "Bearer ghp_x" } });
    const res = await executor(makeCtx(), { repo: "not-a-repo", action: "create", title: "t" }, {}, provenance);
    expect(res.ok).toBe(false);
  });

  it("builds the create-issue request against the GitHub REST API", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 201, headers: { "content-type": "application/json" } }));
    const httpExecutor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    const executor = createGithubIssueExecutor(httpExecutor);
    const provenance = createNodeExecutionProvenance({ connection: { Authorization: "Bearer ghp_x" } });

    const res = await executor(
      makeCtx(),
      { repo: "acme/widgets", action: "create", title: "Bug found", body: "details" },
      {},
      provenance,
    );
    expect(res.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/issues");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghp_x");
    expect(JSON.parse(String(init.body))).toEqual({ title: "Bug found", body: "details" });
  });

  it("builds the comment request when action is comment", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 201, headers: { "content-type": "application/json" } }));
    const httpExecutor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    const executor = createGithubIssueExecutor(httpExecutor);
    const provenance = createNodeExecutionProvenance({ connection: { Authorization: "Bearer ghp_x" } });

    const res = await executor(
      makeCtx(),
      { repo: "acme/widgets", action: "comment", issueNumber: 42, body: "still open" },
      {},
      provenance,
    );
    expect(res.ok).toBe(true);
    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/issues/42/comments");
  });
});

describe("devops.githubWorkflowDispatch", () => {
  it("rejects a workflow filename containing a path separator", async () => {
    const executor = createGithubWorkflowDispatchExecutor();
    const provenance = createNodeExecutionProvenance({ connection: { Authorization: "Bearer ghp_x" } });
    const res = await executor(
      makeCtx(),
      { repo: "acme/widgets", workflowFile: "../../etc/passwd", ref: "main" },
      {},
      provenance,
    );
    expect(res.ok).toBe(false);
  });

  it("builds the dispatch request against the GitHub REST API", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const httpExecutor = createHttpExecutor({ fetchFn, lookupFn: publicLookup });
    const executor = createGithubWorkflowDispatchExecutor(httpExecutor);
    const provenance = createNodeExecutionProvenance({ connection: { Authorization: "Bearer ghp_x" } });

    const res = await executor(
      makeCtx(),
      { repo: "acme/widgets", workflowFile: "deploy.yml", ref: "main", inputs: { env: "prod" } },
      {},
      provenance,
    );
    expect(res.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/actions/workflows/deploy.yml/dispatches");
    expect(JSON.parse(String(init.body))).toEqual({ ref: "main", inputs: { env: "prod" } });
  });

  it("recursively interpolates workflow inputs from the upstream result", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const executor = createGithubWorkflowDispatchExecutor(createHttpExecutor({ fetchFn, lookupFn: publicLookup }));
    const provenance = createNodeExecutionProvenance({ connection: { Authorization: "Bearer ghp_x" } });

    const res = await executor(
      makeCtx(),
      {
        repo: "acme/widgets",
        workflowFile: "release.yml",
        ref: "{{in.branch}}",
        inputs: {
          version: "{{in.release.version}}",
          flags: ["announce", "{{in.release.channel}}"],
        },
      },
      { in: { branch: "main", release: { version: 'v2.4.0+"safe"', channel: "stable" } } },
      provenance,
    );

    expect(res.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      ref: "main",
      inputs: { version: 'v2.4.0+"safe"', flags: ["announce", "stable"] },
    });
  });
});

describe("finance.generateInvoicePdf", () => {
  it("computes the total and returns a real PDF", async () => {
    const executor = createGenerateInvoicePdfExecutor();
    const res = await executor(
      makeCtx(),
      {
        invoiceNumber: "INV-1",
        sellerName: "Acme Consulting",
        buyerName: "Client Co",
        lineItems: [
          { description: "Consulting", quantity: 5, unitPrice: 120 },
          { description: "Travel", quantity: 1, unitPrice: 60 },
        ],
      },
      {},
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.outputs.result as { fileBase64: string; fileName: string; mimeType: string; byteCount: number; totalAmount: number };
      expect(result.totalAmount).toBe(660);
      expect(result).toMatchObject({ fileName: "invoice-INV-1.pdf", mimeType: "application/pdf" });
      expect(result.byteCount).toBeGreaterThan(100);
      const buffer = Buffer.from(result.fileBase64, "base64");
      expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
    }
  });

  it("rejects an empty line-item list", async () => {
    const executor = createGenerateInvoicePdfExecutor();
    const res = await executor(
      makeCtx(),
      { invoiceNumber: "INV-2", sellerName: "A", buyerName: "B", lineItems: [] },
      {},
    );
    expect(res.ok).toBe(false);
  });

  it("lets a structured upstream invoice override editable defaults", async () => {
    const executor = createGenerateInvoicePdfExecutor();
    const res = await executor(
      makeCtx(),
      {
        invoiceNumber: "DEFAULT",
        sellerName: "Acme Consulting",
        buyerName: "Default buyer",
        lineItems: [{ description: "Default item", quantity: 1, unitPrice: 1 }],
      },
      {
        in: {
          invoiceNumber: "INV-UPSTREAM",
          buyerName: "Upstream Client",
          lineItems: [{ description: "Strategy", quantity: 3, unitPrice: 250 }],
        },
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.outputs.result as { totalAmount: number }).totalAmount).toBe(750);
    }
  });
});
