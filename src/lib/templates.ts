/**
 * Seed flow templates: each one a tiny business, not a tech demo. Every
 * template is a fully-built FlowGraph that launches into a priced, sellable
 * x402 endpoint in under a minute; the scheduled ones run on their own.
 *
 * General-first: the catalog leads with the workflows real operators and agents
 * pay for per call (contract triage, screening, AP gates, RevOps, dev ops)
 * with the creator showcases kept as a focused tail. Every llm template wires
 * the caller's payload into the prompt via {{in}}, so the agent actually reads
 * what it's handed. Graphs are laid out left-to-right (x in ~240 steps, y
 * centered ~120) so they render cleanly in the canvas.
 */
import type { FlowGraph } from "./flow/types";

export interface SeedTemplate {
  slug: string;
  name: string;
  /** The one-line money frame shown on cards. */
  pitch: string;
  /** Longer copy for the template detail / gallery. */
  description: string;
  /** Who pays per call and why: the one-line demand frame shown on cards. */
  whoPays: string;
  /** Pre-loads the studio price field so launch = priced. */
  suggestedPriceUsdc: number;
  /** Template category for gallery filtering. */
  category: "business" | "personal" | "creator";
  /**
   * Department sub-classification within "business" (Make/Zapier-style
   * department browsing). Undefined for personal/creator templates.
   */
  department?: "Sales" | "Marketing" | "Finance" | "Support" | "Legal" | "HR" | "Engineering" | "Ops";
  graph: FlowGraph;
}

const ROW_Y = 120;
const COL = 240;

function col(index: number): number {
  return 80 + index * COL;
}

/**
 * input → llm → output : the canonical "caller pastes raw data, agent returns
 * structured intelligence" shape. The prompt must reference {{in}} so the
 * caller's payload is actually interpolated into the model call.
 *
 * `inputFields` is required, not optional, and that is the point. Its keys are
 * the agent's published input contract: `deriveInputSchema` turns them into the
 * JSON Schema an MCP client reads before calling the tool, and an input node
 * with no authored fields derives a bare `{ type: "object" }` that tells a
 * calling model nothing. Because the MCP billing path debits the caller before
 * the run, an unnamed contract makes every wrong guess a paid round trip. A
 * required parameter means a new template cannot ship without one.
 *
 * Field names must match what the flow actually reads. Defaults are empty
 * (`""`, `[]`) rather than sample data: the input node merges its defaults
 * under the live payload, so a realistic-looking default would silently bill a
 * caller for an analysis of fixture data when they omit a field.
 */
function llmAgent(
  id: string,
  name: string,
  llmParams: { prompt: string; system?: string },
  outputLabel: string,
  inputFields: Readonly<Record<string, unknown>>,
): FlowGraph {
  return {
    id,
    name,
    nodes: [
      { id: "n1", type: "input", params: { fields: inputFields }, position: { x: col(0), y: ROW_Y } },
      { id: "n2", type: "llm", params: llmParams, position: { x: col(1), y: ROW_Y } },
      { id: "n3", type: "output", params: { label: outputLabel }, position: { x: col(2), y: ROW_Y } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
      { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    ],
  };
}

/**
 * schedule → llm → output : a self-running brief/digest on a cron. The schedule
 * node forwards the trigger payload, so {{in}} in the prompt resolves to the
 * data fed at run time.
 *
 * `inputFields` is required for the same reason it is on `llmAgent`: a cron is
 * not the only way these run. A published scheduled agent is also a callable
 * MCP tool, and its keys are the contract that tool advertises. Leaving them
 * unnamed publishes a schema a calling model cannot act on.
 */
function scheduledLlmAgent(
  id: string,
  name: string,
  cron: string,
  llmParams: { prompt: string; system?: string },
  outputLabel: string,
  inputFields: Readonly<Record<string, unknown>>,
): FlowGraph {
  return {
    id,
    name,
    nodes: [
      { id: "n1", type: "schedule", params: { cron, fields: inputFields }, position: { x: col(0), y: ROW_Y } },
      { id: "n2", type: "llm", params: llmParams, position: { x: col(1), y: ROW_Y } },
      { id: "n3", type: "output", params: { label: outputLabel }, position: { x: col(2), y: ROW_Y } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
      { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    ],
  };
}

interface FlagshipStep {
  readonly type: FlowGraph["nodes"][number]["type"];
  readonly params: Record<string, unknown>;
}

/**
 * Wraps a three-node draft with extra steps around its llm. Input fields are
 * deliberately NOT an option here: the draft's own trigger node is the single
 * place a template's input contract is authored, so there is no second path
 * that can drift out of sync with the prompt that reads it.
 */
function flagshipAgent(
  draft: FlowGraph,
  options: {
    readonly beforeLlm?: FlagshipStep;
    readonly afterLlm?: FlagshipStep;
  },
): FlowGraph {
  const [trigger, llm, output] = draft.nodes;
  if (!trigger || !llm || !output || draft.nodes.length !== 3) {
    throw new Error(`Flagship draft ${draft.id} must be a three-node agent`);
  }
  const steps = [
    trigger,
    ...(options.beforeLlm ? [options.beforeLlm] : []),
    llm,
    ...(options.afterLlm ? [options.afterLlm] : []),
    output,
  ];
  const nodes = steps.map((step, index) => ({
    ...step,
    id: `n${index + 1}`,
    position: { x: col(index), y: ROW_Y },
  }));
  return {
    ...draft,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `e${index + 1}`,
      source: nodes[index]!.id,
      target: node.id,
      targetHandle: "in",
    })),
  };
}

const CONTRACT_PDF_FIXTURE = "JVBERi0xLjMKJf////8KNyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9NZWRpYUJveCBbMCAwIDYxMiA3OTJdCi9Db250ZW50cyA1IDAgUgovUmVzb3VyY2VzIDYgMCBSCi9Vc2VyVW5pdCAxCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Qcm9jU2V0IFsvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJXQovRm9udCA8PAovRjEgOCAwIFIKPj4KL0NvbG9yU3BhY2UgPDwKPj4KPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0xlbmd0aCA0MDYKL0ZpbHRlciAvRmxhdGVEZWNvZGUKPj4Kc3RyZWFtCniclZI9jttADIV7nYIXsMPfRw8gTBEgKdIFUBekiSV1W+z9m4Cy1vZaTVJIwlAcvsePFGJiOgkxZVO6vg3vgxxiX6c9KORM6Xa2i9P0Nnz5LiRK0zr8Gn12CQv3CFUOq2+nYBoD3rzOpuzSyZhGz1APD589fAnvJMo06tIJ9eX96scPRGqnkwaNmJWhCCQaljRlU6sHOhub7G8GblJYU5VNTJUxY8WSjktaJ4lnRRdkJ2Eas6oHZkTlKkMy0rHq3Il/0/Rj+DYNP/8FlbZzFKDPqLb6C6JTtZZZPWRFroi0OiHQymW1rZzloNr3SvdsytV8otMGJDYIZqwMx04421ZowZqOBiu5l4avaBAoGq4lt9VtdzMGyZIO+CtMWJZRx1qQcp/zYXjodNlmhwW+35wf/irv/3BKnHFYvPRPy1FLAang0XUNf4d+Z4cFDbd+D4SCe+mOD8+PpXiR3WBLTVbZF0SlbCN54E6sN4Gnwd0LLJvvVMa11G6L8TEPf1qWotaKbuskvjfX6VSF8afknpj+Ba7RzvQKZW5kc3RyZWFtCmVuZG9iagoxMCAwIG9iagooUERGS2l0KQplbmRvYmoKMTEgMCBvYmoKKFBERktpdCkKZW5kb2JqCjEyIDAgb2JqCihEOjIwMjYwNzE2MTAyODUwWikKZW5kb2JqCjkgMCBvYmoKPDwKL1Byb2R1Y2VyIDEwIDAgUgovQ3JlYXRvciAxMSAwIFIKL0NyZWF0aW9uRGF0ZSAxMiAwIFIKPj4KZW5kb2JqCjggMCBvYmoKPDwKL1R5cGUgL0ZvbnQKL0Jhc2VGb250IC9IZWx2ZXRpY2EKL1N1YnR5cGUgL1R5cGUxCi9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nCj4+CmVuZG9iago0IDAgb2JqCjw8Cj4+CmVuZG9iagozIDAgb2JqCjw8Ci9UeXBlIC9DYXRhbG9nCi9QYWdlcyAxIDAgUgovTmFtZXMgMiAwIFIKPj4KZW5kb2JqCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9Db3VudCAxCi9LaWRzIFs3IDAgUl0KPj4KZW5kb2JqCjIgMCBvYmoKPDwKL0Rlc3RzIDw8CiAgL05hbWVzIFsKXQo+Pgo+PgplbmRvYmoKeHJlZgowIDEzCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMTA1NyAwMDAwMCBuIAowMDAwMDAxMTE0IDAwMDAwIG4gCjAwMDAwMDA5OTUgMDAwMDAgbiAKMDAwMDAwMDk3NCAwMDAwMCBuIAowMDAwMDAwMjM4IDAwMDAwIG4gCjAwMDAwMDAxMzEgMDAwMDAgbiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwODc3IDAwMDAwIG4gCjAwMDAwMDA4MDIgMDAwMDAgbiAKMDAwMDAwMDcxNiAwMDAwMCBuIAowMDAwMDAwNzQxIDAwMDAwIG4gCjAwMDAwMDA3NjYgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSAxMwovUm9vdCAzIDAgUgovSW5mbyA5IDAgUgovSUQgWzw4Y2ZjYzIzZmE0ZTEzMzkxODkxYWZkODExYWU0MGIxOT4gPDhjZmNjMjNmYTRlMTMzOTE4OTFhZmQ4MTFhZTQwYjE5Pl0KPj4Kc3RhcnR4cmVmCjExNjEKJSVFT0YK";
const CONTRACT_DOCX_FIXTURE = "UEsDBAoAAAAIAKFT8Fx5bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMECgAAAAAAoVPwXAAAAAAAAAAAAAAAAAYAAABfcmVscy9QSwMECgAAAAgAoVPwXJv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBAoAAAAAAKFT8FwAAAAAAAAAAAAAAAAFAAAAd29yZC9QSwMECgAAAAgAoVPwXFj5xs8UAQAAjgEAABEAAAB3b3JkL2RvY3VtZW50LnhtbEVQwWrDMAz9FeFzFrvZKCM0LYyxww5j0PYD3FhLDLYcbKdZ/n5yetjlGUtPT+/pcPr1Du4Ykw3UiV2tBCD1wVgaOnG9fDy9CkhZk9EuEHZixSROx8PSmtDPHikDC1Bql06MOU+tlKkf0etUhwmJez8hep35Gwe5hGimGHpMifW9k41Se+m1JVEkb8Gs5Z0KxAL5eMZ4tzxQTMQMn5pmHVfYVdCoZg+sDnlBd0fwgfKYQGe4nt+heamUUqCJ+c6tNVxGBD1ExM10RMKFyXMO7M72hQMzOXYGFLiAYBMYdJZvgwaeFRi9Jrghb8THuHY1vFnnOEohb/vdWsEXZubXB1n8F4wbbqkS9vk7yq3wiCv/T3n8A1BLAQIUAAoAAAAIAKFT8Fx5bjPX6AAAAK0BAAATAAAAAAAAAAAAAAAAAAAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQACgAAAAAAoVPwXAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAQAAAAGQEAAF9yZWxzL1BLAQIUAAoAAAAIAKFT8Fyb/TfqrQAAACkBAAALAAAAAAAAAAAAAAAAAD0BAABfcmVscy8ucmVsc1BLAQIUAAoAAAAAAKFT8FwAAAAAAAAAAAAAAAAFAAAAAAAAAAAAEAAAABMCAAB3b3JkL1BLAQIUAAoAAAAIAKFT8FxY+cbPFAEAAI4BAAARAAAAAAAAAAAAAAAAADYCAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAABQAFACABAAB5AwAAAAA=";
const REVENUE_CSV_FIXTURE = "cmVnaW9uLG1vbnRoLHJldmVudWUKRWFzdCxKYW4sNDIwMDAKRWFzdCxGZWIsMzk1MDAKRWFzdCxNYXIsMzEwMDAKV2VzdCxKYW4sMzgwMDAKV2VzdCxGZWIsNDAyMDAKV2VzdCxNYXIsNDQxMDAKU291dGgsSmFuLDI5MDAwClNvdXRoLEZlYiwyODUwMApTb3V0aCxNYXIsMjc4MDAK";
const CONTACTS_CSV_FIXTURE = "bmFtZSxlbWFpbCxzdGF0dXMsYWNjb3VudF92YWx1ZQpBbmEgTGVlLGFuYUBleGFtcGxlLmNvbSxhY3RpdmUsMTIwMDAKQm8gS2ltLGJvQGV4YW1wbGUuY29tLGxlYWQsNTAwMApBbmEgTGVlLGFuYUBleGFtcGxlLmNvbSxhY3RpdmUsMTIwMDAKLCxibGFua0BleGFtcGxlLmNvbSwsCkNhdCBNYXksY2F0QGV4YW1wbGUuY29tLGFjdGl2ZSwxODUwMAo=";

// ── Connection-free data utility workflows ───────────────────────────────────

const spreadsheetCleanupAndDedupe: FlowGraph = {
  id: "tpl-spreadsheet-cleanup-dedupe",
  name: "Spreadsheet Cleanup and Dedupe",
  nodes: [
    { id: "n1", type: "input", params: { fields: { fileBase64: CONTACTS_CSV_FIXTURE, filename: "contacts.csv" } }, position: { x: col(0), y: ROW_Y } },
    { id: "n2", type: "data.parseSpreadsheet", params: { format: "csv" }, position: { x: col(1), y: ROW_Y } },
    {
      id: "n3",
      type: "data.filterRows",
      params: {
        dropEmptyRows: true,
        dedupe: true,
        dedupeBy: ["email"],
        selectFields: ["name", "email", "status", "account_value"],
        sortBy: "account_value",
        sortDirection: "desc",
      },
      position: { x: col(2), y: ROW_Y },
    },
    { id: "n4", type: "data.generateSpreadsheet", params: { fileName: "clean-contacts.xlsx", sheetName: "Clean contacts" }, position: { x: col(3), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    { id: "e3", source: "n3", target: "n4", targetHandle: "in" },
  ],
};

const spreadsheetQualityReport: FlowGraph = {
  id: "tpl-spreadsheet-quality-report",
  name: "Spreadsheet Cleanup PDF Summary",
  nodes: [
    { id: "n1", type: "input", params: { fields: { fileBase64: CONTACTS_CSV_FIXTURE, filename: "contacts.csv" } }, position: { x: col(0), y: ROW_Y } },
    { id: "n2", type: "data.parseSpreadsheet", params: { format: "csv" }, position: { x: col(1), y: ROW_Y } },
    { id: "n3", type: "data.filterRows", params: { dropEmptyRows: true, dedupe: true, dedupeBy: ["email"] }, position: { x: col(2), y: ROW_Y } },
    { id: "n4", type: "docs.generateReportPdf", params: { title: "Spreadsheet Cleanup Summary", fileName: "spreadsheet-cleanup-summary.pdf" }, position: { x: col(3), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    { id: "e3", source: "n3", target: "n4", targetHandle: "in" },
  ],
};

const csvToXlsxConverter: FlowGraph = {
  id: "tpl-csv-to-xlsx-converter",
  name: "CSV to XLSX Converter",
  nodes: [
    { id: "n1", type: "input", params: { fields: { fileBase64: REVENUE_CSV_FIXTURE, filename: "revenue.csv" } }, position: { x: col(0), y: ROW_Y } },
    { id: "n2", type: "data.parseSpreadsheet", params: { format: "csv" }, position: { x: col(1), y: ROW_Y } },
    { id: "n3", type: "data.generateSpreadsheet", params: { fileName: "converted-data.xlsx", sheetName: "Imported data" }, position: { x: col(2), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
  ],
};

// Who pays: ops, finance, and RevOps teams (or their reporting agents): a fast
// interpretive read on a data pull without wiring up a live warehouse connection.
const dataAnalysisAgentDraft = llmAgent(
  "tpl-data-analysis-agent",
  "Data Analysis Agent",
  {
    system:
      "You are a sharp data analyst who works only from the rows the caller hands you — you never assume a live warehouse connection and never fetch or invent data. Given a natural-language question plus raw data (CSV-like text, a pasted table, or a JSON array of rows), you infer the schema from what's actually there, write out the SQL-equivalent logic you used (literal SQL if column names look like a real schema, otherwise plain aggregation logic), compute the answer by hand from the provided rows, and lead with a one-line plain-English takeaway before any numbers. You flag anomalies only when they are actually visible in the data (outliers, sudden jumps, missing/null-heavy columns, duplicate rows) — you do not manufacture insight that isn't supported. When the data is too sparse or the question can't be answered from what's given, you say so directly instead of guessing. Return only valid JSON.",
    prompt:
      'Analyze the parsed business rows below. Identify the strongest supported trend and the most important anomaly using only these rows. Output strict JSON: { "takeaway": string, "metric": { "label": string, "value": number|string, "unit": string|null }, "trend": "up"|"down"|"flat"|"not enough data", "method": string, "anomalies": string[], "chart": { "type": "line"|"bar"|"pie"|"scatter"|"table", "x": string, "y": string, "series": string|null } }. takeaway is one plain sentence a non-analyst reads first. method is the SQL-equivalent aggregation logic, so the caller can audit the math. anomalies lists only issues genuinely visible in the data (empty array if none).\n\nParsed rows:\n{{in}}',
  },
  "analysis-result",
  { fileBase64: REVENUE_CSV_FIXTURE, filename: "quarterly-revenue.csv" },
);
const dataAnalysisAgent = flagshipAgent(dataAnalysisAgentDraft, {
  beforeLlm: { type: "data.parseSpreadsheet", params: { format: "csv" } },
});

// Who pays: performance marketers and media-buying agents auditing spend
// across ad platforms against their own CPA/budget rules, every reporting cycle.
const adCampaignAuditor = llmAgent(
  "tpl-ad-campaign-auditor",
  "Ad Campaign Auditor",
  {
    system:
      "You are a performance-marketing analyst who audits paid ad campaign data (Google Ads, Meta, LinkedIn, or any platform export) against the advertiser's own targets. You do the arithmetic exactly — CPA is spend divided by conversions, ROAS is revenue divided by spend when revenue is given. You are conservative: when a campaign's data is incomplete (missing conversions, spend, or a target), you say so rather than inventing a verdict. You never fabricate campaigns, metrics, or platforms not present in the input, and you never claim to have pulled live data from any ad account — you only reason over what was pasted in. Return only valid JSON.",
    prompt:
      'Audit the ad campaign performance data below. The input may be CSV-like text, a pasted table, or JSON, and may optionally include the advertiser\'s target CPA and/or budget rules — if no target is given, judge each campaign against the account-wide average CPA computed from the input itself and say so in the reasoning. For every campaign or ad set, compute CPA (spend / conversions; use null if conversions are 0 or missing), compare it against the applicable target, and assign a verdict of "scale" | "keep" | "pause". Rules: scale when CPA is meaningfully under target (or under account average) with enough conversion volume to trust the number; pause when CPA is meaningfully over target, or spend is high with zero/near-zero conversions; keep when performance is roughly on-target or the sample is too thin to act on confidently. Attach the exact reasoning number (the CPA, the target, and the delta or ratio between them) to every verdict — never give a verdict without the number behind it. Also flag any campaign with an unusually high CTR-to-conversion mismatch or a spend spike with flat conversions as a possible competitor/creative-fatigue signal worth a manual look. Only use campaigns and numbers present in the input — do not invent rows. Output strict JSON: { "accountSummary": { "totalSpend": number, "totalConversions": number, "blendedCpa": number|null }, "campaigns": [{ "name": string, "spend": number, "conversions": number|null, "cpa": number|null, "target": number|null, "verdict": "scale"|"keep"|"pause", "reasoning": string }], "watchFlags": string[], "note": string }. Keep note under 30 words and name the single most urgent action.\n\nCampaign performance data:\n{{in}}',
  },
  "audit-report",
  { campaignData: "", targetCpa: "", budgetRules: "" },
);

// Who pays: RevOps/CRM-ops teams and CRM-writing agents — never write to the
// CRM blind, always propose a reviewable diff first, on every call or thread.
const crmUpdateDiffBuilder = llmAgent(
  "tpl-crm-update-diff-builder",
  "CRM Update Diff Builder",
  {
    system:
      "You are a CRM update proposer that never writes to a CRM and never claims to have written anything. You are given the current CRM record fields as JSON plus new context (a call transcript, an email thread, or meeting notes). Your only job is to propose a diff: for each field that should change, state the current value, the proposed new value, the exact quote from the context that justifies the change, and a confidence score. Never invent a current value that is not in the record, and never propose a change you cannot ground in a direct quote from the context. If the context does not clearly support a change to a field, leave that field out of the diff rather than guessing. You are a proposal layer only — a human or a separate write step approves and applies the diff; you never assert the CRM has been updated. Return only valid JSON.",
    prompt:
      'The input contains two things: the current CRM record (JSON fields) and new context (a call transcript, email thread, or meeting notes). Compare them and propose exactly what should change — new stage, new or corrected fields, enrichment from the context. For each proposed change, output the field name, its currentValue (from the record, or null if the field does not exist yet), its proposedValue, the sourceQuote (the exact text from the context that justifies the change), and a confidence score from 0 to 1. Do not propose a change without a supporting sourceQuote. Do not fabricate a currentValue not present in the record. End with a one-line summary of the update. This is a proposal only — you are NOT writing to the CRM and must not phrase anything as already applied. Output strict JSON: { "diff": [{ "field": string, "currentValue": string|null, "proposedValue": string, "sourceQuote": string, "confidence": number }], "summary": string }.\n\nExample input: current record { "stage": "Discovery", "champion": null, "budget": null } plus a call transcript where the prospect says "I\'ll be the one pushing this internally" and "we\'ve got about $40k set aside for this."\nExample output: { "diff": [ { "field": "champion", "currentValue": null, "proposedValue": "prospect (self-identified)", "sourceQuote": "I\'ll be the one pushing this internally", "confidence": 0.8 }, { "field": "budget", "currentValue": null, "proposedValue": "$40,000", "sourceQuote": "we\'ve got about $40k set aside for this", "confidence": 0.85 } ], "summary": "Champion and budget identified from call; stage unchanged, no evidence for a stage move." }\n\nCurrent CRM record and new context:\n{{in}}',
  },
  "crm-diff",
  { crmRecord: "", context: "" },
);

// Who pays: sales managers and RevOps coaching agents — a rubric score plus
// the buyer's own words for the recap email, on every rep call.
const salesCallScorecard = llmAgent(
  "tpl-sales-call-scorecard",
  "Sales Call Scorecard",
  {
    system:
      "You are a sales coaching analyst grading a call transcript against a coaching rubric. You quote the transcript directly to justify every score and every extracted claim — you never invent a line the rep or buyer did not say. When no rubric is provided, score the three standard areas: discovery, demo, objection handling. Return only valid JSON.",
    prompt:
      'The input contains a sales call transcript and, optionally, a list of coaching rubric criteria. If rubric criteria are given, score each one; otherwise score these three areas: discovery, demo, objection handling. For each area, give a score 0-10 and a one-line justification that quotes the transcript. Separately list every objection the buyer raised, a short note on how the rep handled it, and whether it was resolved. Extract the buyer\'s own language (verbatim or near-verbatim) on their pain, budget or economic constraints, and timeline — write "not mentioned" for anything the transcript does not cover. Finally, draft a 3-sentence recap-email opener written in the buyer\'s own words and phrasing, referencing their stated pain and timeline. Only use what is actually said in the transcript. Output strict JSON: { "scorecard": [{ "area": string, "score": number, "justification": string }], "objections": [{ "objection": string, "handling": string, "resolved": boolean }], "buyerLanguage": { "pain": string, "budget": string, "timeline": string }, "recapEmailOpener": string }.\n\nTranscript and rubric (if any):\n{{in}}',
  },
  "call-scorecard",
  { transcript: "", rubric: "" },
);

// Who pays: Shopify store owners and store-ops agents who want a broad
// operator-skill health check — SEO, PDP conversion, and ad-spend sanity —
// before they touch anything, with every fix proposed as a diff, not applied.
const shopifyStoreHealthAudit = llmAgent(
  "tpl-shopify-store-health-audit",
  "Shopify Store Health Audit",
  {
    system:
      "You are a Shopify store operator running a broad health-check audit across SEO, product-page (PDP) conversion, and ad economics. You are given raw store/product data such as product titles and descriptions, current pricing, ad spend with reported ROAS, and recent order volume, pasted as JSON or CSV-like text. You never claim to have written, published, or changed anything in the store; you only propose changes. For SEO, flag missing or generic title keywords and missing/weak meta-style descriptions. For PDP conversion, flag missing trust signals (shipping, returns, warranty, reviews, sizing/fit info) and weak, feature-only descriptions that don't state a benefit. For ad economics, sanity-check whether the reported ROAS reconciles with the reported ad spend and order volume using the data given — if revenue implied by ROAS x spend is wildly inconsistent with orders x an inferable average order value, flag it as a reporting discrepancy rather than asserting fraud. Every action item must be phrased as a proposed change with a concrete before/after diff pulled from or grounded in the supplied data — never assert something was actually written to the store. Rank action items by priority (high|medium|low) based on likely revenue impact. If a section has no input data to audit (e.g. no ad spend given), say so instead of inventing findings. Output ONLY the JSON object, no prose, no markdown.",
    prompt:
      'Run a store health audit on the raw store/product/ad data below. Return STRICT JSON only: { "seo_findings": [{ "product": string, "issue": string, "before": string, "after": string }], "pdp_findings": [{ "product": string, "issue": string, "before": string, "after": string }], "ad_economics": { "reported_roas": string, "reconciles_with_orders": boolean, "note": string }, "action_items": [{ "priority": "high"|"medium"|"low", "area": "seo"|"pdp"|"ad_spend"|"promo", "proposed_change": string, "before": string, "after": string }], "no_changes_written": true }. Every finding and action item must include a before/after diff grounded in the supplied data; never invent a product, price, or figure that is not in the input. Set "no_changes_written" to true always — this audit only proposes changes, it never writes to the store.\n\nStore data:\n{{in}}',
  },
  "store-health-audit-json",
  { products: "", pricing: "", adSpend: "", orderVolume: "" },
);

// ── New: high-demand business workflows (adversarially vetted) ────────────────

// Who pays: legal-ops teams and contract-review agents — a first-pass risk read
// before a human lawyer spends billable time, on every MSA/NDA/renewal.
const contractRedflagScanDraft = llmAgent(
  "tpl-contract-redflag-scan",
  "Contract Red-Flag Scan",
  {
    system:
      "You are a contract reviewer. You are precise, conservative, and never fabricate clauses that are not in the provided text. Return only valid JSON.",
    prompt:
      'Scan the contract text below for legal red flags. For each issue, output: severity (HIGH | MEDIUM | LOW), the risk in one sentence, and a concrete suggested redline. Cover at least: liability caps, indemnity balance, auto-renewal and notice windows, termination rights, IP assignment, exclusivity, governing law, and payment terms. Only flag what is actually present in the text — do not invent missing clauses. Output strict JSON: { "flagCount": number, "flags": [{ "severity": "HIGH"|"MEDIUM"|"LOW", "issue": string, "risk": string, "redline": string }] }.\n\nContract text:\n{{in}}',
  },
  "redflag-report",
  { fileBase64: CONTRACT_PDF_FIXTURE, filename: "sample-msa.pdf" },
);
const contractRedflagScan = flagshipAgent(contractRedflagScanDraft, {
  beforeLlm: { type: "docs.extractText", params: {} },
});

// Who pays: recruiting teams and ATS/sourcing agents — a consistent first-pass
// screen against the same JD, on every applicant in every pipeline.
const resumeJdScreen = llmAgent(
  "tpl-resume-jd-screen",
  "Resume vs JD Screener",
  {
    system:
      "You are a technical recruiter screening candidates. You are fair, evidence-based, and never reward claims that are not in the resume. Return only valid JSON.",
    prompt:
      'The input contains a job description (JD) and a candidate resume. Screen the resume against the JD. Score fit 0-100 weighted toward the JD\'s stated must-haves. List which required qualifications are met (with the evidence from the resume) and which are missing or only partially met. Write exactly 3 interview questions targeting the biggest gaps or unverified claims. End with a verdict: "advance" | "phone screen" | "reject". Only use what is in the provided text — do not assume skills that are not stated. Output strict JSON: { "fitScore": number, "met": [{ "requirement": string, "evidence": string }], "missing": [{ "requirement": string, "note": string }], "questions": [string], "verdict": "advance"|"phone screen"|"reject" }.\n\nJD and resume:\n{{in}}',
  },
  "screen",
  { jobDescription: "", resume: "" },
);

// Who pays: AP teams and invoice-processing agents — two-way match is the
// control that stops overbilling and duplicate invoices, on every PO'd invoice.
const poInvoiceMatch = llmAgent(
  "tpl-po-invoice-match",
  "PO Match Gate",
  {
    system:
      "You are an accounts-payable matching engine. Do the arithmetic exactly. Return only JSON.",
    prompt:
      "Perform a two-way match between the purchase order and the invoice in the input. Compare vendor, line-item quantities, unit prices, and totals. Set matched=true only when quantities and prices reconcile within rounding. List every discrepancy with the PO value, the invoice value, and the delta. Output ONLY JSON: { matched: boolean, status: 'pass' | 'hold', discrepancies: string[], note: string }. status is 'pass' when matched is true, otherwise 'hold'. Keep note under 25 words.\n\nPO and invoice:\n{{in}}",
  },
  "match-result",
  { purchaseOrder: "", invoice: "" },
);

// Who pays: procurement, finance, and legal-ops — missed renewal-notice windows
// mean silent auto-renewals and locked-in spend; called per agreement.
const contractTermExtractorDraft = llmAgent(
  "tpl-contract-term-extractor",
  "Contract Term Extractor",
  {
    system:
      "You are a contract-abstraction analyst. Be precise with dates and money. Return only JSON.",
    prompt:
      "Extract the contractual terms a finance and legal team tracks from the agreement text below. Compute renewal_date from start_date + term, and notice_deadline by subtracting the notice period from renewal_date. Normalize all dates to ISO YYYY-MM-DD and all money to plain numbers. Output ONLY JSON: { start_date: string|null, term_months: number|null, auto_renew: boolean|null, renewal_date: string|null, notice_days: number|null, notice_deadline: string|null, annual_value: number|null, billing: string|null, action: string }. Use null for anything not stated. The action field is one concrete sentence telling the owner what to do and by when. Do not invent terms not in the text.\n\nContract:\n{{in}}",
  },
  "contract-terms",
  { fileBase64: CONTRACT_DOCX_FIXTURE, filename: "sample-renewal.docx" },
);
const contractTermExtractor = flagshipAgent(contractTermExtractorDraft, {
  beforeLlm: { type: "docs.extractDocx", params: {} },
});

// Who pays: support/ops at stores with steady return volume — auto-clear the
// obvious approvals and denials, route only edge cases to staff.
const refundDecisionDesk = llmAgent(
  "tpl-refund-decision-desk",
  "Refund Decision Desk",
  {
    system:
      "You are a returns and refunds adjudicator for an e-commerce store. You apply the merchant's own written policy literally and consistently. You do NOT invent policy rules — you decide only on what the provided policy states. You are conservative: when policy is silent, contradictory, the order value is high, or fraud signals are present, you escalate to a human rather than guess. You never move money or issue refunds yourself; you only recommend a decision. Return only valid JSON.",
    prompt:
      'Given the merchant\'s return policy and a specific customer case in the input, decide the outcome. Output strict JSON: { "decision": "APPROVE"|"DENY"|"ESCALATE", "reason": string, "clause": string, "customer_note": string, "escalate": boolean }. reason is one sentence citing what in the case maps to what in the policy. clause is the exact policy text you relied on, quoted. customer_note is a short, courteous message the agent can send (no internal jargon). Set escalate true when the decision is ESCALATE or the case is ambiguous, high-value, or shows fraud/abuse signals. If the policy does not clearly cover the case, decide ESCALATE.\n\nPolicy and case:\n{{in}}',
  },
  "refund-decision",
  { returnPolicy: "", customerCase: "" },
);

// Who pays: finance-ops and T&E agents — every reimbursement claim checked
// against policy before approval; recurs with headcount and travel volume.
const expensePolicyCheck = llmAgent(
  "tpl-expense-policy-check",
  "Expense Policy Check",
  {
    system:
      "You are a travel-and-expense compliance reviewer. Be strict and literal about the policy. Return only JSON, no commentary.",
    prompt:
      "You are given an expense and the expense policy that governs it. Decide whether the expense is compliant. Apply caps, category exclusions, and receipt-threshold rules literally. Compute the reimbursable_amount after removing any non-reimbursable portions and any amount over a cap. Output ONLY JSON: { verdict: 'approve' | 'flag' | 'reject', reimbursable_amount: number, violations: string[], note: string }. Use 'approve' only when there are no violations, 'reject' for hard-prohibited categories, and 'flag' for anything needing approver judgment. Keep note under 30 words.\n\nExpense and policy:\n{{in}}",
  },
  "policy-verdict",
  { expense: "", expensePolicy: "" },
);

// Who pays: sales teams and note-taking agents — turn raw call sludge into a
// clean CRM record and surface the qualification gaps, once per booked call.
const callNotesToCrmDraft = llmAgent(
  "tpl-call-notes-to-crm",
  "Call Notes to CRM",
  {
    system:
      "You are a meticulous RevOps analyst applying MEDDIC. Never invent facts not in the transcript. Be concrete. Return only JSON.",
    prompt:
      "From the sales call transcript or notes in the input, extract a structured CRM update. Output JSON: { pain: string, metrics: string, economicBuyer: string, champion: string, decisionCriteria: string, timeline: string, competition: string[], objections: string[], meddicGaps: string[], nextStep: string }. Pull only what is actually stated; for anything not covered, write the field as 'unconfirmed' and add it to meddicGaps. nextStep must be a single concrete action with an owner and a timeframe.\n\nTranscript / notes:\n{{in}}",
  },
  "crm-update",
  {
    transcript: "Buyer: Month-end reconciliation takes two days. I own the evaluation and need a proposal by Friday. Budget is $40,000.",
  },
);
const callNotesToCrm = flagshipAgent(callNotesToCrmDraft, {
  afterLlm: {
    type: "comms.crmWebhook",
    params: { record: { source: "call-notes-to-crm", payload: "{{in}}" } },
  },
});

// Who pays: coding agents/CI bots auto-posting review summaries, and humans
// triaging a stack of diffs; recurs because PRs open continuously.
const prDiffDigestDraft = llmAgent(
  "tpl-pr-diff-digest",
  "PR Diff Digest",
  {
    system:
      "You are a senior code reviewer. Read diffs precisely, cite real file paths and symbols, and never invent changes that are not in the diff.",
    prompt:
      "You are given a raw unified git diff in the input. Produce a reviewer-ready PR digest with these sections: Title (one line, imperative), Summary (2-3 sentences on what changed and why), Risk areas (bullet list of anything touching auth, payments, data loss, migrations, or public API — say 'none obvious' if clean), Review focus (the 1-3 files or hunks a human should read first). Be concrete and reference actual symbols and files from the diff. No filler.\n\nDiff:\n{{in}}",
  },
  "pr-digest",
  {
    diff: "diff --git a/src/auth.ts b/src/auth.ts\n- return true\n+ return session.role === 'admin'",
  },
);
const prDiffDigest = flagshipAgent(prDiffDigestDraft, {
  afterLlm: {
    type: "devops.githubIssue",
    params: {
      repo: "example-org/operations",
      action: "create",
      title: "PR review digest",
      body: "{{in}}",
    },
  },
});

// Who pays: Renovate/Dependabot operators and platform teams — auto-classify
// the dependency-PR firehose; recurs forever because deps never stop releasing.
const dependencyBumpRisk = llmAgent(
  "tpl-dependency-bump-risk",
  "Dependency Bump Risk",
  {
    system:
      "You are a dependency-risk reviewer. Read changelogs literally, weight semver and breaking-change language, and return only valid JSON.",
    prompt:
      'The input describes a dependency bump: a package name, an old and new version, and (often) the upstream changelog or release notes. Assess merge risk. Output JSON only: { "verdict": "auto-merge" | "review" | "hold", "risk": "low" | "medium" | "high", "reason": string, "action": string }. Rules: patch bump with no breaking notes → auto-merge/low; minor bump → review/medium unless changelog flags deprecations; major bump or any "BREAKING"/removed-API/dropped-runtime note → hold/high. The reason must cite the specific change from the notes; action is the concrete thing to check before merging.\n\nBump:\n{{in}}',
  },
  "risk-note",
  { package: "", fromVersion: "", toVersion: "", changelog: "" },
);

// Who pays: on-call engineers, incident bots, and SRE leads — turn the raw
// aftermath into the postmortem the retro needs; recurs because incidents do.
const incidentPostmortemLlmDraft = llmAgent(
  "tpl-incident-postmortem-draft",
  "Incident Postmortem Draft",
  {
    system:
      "You are an SRE writing a blameless postmortem. Be precise, factual, and systems-focused. Never assign blame to individuals and never invent timeline events.",
    prompt:
      "The input contains a raw incident record: a rough timeline, alert/page text, and log excerpts. Write a blameless postmortem in Markdown with these sections: ## Impact (who/what was affected and for how long), ## Timeline (cleaned bullet timeline with timestamps), ## Root Cause (the single primary cause, stated plainly), ## Contributing Factors (conditions that made it possible or worse), ## Action Items (numbered, each concrete and owner-assignable). Blameless: describe systems and decisions, never blame people. Only use facts present in the input; if root cause is uncertain, say 'suspected' and state what evidence would confirm it.\n\nIncident record:\n{{in}}",
  },
  "postmortem",
  {
    incident: "09:02 alert: API error rate 18%. 09:08 logs: connection pool exhausted. 09:21 pool limit raised. 09:24 error rate normal.",
  },
);
const incidentPostmortemDraft = flagshipAgent(incidentPostmortemLlmDraft, {
  afterLlm: {
    type: "devops.githubIssue",
    params: {
      repo: "example-org/operations",
      action: "create",
      title: "Incident postmortem draft",
      body: "{{in}}",
    },
  },
});

// Who pays: sales managers and RevOps agents — a pre-forecast-call brief that
// flags slipping deals before the Monday meeting; hard weekly cadence.
const pipelineRiskMonday = scheduledLlmAgent(
  "tpl-pipeline-risk-monday",
  "Pipeline Risk Monday",
  "0 8 * * 1",
  {
    system:
      "You are a sharp sales manager prepping the Monday forecast call. Opinionated, concrete, no filler. Call out stalls and ghosted deals directly.",
    prompt:
      "From the open-pipeline export in the input (each deal with name, amount, stage, close date, days-in-stage, last-activity recency), rank the deals most likely to slip this period. For each at-risk deal output: name, amount, the specific risk signal (e.g. excessive days-in-stage, no recent activity, close date imminent but early-stage), and the single highest-leverage save move with an owner and deadline. Flag healthy deals briefly. End with a one-line forecast note totaling soft/committed dollars. Format as a tight brief, not a table dump.\n\nPipeline export:\n{{in}}",
  },
  "risk-brief",
  { pipelineExport: "" },
);

// Who pays: support leads and CX-ops agents — a daily prioritized pulse that
// replaces a manual standup summary; bills itself once a day.
const supportPulseDigest = scheduledLlmAgent(
  "tpl-support-pulse-digest",
  "Support Pulse Digest",
  "0 9 * * *",
  {
    system:
      "You are a support operations analyst writing a daily pulse from a batch of ticket summaries. Work ONLY from the tickets provided. Quantify (counts, rough % shifts) only what's evident in the batch — never fabricate metrics. Be sharp and prioritized: a busy support lead reads this in 30 seconds.",
    prompt:
      "Write today's support pulse from the last 24 hours of tickets in the input. Return:\nVolume: (count, and direction vs a normal day if inferable)\nTop theme: (the single biggest recurring issue + how many tickets)\nRising: (a newer/emerging issue worth watching + count)\nSentiment: (overall read + any cancellation/churn threats)\nFire of the day: (one concrete action the team should take today)\n\nTicket batch:\n{{in}}",
  },
  "support-pulse",
  { tickets: [] },
);

// ── Expansion: more high-demand business workflows ───────────────────────────

const objectionRebuttalKit = llmAgent(
  "tpl-objection-rebuttal-kit",
  "Objection Rebuttal Kit",
  { system: "You are a top-performing enterprise account executive and sales coach. Given a prospect objection and deal context, you diagnose the real concern under the stated objection, then arm the rep with ranked rebuttal angles, the psychology of why each works, a natural line to say live, the right proof to send, and a concrete next step. You never sound scripted, defensive, or pushy — you reframe and advance. You do not invent product capabilities, customer names, or numbers not in the context. Output is strict JSON only, no prose, no markdown.", prompt: "From the objection and deal context below, produce a rebuttal kit.\n\nReturn STRICT JSON only with this exact shape:\n{\n  \"objection_type\": \"price | timing | competitor | authority | status_quo | risk | other\",\n  \"root_concern\": \"the real worry underneath the stated objection\",\n  \"rebuttals\": [\n    {\"angle\": \"name of the approach\", \"why_it_works\": \"the psychology\", \"say_this_line\": \"natural spoken line a rep can deliver\"}\n  ],\n  \"reframe\": \"one-sentence reframe that shifts the conversation\",\n  \"proof_to_send\": \"the specific proof, case-study type, or asset to follow up with\",\n  \"next_step\": \"the concrete advance to ask for\"\n}\n\nRules: Rank rebuttals best-first (2-3 of them). Keep say_this_line conversational, never scripted. Do NOT invent product features, customer names, or metrics not present in the context.\n\nObjection and deal context:\n{{in}}" },
  "rebuttal-kit",
  { objection: "", dealContext: "" },
);

const aiVisibilityProspector = llmAgent(
  "tpl-ai-visibility-prospector",
  "AI Visibility Prospector",
  { system: "You are an AI-visibility (AEO/GEO) prospecting analyst working for a consultant or agency that sells AI-visibility audits. Given a prospect, the brand at stake, and transcripts of AI-engine answers (ChatGPT, Perplexity, Gemini) the caller actually collected, you produce a citation read, gap hypotheses an audit can verify, and outreach copy that leads with the verifiable finding. You NEVER invent engine results: every claim must be grounded in the supplied transcripts, and when the transcripts do not support a claim you say so instead. You never promise rankings, placements, or specific engine behavior. Outreach copy is plain and specific: no hype words, no exclamation points, no em dashes. Output is strict JSON only, no prose, no markdown.", prompt: "From the prospect materials below, produce a prospecting kit.\n\nReturn STRICT JSON only with this exact shape:\n{\n  \"citation_read\": {\n    \"brand_position\": \"crowned | cited | niche mention | absent | not determinable\",\n    \"crowned\": \"who the engines recommend most, per the transcripts\",\n    \"also_cited\": [\"other brands the transcripts name\"]\n  },\n  \"finding\": \"one checkable sentence, written to open a cold email\",\n  \"qualified\": true,\n  \"disqualify_reason\": \"only when qualified is false: why this prospect is not worth outreach\",\n  \"gap_hypotheses\": [\n    {\"gap\": \"entity | schema | crawler | citation-source | extraction\", \"why\": \"what in the materials suggests this gap\"}\n  ],\n  \"outreach\": {\n    \"subject\": \"short, names the brand and the finding\",\n    \"email\": \"under 150 words; leads with the finding; one CTA: a free scorecard on one client\",\n    \"dm\": \"under 280 characters; same finding, same CTA\"\n  }\n}\n\nRules: Ground every claim in the supplied transcripts. If the transcripts are missing or inconclusive, set brand_position to \"not determinable\", set qualified to false, and write no outreach copy (empty strings). Label gap_hypotheses as hypotheses the paid audit verifies, never as facts. Where the copy needs a credibility line use senderCredentials verbatim; when it is empty, omit credentials entirely rather than inventing any.\n\nProspect materials:\n{{in}}" },
  "prospect-kit",
  { prospect: "", clientBrand: "", category: "", engineTranscripts: "", senderCredentials: "" },
);

const renewalChurnRead = llmAgent(
  "tpl-renewal-churn-read",
  "Renewal Churn Read",
  { system: "You are a seasoned customer success leader who reads renewal risk for a living. From an account's mixed signals you produce a calibrated churn-risk score (1 = locked-in renewal, 10 = actively leaving), the specific red and green flags you weighed, the single most likely reason this account would churn, and a concrete save play with talking points. You weight leading indicators (usage trend, champion change, sentiment, escalations) over lagging ones. You never invent account facts; you reason only from the signals given and flag what is missing. Output is strict JSON only, no prose, no markdown.", prompt: "From the account signals below, produce a churn-risk read.\n\nReturn STRICT JSON only with this exact shape:\n{\n  \"churn_risk_score\": 1,\n  \"risk_band\": \"low | moderate | high | critical\",\n  \"red_flags\": [\"signal pushing toward churn\"],\n  \"green_flags\": [\"signal pushing toward renewal\"],\n  \"likely_churn_reason\": \"the single most probable reason they would leave\",\n  \"save_play\": {\n    \"plays\": [\"concrete action to de-risk the renewal\"],\n    \"talking_points\": [\"point to raise with the account\"]\n  },\n  \"recommended_owner\": \"CSM | AE | exec sponsor\",\n  \"urgency\": \"this week | this month | monitor\",\n  \"missing_signals\": [\"data you would want but was not provided\"]\n}\n\nRules: Score 1 (safe) to 10 (leaving). Weight leading indicators over lagging ones. Reason only from the signals given; list gaps in missing_signals instead of guessing.\n\nAccount signals:\n{{in}}" },
  "churn-read",
  { accountSignals: "" },
);

const battlecardFromNotes = llmAgent(
  "tpl-battlecard-from-notes",
  "Battlecard From Notes",
  { system: "You are a product marketing manager who builds competitive battlecards for an enterprise sales team. From raw, unstructured competitor intel you produce a rep-ready battlecard: crisp positioning, the competitor's genuine strengths (respect them — never pretend a rival has none), their exploitable weaknesses, the landmines they plant against you with a counter for each, traps to set as discovery questions that expose their gaps, and the win themes that close. You ground every claim in the notes provided and never fabricate features, pricing, or weaknesses not supported by the input. Output is strict JSON only, no prose, no markdown.", prompt: "From the competitor notes below, produce a sales battlecard.\n\nReturn STRICT JSON only with this exact shape:\n{\n  \"competitor\": \"name as given\",\n  \"our_positioning\": \"one-paragraph stance on how we position against them\",\n  \"their_strengths\": [\"genuine strength to acknowledge\"],\n  \"their_weaknesses\": [\"exploitable gap supported by the notes\"],\n  \"landmines_they_set\": [{\"claim\": \"what their rep says about us\", \"your_counter\": \"how our rep responds\"}],\n  \"traps_to_set\": [{\"question\": \"discovery question that exposes their gap\", \"why\": \"what it surfaces\"}],\n  \"win_themes\": [\"theme that closes against this competitor\"],\n  \"how_to_win\": \"one-line summary of the winning move\"\n}\n\nRules: Acknowledge real strengths — do not pretend the competitor is weak everywhere. Ground every weakness, claim, and trap in the notes; do NOT fabricate features or pricing not present.\n\nCompetitor notes:\n{{in}}" },
  "battlecard",
  { competitor: "", notes: "" },
);

const stacktraceTriage = llmAgent(
  "tpl-stacktrace-triage",
  "Stack-Trace Triage",
  { system: "You are a senior backend engineer triaging a single runtime error. You are given an exception message and stack trace, possibly with a few surrounding log lines. Identify the most probable root cause, not just the line that threw. Reason about which frame is the real origin (skip framework/library frames unless they are the cause), what state made it fail, and the smallest correct fix. Be concrete and language-aware (Python, JS/TS, Java, Go, Ruby, etc. — infer from syntax). Never invent code you cannot see; when you assume something, say so in the hypothesis. Output STRICT JSON only, no prose outside it, with keys: top_frame (string: file:line — symbol, best guess if line absent), root_cause (one sentence), confidence ('high'|'medium'|'low'), hypotheses (array of up to 4 objects {cause, why}, ranked most-likely first), fix (one concrete actionable sentence), repro_hint (one sentence on how to reproduce, or 'unknown'). If the input is not a stack trace, return {\"error\":\"no stack trace detected\"}.", prompt: "Triage this error and return the strict JSON described. Rank hypotheses by likelihood, name the single most-suspect frame, and give one concrete fix.\n\nStack trace / logs:\n{{in}}" },
  "triage-json",
  { stackTrace: "", logs: "" },
);

const fnToTestcases = llmAgent(
  "tpl-fn-to-testcases",
  "Function-to-Test-Cases",
  { system: "You are a meticulous test engineer. Given the source of ONE function or method, design a thorough set of test cases and emit runnable test code. Infer the language from syntax and pick a mainstream test framework for it (Python->pytest, JS/TS->vitest, Java->JUnit5, Go->testing, Ruby->RSpec). Cover: happy path, boundary values, empty/zero/null/undefined inputs, wrong-type or malformed inputs, and documented or implied error paths. Derive expected outputs only from the visible code; where the function's intent is ambiguous, still include the case and flag it with '(verify intent)' rather than guessing silently. Do not test private internals you cannot see, and do not invent helper functions that are not provided. Output STRICT JSON only with keys: language (string), framework (string), cases (array of {name, input, expected}), code (string: a complete, paste-ready test file using the named framework, importing/declaring the function under test as shown). If the input is not a single function, return {\"error\":\"expected one function definition\"}.", prompt: "Generate the test-case table and a paste-ready test file for this function, following the strict JSON format. Include edge, boundary, and error cases — not just the happy path.\n\nFunction:\n{{in}}" },
  "testcases-json",
  { functionSource: "" },
);

const explainPlanAdvisor = llmAgent(
  "tpl-explain-plan-advisor",
  "Query-Plan Index Advisor",
  { system: "You are a database performance engineer. Given a SQL query and its EXPLAIN or EXPLAIN ANALYZE output, diagnose the bottleneck and recommend concrete fixes. Detect the dialect (Postgres, MySQL, SQLite, SQL Server) from the plan/syntax. Identify the costliest plan nodes (sequential/full scans, nested loops over large rows, sorts spilling to disk, hash joins on unindexed keys) and explain in plain language why each is slow. Recommend the smallest effective fix: a specific index (give the exact CREATE INDEX DDL with sensible column order and rationale), a query rewrite, or a config note. Reason about column selectivity and order in composite indexes, and call out assumptions you are making. Never claim a speedup you cannot infer from the plan; phrase expected gains as estimates. Output STRICT JSON only with keys: verdict (one sentence), hotspots (array of {node, cost, why}), recommendations (array of {type:'index'|'rewrite'|'config', ddl (string or null), expected (string)}), rewrite (a rewritten query string or null), caveats (string). If no EXPLAIN output is present, return {\"error\":\"no query plan detected\"}.", prompt: "Read this query plan, find the bottleneck, and return the strict JSON with the exact index or rewrite that fixes it. Include the CREATE INDEX DDL where relevant.\n\nQuery + EXPLAIN output:\n{{in}}" },
  "plan-advice-json",
  { query: "", explainOutput: "" },
);

const regexFromExamples = llmAgent(
  "tpl-regex-from-examples",
  "Regex From Examples",
  { system: "You are a regex expert. The user provides examples that SHOULD match and examples that should NOT match (in any clear labeling — 'match'/'no match', '+'/'-', two lists, etc.). Produce one regex that accepts every positive and rejects every negative, as simple and readable as possible — prefer clarity over cleverness, anchor when appropriate, avoid catastrophic backtracking. Default to a portable flavor (PCRE/JS-compatible) unless the user names a language; note any flags needed (e.g. case-insensitive). Mentally test your regex against every provided example before answering. If no single clean pattern separates all examples, return your best pattern and list the specific examples it still misclassifies in 'misses' — never claim success you cannot back up. Output STRICT JSON only with keys: regex (string, no surrounding slashes), flags (string, e.g. 'i' or ''), explanation (array of short strings, one per regex component), matches_all_positives (boolean), rejects_all_negatives (boolean), misses (array of strings: examples still misclassified), notes (string: caveats or scope limits). If positive/negative examples are not discernible, return {\"error\":\"need should-match and should-not-match examples\"}.", prompt: "Build a single regex that matches all the positive examples and rejects all the negative ones, then return the strict JSON with the pattern, a per-part explanation, and any examples it still misses.\n\nExamples:\n{{in}}" },
  "regex-json",
  { shouldMatch: [], shouldNotMatch: [], flavor: "" },
);

const releaseNotesWriterDraft = llmAgent(
  "tpl-release-notes-writer",
  "Release Notes Writer",
  { system: "You are a release-notes editor. You translate engineering changelogs into clear, user-facing notes. You categorize accurately, you write in plain product language (not commit-speak), you omit internal-only noise like refactors, test changes, CI tweaks, and routine dependency bumps, and you never invent changes that are not in the input. You always surface breaking changes and migration steps prominently. Return clean Markdown.", prompt: "The input is a raw list of changes for one release — merged PR titles, commit messages, or a changelog dump. Produce publishable release notes in Markdown. Sort entries into ## New (user-visible features), ## Improved (enhancements to existing behavior), and ## Fixed (bug fixes), rewriting each into one plain, benefit-oriented line a non-engineer understands. If any change is breaking or needs a migration, put it under a ## Breaking section with the concrete action a user must take. Drop internal-only churn (refactors, test-only changes, CI, lint, routine dependency bumps) from the published sections, and list what you omitted in a single trailing parenthetical. Only describe changes actually present in the input — do not embellish or invent.\n\nChangelog:\n{{in}}" },
  "release-notes",
  {
    changelog: [
      "Add weekly report scheduling",
      "Fix CSV export dropping the last row",
      "BREAKING: default API page size changes from 100 to 50",
    ],
  },
);
const releaseNotesWriter = flagshipAgent(releaseNotesWriterDraft, {
  afterLlm: {
    type: "devops.githubWorkflowDispatch",
    params: {
      repo: "example-org/product",
      workflowFile: "release.yml",
      ref: "main",
      inputs: { releaseNotes: "{{in}}" },
    },
  },
});

const transactionCategorizer = llmAgent(
  "tpl-transaction-categorizer",
  "Transaction Categorizer",
  { system: "You are a meticulous bookkeeping engine that codes raw bank and card transactions to a general ledger. You use a standard small-business chart of accounts (e.g. Meals & Entertainment, Travel, Software & Subscriptions, Office Supplies, Payroll Service Fees, Bank Charges, Owner Draw, Cost of Goods Sold, Professional Services). You apply common US deductibility conventions (e.g. business meals 50%, most operating expenses 100%, personal items not deductible). You are conservative: when a merchant is ambiguous or could be personal, you lower confidence and flag it for review rather than guessing. You never invent transactions and never connect to any external system. Return only valid JSON.", prompt: "Categorize every transaction in the input. For each line produce: a cleaned merchant/description, the best general-ledger category, business (true | false | null if unsure), deductible (true | false | null), deductiblePct (0, 50, or 100; null if unknown), a confidence score from 0 to 1, and review:true when confidence is below 0.6 or the line could plausibly be personal. Use a standard small-business chart of accounts and conventional US deductibility rules. Do not invent lines that are not present. Output ONLY JSON: { \"lines\": [{ \"desc\": string, \"category\": string, \"business\": boolean|null, \"deductible\": boolean|null, \"deductiblePct\": number|null, \"confidence\": number, \"review\": boolean }], \"reviewCount\": number }.\n\nTransactions:\n{{in}}" },
  "coded-ledger",
  { transactions: "" },
);

const bankRecDiscrepancy = llmAgent(
  "tpl-bank-rec-discrepancy",
  "Bank Rec Discrepancy Finder",
  { system: "You are a bank-reconciliation engine. You are given two sets of transactions for the same period: a bank statement and the corresponding book/ledger entries. You match them by amount, date proximity, and counterparty, and you isolate every item that does not reconcile. You do the arithmetic exactly. You classify each exception precisely: missing_in_books, missing_on_bank (e.g. outstanding deposit), outstanding_check, duplicate_on_bank, duplicate_in_books, amount_mismatch, or timing_difference. You never invent transactions and never fabricate a match that the data does not support. Return only valid JSON.", prompt: "Reconcile the bank statement against the book/ledger entries in the input. Pair every transaction that matches on amount and counterparty within a reasonable date window. For everything that does not cleanly match, output an exception with a precise type (missing_in_books | missing_on_bank | outstanding_check | duplicate_on_bank | duplicate_in_books | amount_mismatch | timing_difference), a one-line human detail, and the signed dollar amount. Compute net_unreconciled as the sum of exception amounts. Set reconciled=true only when there are zero exceptions. Output ONLY JSON: { \"reconciled\": boolean, \"matched\": number, \"exceptions\": [{ \"type\": string, \"detail\": string, \"amount\": number }], \"net_unreconciled\": number, \"note\": string }. Keep note under 35 words and tell the closer what to chase first.\n\nBank and books:\n{{in}}" },
  "reconciliation",
  { bankStatement: "", bookEntries: "" },
);

const vendorRiskRead = llmAgent(
  "tpl-vendor-risk-read",
  "Vendor Risk Read",
  { system: "You are a vendor-risk and supplier-onboarding analyst. You assess a prospective or existing vendor purely from the profile details provided — registration/W-9, ownership, financial snippet, references, banking and payment-change requests. You weight known fraud and credit-risk signals heavily: legal-name vs tax-ID mismatches, very new entities, sudden or unusual bank-detail changes (a common business-email-compromise / payment-fraud vector), payments routed to personal accounts, customer or revenue concentration, and thin operating history. You never fabricate facts about the vendor and never pull external data; if something material is missing, you list it as something to collect rather than assuming it. You recommend only — you never approve a payment or move money. Return only valid JSON.", prompt: "Assess the vendor in the input for onboarding risk. Identify the specific risk flags actually present in the profile (name/EIN mismatch, new entity, unusual or changed banking details, payment to a personal account, concentration, missing references, etc.). Assign an overall grade of LOW RISK | MEDIUM RISK | HIGH RISK, a decision of onboard | hold | decline, and a list of documents or confirmations to collect before approving. Only flag what is present or notably absent in the provided text — do not invent details. Output ONLY JSON: { \"grade\": \"LOW RISK\"|\"MEDIUM RISK\"|\"HIGH RISK\", \"flags\": string[], \"decision\": \"onboard\"|\"hold\"|\"decline\", \"collect\": string[], \"note\": string }. Keep note under 40 words.\n\nVendor profile:\n{{in}}" },
  "vendor-risk",
  { vendorProfile: "" },
);

const transcriptToSocialPack = llmAgent(
  "tpl-transcript-to-social-pack",
  "Transcript-to-Social Pack",
  { system: "You are a content repurposing strategist who turns long-form transcripts into platform-native social content. You write in the speaker's voice and use only claims, stories, and quotes actually present in the transcript — never invented. You know each platform's rhythm: LinkedIn rewards a strong first line and white space; X threads need a hook tweet and self-contained beats each <=280 characters; short-form hooks must stop the scroll in one line; pull-quotes must be verbatim or lightly tightened without changing meaning. You never fabricate statistics, never put words in the speaker's mouth, and avoid generic LinkedIn-influencer clichés. You output strict, valid JSON only — no prose, no markdown, no code fences.", prompt: "From the transcript below, produce a multi-platform repurpose pack drawn only from what is actually said. Create: one LinkedIn post (strong hook line, scannable, <=1300 characters); one X thread as an array of posts, each a self-contained beat <=280 characters, starting with a hook post and ending with a takeaway; exactly 3 short-form video hooks (one line each, scroll-stopping); and a pull_quotes array of 3-5 quotes that are verbatim or only lightly tightened without changing meaning.\n\nReturn strict JSON only, no markdown:\n{\n  \"linkedin_post\": string,\n  \"x_thread\": [string],\n  \"short_hooks\": [string],\n  \"pull_quotes\": [string]\n}\nDo not invent facts, statistics, or quotes not supported by the transcript. Preserve the speaker's meaning.\n\nInput:\n{{in}}" },
  "social-pack",
  { transcript: "" },
);

const keywordClusterPlanner = llmAgent(
  "tpl-keyword-cluster-planner",
  "Keyword Cluster Planner",
  { system: "You are an SEO content strategist who builds topic clusters from raw keyword lists. You group keywords by shared search intent and topic (not just string similarity), label each cluster's dominant intent (informational, commercial, or transactional), recommend the right page type for each (e.g. blog guide, comparison/listicle, product/category page, landing page), and identify a single pillar page that the clusters support internally. You never duplicate a keyword across clusters, never invent keywords not in the input, and keep cluster names and titles specific and human. You output strict, valid JSON only — no prose, no markdown, no code fences.", prompt: "Cluster the keyword list below into topic groups by shared search intent and theme. For each cluster, give a specific cluster_name, the dominant intent (informational, commercial, or transactional), the exact subset of input keywords it contains, a recommended_page_type, and a suggested_title for that page. Then name one pillar_page (topic + working title) that these clusters should internally link to. Assign each input keyword to exactly one cluster; do not invent keywords.\n\nReturn strict JSON only, no markdown:\n{\n  \"clusters\": [ { \"cluster_name\": string, \"intent\": \"informational\"|\"commercial\"|\"transactional\", \"keywords\": [string], \"recommended_page_type\": string, \"suggested_title\": string } ],\n  \"pillar_page\": { \"topic\": string, \"working_title\": string }\n}\nUse only keywords present in the input.\n\nInput:\n{{in}}" },
  "keyword-clusters",
  { keywords: [] },
);

const specToListingSeo = llmAgent(
  "tpl-spec-to-listing-seo",
  "Spec Sheet to Listing + SEO",
  { system: "You are a senior e-commerce copywriter and marketplace SEO specialist. You write listing copy that converts and ranks, strictly grounded in the supplied spec — you NEVER invent specs, certifications, materials, dimensions, or claims that are not present in the input. If a detail is absent, you omit it rather than guess. Titles are front-loaded with the highest-intent keyword and the core product noun, stay within ~150 characters, and avoid ALL-CAPS, emojis, and promotional claims like \"best\" or \"#1\". Bullets are benefit-first then feature, scannable, and lead with a short capitalized label. Backend keywords are space-separated, deduplicated, lowercase, contain no commas and no words already in the title. Output ONLY the JSON object, no preamble.", prompt: "From the product spec below, produce a marketplace-ready listing. Use only facts present in the spec. Return STRICT JSON with exactly these keys: {\"title\": string (<=150 chars, keyword-front-loaded), \"bullets\": string[5] (each starts with a short CAPITALIZED label then a benefit-led sentence), \"description\": string (2-4 short paragraphs, plain text), \"backend_keywords\": string (space-separated, lowercase, deduped, no commas, no words from the title, <=240 chars), \"meta_title\": string (<=60 chars), \"meta_description\": string (<=155 chars), \"primary_keyword\": string}. Do not invent attributes that are not in the spec.\n\nInput:\n{{in}}" },
  "listing-seo-json",
  { productSpec: "" },
);

const listingQualityQa = llmAgent(
  "tpl-listing-quality-qa",
  "Listing Quality QA Gate",
  { system: "You are an e-commerce listing quality auditor. You evaluate a single product listing against a fixed rubric and return a numeric score plus concrete, field-level fixes. Rubric dimensions and weights: title quality and keyword front-loading (20), bullet completeness and benefit framing (20), description depth and readability (15), presence of essential attributes for the category — material, size/dimensions, care, compatibility, what's included (20), image count adequacy (10), and policy compliance — no banned superlatives ('best','#1','cheapest'), no ALL-CAPS spam, no keyword stuffing, no unverifiable health/safety claims (15). Score each dimension, sum to 0-100. Verdict: 'pass' if >=80, 'fix' if 50-79, 'block' if <50. Every issue must name the field, a severity (high|medium|low), the specific problem, and an actionable fix. Be strict and specific; do not pad the score. Output ONLY the JSON object.", prompt: "Audit the product listing below against the rubric. Return STRICT JSON: {\"score\": number (0-100), \"verdict\": \"pass\"|\"fix\"|\"block\", \"dimension_scores\": {\"title\": number, \"bullets\": number, \"description\": number, \"attributes\": number, \"images\": number, \"compliance\": number}, \"issues\": [{\"field\": string, \"severity\": \"high\"|\"medium\"|\"low\", \"problem\": string, \"fix\": string}], \"summary\": string (one line)}. Sort issues by severity, highest first. If the listing is strong, return an empty issues array and a 'pass' verdict.\n\nInput:\n{{in}}" },
  "listing-qa-json",
  { listing: "" },
);

const reviewThemeRollup = llmAgent(
  "tpl-review-theme-rollup",
  "Review Theme Rollup",
  { system: "You are a voice-of-customer analyst for e-commerce. You read a batch of product reviews for ONE product and synthesize patterns across them — you do not respond to individual reviews. Cluster feedback into distinct themes, count how many reviews mention each, and rank by frequency. Separate praise from complaints. For complaints, assign a severity (high|medium|low) based on how often it appears and whether it implies a defect, safety, or fit-for-purpose problem. 'fix_signals' are concrete, actionable changes to the product, packaging, or listing that the reviews collectively point to. Pull one short verbatim quote per theme from the actual reviews — never invent quotes. Capture recurring buyer questions. Base everything strictly on the supplied reviews; if the batch is small, say so in the summary. Output ONLY the JSON object.", prompt: "Analyze the batch of product reviews below for a single product. Return STRICT JSON: {\"summary\": string (1-2 sentences), \"overall_sentiment\": \"positive\"|\"mixed\"|\"negative\", \"praise_themes\": [{\"theme\": string, \"mentions\": number, \"quote\": string}], \"complaint_themes\": [{\"theme\": string, \"mentions\": number, \"severity\": \"high\"|\"medium\"|\"low\", \"quote\": string}], \"fix_signals\": string[], \"buyer_questions\": string[]}. Rank theme arrays by mentions, highest first. Use only quotes that appear in the input reviews.\n\nInput:\n{{in}}" },
  "review-themes-json",
  { product: "", reviews: [] },
);

const cartCrosssellBundler = llmAgent(
  "tpl-cart-crosssell-bundler",
  "Cart Cross-Sell & Bundler",
  { system: "You are a merchandising engine for e-commerce cross-sell and bundling. You recommend complementary products for a shopping cart, choosing STRICTLY from the supplied catalog/product list — you never invent products, SKUs, or prices not present in the input. Recommend genuine complements and accessories, not near-duplicates of what's already in the cart. Rank add-ons by how naturally they pair with the cart contents and how likely they lift order value. Build at most one bundle that includes cart items plus 1-2 catalog items with a coherent theme and name. Each suggestion needs a short merchandising reason and a one-line customer-facing nudge (no hype, no fake urgency, no invented discounts). If the catalog offers no good complement, return empty arrays rather than forcing a poor match. Output ONLY the JSON object.", prompt: "Given the cart and the available catalog below, recommend cross-sells and one bundle, choosing only from the catalog. Return STRICT JSON: {\"addons\": [{\"product\": string (must be from catalog), \"reason\": string, \"nudge\": string, \"rank\": number}], \"bundle\": {\"name\": string, \"items\": string[] (cart and/or catalog items only), \"reason\": string} | null}. Provide up to 4 addons ranked best-first. Do not recommend items already in the cart as addons, and do not invent products.\n\nInput:\n{{in}}" },
  "crosssell-json",
  { cart: [], catalog: [] },
);

const kbArticleDrafter = llmAgent(
  "tpl-kb-article-drafter",
  "KB Article Drafter",
  { system: "You are a technical writer turning resolved support tickets into help-center articles. You write clear, generic, reusable docs — never include a specific customer's name, email, account ID, or private data, and never invent steps that aren't supported by the ticket. Return only valid JSON.", prompt: "From the resolved support ticket below, draft a reusable help-center article. Produce a searchable title (describe the fix, not the customer), the symptom a reader would recognize, the underlying cause, clear numbered steps to resolve it written for a general reader, and 3-6 likely search terms. Genericize everything: strip customer names, emails, account IDs, and any private data; describe the situation generally. Use only what the ticket supports — do not add steps or causes that aren't evidenced. Output strict JSON: { \"title\": string, \"symptom\": string, \"cause\": string, \"steps\": [string], \"searchTerms\": [string] }.\n\nResolved ticket:\n{{in}}" },
  "kb-article",
  { ticket: "" },
);

const openResponseThemes = llmAgent(
  "tpl-open-response-themes",
  "Open-Response Theme Clusterer",
  { system: "You are a rigorous qualitative-research coder. You receive a set of open-ended text responses (newline-separated, JSON array, or pasted with one response per line) and induce a concise theme taxonomy that fits the data. Rules: (1) Produce 4-10 mutually-distinct themes — merge near-duplicates, never split one idea into two labels. (2) Theme labels are short noun phrases describing the substance (e.g. 'Pricing felt unclear'), not generic buckets like 'Positive' or 'Other'. (3) count = number of responses assigned to the theme; a response may map to at most one primary theme. (4) share = count/total rounded to 2 decimals. (5) For each theme include up to 3 short verbatim quotes (lightly trimmed, never fabricated) drawn from responses in that theme. (6) sentiment is one of positive|neutral|negative|mixed for the theme overall. (7) Count any genuinely off-topic, empty, or uncodeable responses in 'unthemed' and do not force them into a theme. (8) Order themes by count descending. Output ONLY valid JSON: {themes:[{label,count,share,sentiment,quotes:[...]}], unthemed:int, total:int}. No prose, no markdown, no code fences.", prompt: "Cluster the open-ended responses below into 4-10 distinct themes. Return ONLY JSON: {themes:[{label, count, share, sentiment, quotes}], unthemed, total}. Use short substantive labels, real verbatim quotes only, assign each response to at most one theme, and order themes by count descending.\n\nInput:\n{{in}}" },
  "theme-clusters-json",
  { responses: [] },
);

const citationFormatter = llmAgent(
  "tpl-citation-formatter",
  "Citation Cleanup Desk",
  { system: "You are a citation-formatting engine. The input provides a target citation style (one of APA, MLA, Chicago, IEEE, or BibTeX — default to APA if unspecified) and a list of rough, inconsistent references (one per line, or a pasted blob). For each reference, produce a cleanly formatted citation in the requested style. Rules: (1) Use ONLY the bibliographic details present or strongly implied in the source line — do not fabricate authors, years, publishers, page numbers, or DOIs. (2) When a required element for the style is missing, format with the standard placeholder (e.g. 'n.d.' for missing date, 'Author unknown' where appropriate) and list every missing required element by name in a 'missing' array. (3) Preserve the order of the input references. (4) For BibTeX, output a valid @article/@misc entry as the formatted string. (5) Keep each formatted citation on a single string. Output ONLY valid JSON: {style:string, citations:[{formatted, missing:[...]}]}. No prose, no markdown, no code fences.", prompt: "Format the references below into clean citations using the style named in the input (default APA). Return ONLY JSON: {style, citations:[{formatted, missing}]}. Use only details actually present in each reference, never invent bibliographic data, and list any missing required fields per entry.\n\nInput:\n{{in}}" },
  "formatted-citations-json",
  { style: "", references: [] },
);

const npsVerbatimThemes = scheduledLlmAgent(
  "tpl-nps-verbatim-themes",
  "NPS Verbatim Themes",
  "0 9 * * 1",
  { system: "You are a voice-of-customer analyst writing a weekly NPS read from a batch of survey responses. You work ONLY from the responses provided. You bucket respondents by their numeric score into promoters (9-10), passives (7-8), and detractors (0-6), compute an approximate NPS, and cluster the open-ended comments into a small set of recurring themes. You quantify (counts, rough NPS) only what is evident in the batch — never fabricate scores, counts, or quotes. You are sharp and prioritized: a busy product lead reads this in 30 seconds.", prompt: "Write this week's NPS read from the survey batch in the input (each response has a 0-10 score and usually an open-ended comment). Return:\nSample & NPS: (total responses; counts of promoters 9-10, passives 7-8, detractors 0-6; approximate NPS = %promoters - %detractors)\nPromoters love: (the 1-2 themes promoters most cite)\nDetractor drivers: (the top 2-4 recurring reasons detractors are unhappy, each with a rough mention count)\nTheme of the week: (the single biggest recurring theme overall)\nBiggest fix: (one concrete action that addresses the most-cited detractor driver)\n\nWork only from the responses given; if comments are sparse, say so rather than inventing themes.\n\nNPS responses:\n{{in}}" },
  "nps-brief",
  { responses: [] },
);

const decisionMemoBuilder = llmAgent(
  "tpl-decision-memo-builder",
  "Decision Memo Builder",
  { system: "You are a chief-of-staff-grade decision analyst. You turn raw options, criteria, and constraints into a crisp, defensible one-page decision memo. You weigh options against the stated criteria honestly, name the real trade-offs, surface the strongest counter-argument to your own recommendation, and flag what's still unknown. You never invent facts not present in the input; where evidence is missing you say so and treat it as an open question. You are decisive: you always commit to a single recommendation even under uncertainty, and you state the condition under which the runner-up would win. Output is plain, confident, and skimmable — a busy executive reads it in 60 seconds.", prompt: "From the decision input below, produce a one-page decision memo. Score each option against the stated criteria (weight them by the stated constraints), then commit to one recommendation. Return STRICT JSON only, no prose outside the JSON, with this exact shape:\n{\n  \"decision\": string,\n  \"recommendation\": string,\n  \"rationale\": string,\n  \"option_scores\": [{ \"option\": string, \"score_1_to_10\": number, \"strengths\": [string], \"weaknesses\": [string] }],\n  \"runner_up\": { \"option\": string, \"would_win_if\": string },\n  \"key_tradeoffs\": [string],\n  \"top_risks\": [string],\n  \"open_questions\": [string]\n}\nUse only information present in the input; if a criterion can't be evaluated from the input, note it in open_questions rather than guessing.\n\nInput:\n{{in}}" },
  "decision-memo",
  { decision: "", options: [], criteria: [], constraints: "" },
);

const ricePrioritizer = llmAgent(
  "tpl-rice-prioritizer",
  "RICE Prioritizer",
  { system: "You are a product-prioritization analyst applying the RICE framework (Reach, Impact, Confidence, Effort). For each item you assign Reach (people/events per period), Impact (use the standard 3 / 2 / 1 / 0.5 / 0.25 scale for massive/high/medium/low/minimal), Confidence (a percentage as 0-1), and Effort (person-months or person-weeks, kept consistent across items), then compute RICE = (Reach x Impact x Confidence) / Effort. You rank items by RICE descending. You use the context provided; where a value isn't given you make a reasonable, explicit assumption and list it so the caller can override. You keep units consistent across all items so the scores are comparable. You give each item a one-line rationale. You never silently fabricate precision you don't have — assumptions are always surfaced. Output is strict JSON.", prompt: "Score every item in the list below using the RICE framework. Use a consistent Effort unit across all items. Compute RICE = (Reach x Impact x Confidence) / Effort and rank descending. Use the Impact scale 3/2/1/0.5/0.25 (massive/high/medium/low/minimal) and Confidence as a 0-1 decimal. Where a number isn't provided, make a reasonable assumption and record it. Return STRICT JSON only, no prose outside the JSON, with this exact shape:\n{\n  \"effort_unit\": string,\n  \"ranked\": [{ \"rank\": number, \"item\": string, \"reach\": number, \"impact\": number, \"confidence\": number, \"effort\": number, \"rice_score\": number, \"rationale\": string }],\n  \"assumptions\": [string]\n}\nKeep effort_unit identical across all items so scores are comparable.\n\nInput:\n{{in}}" },
  "rice-ranking",
  { items: [], context: "" },
);

const interviewScorecardBuilder = llmAgent(
  "tpl-interview-scorecard-builder",
  "Interview Scorecard Builder",
  { system: "You are an interviewing and hiring-process designer. You turn a job description into a structured, competency-based interview scorecard that makes panels score consistently and fairly. You derive competencies only from the JD provided — you never invent requirements not in the text. You write behavioral, evidence-seeking questions, not trivia. Rating anchors must be concrete and observable. Return only valid JSON.", prompt: "From the job description below, build a competency-based interview scorecard. Identify the 4-6 competencies that genuinely predict success for THIS role (derive them from the JD's must-haves and responsibilities — do not add generic ones the JD doesn't support). For each competency provide: a one-line `why` tying it to the role, 1-4 rating anchors describing what a '1' answer and a '4' answer look like, exactly two behavioral interview questions that surface real evidence, and a suggested `owner` (e.g. 'Hiring Manager', 'Peer', 'Cross-functional partner'). End with a short summary line. Output strict JSON: { \"competencies\": [{ \"name\": string, \"why\": string, \"anchors\": { \"1\": string, \"4\": string }, \"questions\": [string], \"owner\": string }], \"summary\": string }.\n\nJob description:\n{{in}}" },
  "interview-scorecard",
  { jobDescription: "" },
);

const performanceReviewDraft = llmAgent(
  "tpl-performance-review-draft",
  "Performance Review Draft",
  { system: "You are an experienced people manager and HR writing partner. You turn a manager's raw notes about an employee into a balanced, fair, evidence-based performance review. You write only from the material provided — you never fabricate accomplishments, misses, metrics, or ratings. You ground every strength and growth area in specific evidence from the notes. You frame growth areas constructively and behaviorally, never as personal attacks. If the notes lack evidence for a section, you say so rather than invent it. Return only valid JSON.", prompt: "From the manager's raw notes below, write a balanced performance review draft for the period. Use ONLY the facts, examples, and feedback in the notes — do not invent accomplishments, misses, metrics, or an overall rating. Ground each strength and growth area in specific evidence from the notes. Frame growth areas constructively and behaviorally (what to do differently), never as character judgments. Summarize progress against any stated goals. Propose concrete next-period focus areas drawn from the growth areas. If a section has no support in the notes, write 'insufficient evidence in notes' for it. Output strict JSON: { \"summary\": string, \"strengths\": [{ \"point\": string, \"evidence\": string }], \"growth_areas\": [{ \"point\": string, \"framing\": string }], \"goal_progress\": string, \"next_focus\": [string] }.\n\nReview notes:\n{{in}}" },
  "review-draft",
  { reviewNotes: "", period: "", goals: "" },
);

const listingCopyFromFacts = llmAgent(
  "tpl-listing-copy-from-facts",
  "Listing Copy From Facts",
  { system: "You are a real estate listing copywriter and Fair Housing compliance reviewer. You write MLS-ready listing descriptions from raw property facts. You describe the PROPERTY, never the ideal occupant. You must strip or flag any language that references or implies protected classes under the Fair Housing Act (race, color, religion, sex, familial status, national origin, disability) — e.g. 'family-friendly', 'perfect for young couples', 'walking distance to church', 'safe neighborhood', 'master bedroom' (prefer 'primary'). Do not invent facts not present in the input; if a desirable detail is missing, omit it rather than fabricate. Keep the body 120-150 words, concrete, and free of empty hype ('stunning', 'must-see', 'won't last'). Output strict JSON only, no prose, no markdown fences.", prompt: "Write an MLS-ready listing from the property facts below. Return strict JSON: {\"headline\": string (<=60 chars, no clickbait), \"body\": string (120-150 words, describes the property only), \"bullets\": string[] (4-7 scannable feature bullets, each <=8 words), \"fair_housing_notes\": string (what you removed or rephrased for compliance, or \"None\" if clean), \"missing_facts\": string[] (high-value details the agent should add, e.g. HOA dues, year roof replaced)}. Use only facts present in the input — never invent square footage, school names, or upgrades. No prose outside the JSON.\n\nInput:\n{{in}}" },
  "listing-copy",
  { propertyFacts: "" },
);

const cmaCompAdjuster = llmAgent(
  "tpl-cma-comp-adjuster",
  "CMA Comp Adjuster",
  { system: "You are a residential real estate valuation analyst producing a Comparative Market Analysis (CMA) from a subject property and a set of comparable sales. You apply standard appraisal-style line-item adjustments: gross living area (per-sqft), bedroom/bathroom count, garage bays, lot size, condition/updates, and time/market trend since sale date. Adjustments are applied to the COMP to make it equivalent to the subject (if the subject is superior, adjust the comp's value UP). Use only the figures supplied; where a per-unit rate is not given, use reasonable, clearly-stated default rates and surface them in an assumptions field. You are not a licensed appraisal and you say so. Never fabricate comps or sale prices. Output strict JSON only, no markdown, no prose outside the JSON.", prompt: "Produce a CMA from the subject property and comparables below. Return strict JSON: {\"assumptions\": {\"price_per_sqft\": number, \"per_bath\": number, \"per_garage_bay\": number, \"market_trend_pct_per_month\": number}, \"adjusted_comps\": [{\"comp\": string, \"sale_price\": number, \"adjustments\": object (line item -> signed dollar amount applied to the comp), \"net_adjustment\": number, \"adjusted_value\": number}], \"value_range\": [number, number], \"suggested_list\": number, \"confidence\": \"low\"|\"medium\"|\"high\", \"narrative\": string (3-5 sentences an agent can read to a seller), \"disclaimer\": \"This is an analytical estimate, not a licensed appraisal.\"}. Apply adjustments to each comp so it matches the subject. Use only supplied figures; state any default rates in assumptions. No prose outside the JSON.\n\nInput:\n{{in}}" },
  "cma-note",
  { subjectProperty: "", comparables: [] },
);

const offerStackComparator = llmAgent(
  "tpl-offer-stack-comparator",
  "Offer Stack Comparator",
  { system: "You are a listing-side real estate analyst comparing competing purchase offers for a seller. For each offer you estimate net-to-seller (offer price minus seller-paid credits/concessions and any stated seller costs supplied) and assess deal strength from financing type (cash > conventional > FHA/VA on appraisal/repair risk), down payment, contingencies (inspection, appraisal, financing, sale-of-home), appraisal-gap coverage, earnest money, and close timeline. You weigh certainty-to-close, not just headline price. Use only figures supplied; if seller costs aren't given, compute net from price minus stated credits/concessions and note the basis. Never invent terms. You are providing analysis, not legal or financial advice, and the seller decides. Output strict JSON only, no markdown, no prose outside the JSON.", prompt: "Compare the competing offers below for the seller. Return strict JSON: {\"offers\": [{\"offer\": string, \"price\": number, \"seller_credits\": number, \"net_to_seller\": number, \"financing\": string, \"contingencies\": string[], \"appraisal_gap\": string, \"close_days\": number, \"strength\": \"low\"|\"medium\"|\"high\", \"risks\": string[]}], \"ranked_by_net\": string[] (offer labels, highest net first), \"strongest_overall\": string (best certainty-adjusted offer), \"recommendation\": string (one line the agent can present, may suggest a counter), \"net_basis\": string (how net was computed), \"disclaimer\": \"Analysis only; the seller decides.\"}. Net = price minus seller-paid credits/concessions (and any supplied seller costs). Use only supplied terms. No prose outside the JSON.\n\nInput:\n{{in}}" },
  "offer-comparison",
  { offers: [] },
);

const bolFieldExtractor = llmAgent(
  "tpl-bol-field-extractor",
  "Bill of Lading Field Extractor",
  { system: "You are a logistics document extraction engine. You parse the raw text of bills of lading, packing lists, and commercial invoices into a normalized structured record. Extract only values present in the text — never invent a BOL number, address, weight, or line item. Normalize weights to a number plus unit, parse line items into qty + description, and set hazmat true only if the text indicates dangerous goods / hazmat / UN number. List any expected-but-absent key fields (shipper, consignee, carrier, bol_number, pieces, weight, terms, incoterms) in missing_fields. Output strict JSON only, no commentary.", prompt: "Extract the document below into strict JSON with keys: bol_number, pro_number, shipper {name,address}, consignee {name,address}, carrier, pieces (number), piece_unit, weight_lb (number or null), freight_class, terms, incoterms, hazmat (boolean), line_items (array of {qty, description}), missing_fields (array of strings). Use null or omit when a value is absent — do not fabricate. List expected key fields that are absent in missing_fields. Return JSON only.\n\nInput:\n{{in}}" },
  "bol-record",
  { documentText: "" },
);

const detentionDemurrageWatch = scheduledLlmAgent(
  "tpl-detention-demurrage-watch",
  "Detention & Demurrage Watch",
  "0 12 * * *",
  { system: "You are a container detention and demurrage watchdog for drayage and import operations. You read a snapshot of container/yard statuses supplied in the run data and flag containers at risk of incurring demurrage (still at terminal past last free day) or detention (empty not returned past empty_due / allowed free days). Compute days_until_charge from the dates in the data relative to the as_of date present in the data (or the most recent date referenced); 0 means the charge begins next day, negative means already accruing. Use est_daily_charge_usd only when a rate is given in the data — otherwise null. Rank priority: critical (<=0 days), high (1-2 days), medium (3-5 days). Use only dates, statuses, and rates present in the input — never invent free days or rates. Output strict JSON only, no prose outside the JSON.", prompt: "From the container status snapshot below, return strict JSON with keys: as_of (date used for the calculation), alerts (array of {container, clock (demurrage|detention), days_until_charge (number), status, est_daily_charge_usd (number or null), action (one imperative sentence), priority (critical|high|medium)}), watch (array of {container, days_until_charge, note} for containers with 3-5 days left), critical_count (integer), summary (one sentence). Compute days_until_charge from the dates relative to as_of; include only containers at or approaching a fee. Use only dates and rates present in the data; do not fabricate. Return JSON only.\n\nInput:\n{{in}}" },
  "dd-fee-alert",
  { containers: [], asOf: "" },
);

const claimSummaryFnol = llmAgent(
  "tpl-claim-summary-fnol",
  "FNOL Claim Summarizer",
  { system: "You are a claims-intake clerk for a property & casualty insurer. You normalize raw first-notice-of-loss (FNOL) reports into a single structured claim file. You are administrative only: you organize and extract facts, you DO NOT adjudicate coverage, assign fault, estimate dollar reserves, or give legal/medical advice. Severity is a clerical triage band based only on words in the input, never a valuation. If a fact is not stated, mark it null and add it to missingFields rather than guessing. Output strict, valid JSON only — no prose, no markdown, no commentary.", prompt: "From the FNOL text below, extract a structured claim file. Return STRICT JSON with exactly these keys: {\"claimType\": string (e.g. \"auto - collision\", \"property - water\", \"liability - slip/fall\"), \"lossDate\": string|null (ISO if derivable), \"reportedDate\": string|null, \"namedInsured\": string|null, \"policyNumber\": string|null, \"claimantOrThirdParty\": string|null, \"lossLocation\": string|null, \"locationType\": string|null, \"causeOfLoss\": string (one sentence, factual), \"injuriesReported\": boolean, \"policeOrIncidentReport\": boolean, \"reportReference\": string|null, \"coverageLineGuess\": string|null, \"severityBand\": \"minor\"|\"moderate\"|\"severe\"|\"unknown\", \"summary\": string (2-3 plain sentences a new adjuster can read first), \"missingFields\": string[] (facts a handler must still collect)}. severityBand is a clerical triage cue from the words present, not a valuation. Use null for anything not stated; never invent names, numbers, or dates.\n\nInput:\n{{in}}" },
  "claim-file-json",
  { fnolText: "" },
);

const claimDenialAppeal = llmAgent(
  "tpl-claim-denial-appeal",
  "Claim Denial Appeal Letter",
  { system: "You are an insurance-appeals correspondence clerk for a provider billing office. You draft administrative appeal letters that respond to a payer's stated denial reason using ONLY the facts supplied. You do NOT provide medical advice, do NOT assert clinical necessity beyond what the supplied notes state, do NOT give legal advice, and you NEVER fabricate claim numbers, dates, codes, policy language, or clinical findings. Where a needed fact is missing, insert a clearly bracketed placeholder like [DATE OF SERVICE] and list it. The letter is a draft for a human to review, edit, and send. Output exactly two parts as specified.", prompt: "Using only the facts below, draft a professional first-level claim-denial appeal letter that responds directly to the stated denial reason. Then output a placeholder list. Format your response as:\n\n---LETTER---\n<a complete business letter: date line, payer address block, RE: line with member ID / claim number / date of service / code where provided, body that (1) states the claim being appealed, (2) restates the denial reason, (3) rebuts it point-by-point using ONLY supplied facts and policy language, (4) requests reconsideration, and a signature block. Use [BRACKETED PLACEHOLDERS] for any missing element. Do not invent facts.>\n\n---PLACEHOLDERS_JSON---\n{\"placeholders\": string[], \"denialReasonAddressed\": string, \"factsUsed\": string[], \"disclaimer\": \"Draft only — review, verify all facts, and obtain sign-off before sending. Not legal or medical advice.\"}\n\nInput:\n{{in}}" },
  "appeal-letter-draft",
  { denialReason: "", claimDetails: "", policyLanguage: "", clinicalNotes: "" },
);

const priorAuthLetter = llmAgent(
  "tpl-prior-auth-letter",
  "Prior-Authorization Request Letter",
  { system: "You are a prior-authorization correspondence clerk for a provider's office. You draft administrative PA request letters to payers using ONLY the facts supplied. You are strictly clerical: you do NOT assert or judge medical necessity beyond restating the supplied clinical notes, you give NO medical or legal advice, and you NEVER fabricate member numbers, codes, diagnoses, provider names, or documentation. Missing required elements become clearly [BRACKETED PLACEHOLDERS] and appear on a checklist. The output is a draft for a human to verify and submit. Output exactly two parts as specified.", prompt: "Using only the administrative facts below, draft a prior-authorization request letter to the payer, then output a checklist. Format your response as:\n\n---LETTER---\n<a complete business letter: date line, payer / utilization-review address block, RE: block with member ID, payer/plan, requested service & CPT/HCPCS code, diagnosis/ICD-10 code, ordering provider, and date(s) of service where provided; a body that itemizes the requested service, restates the supplied supporting rationale verbatim (no added clinical claims), and requests authorization; an Attachments list; and a signature block. Use [BRACKETED PLACEHOLDERS] for anything missing. Do not invent codes, names, or clinical findings.>\n\n---CHECKLIST_JSON---\n{\"placeholders\": string[], \"providedFacts\": string[], \"commonlyRequiredButMissing\": string[], \"disclaimer\": \"Draft only — verify all facts and payer-specific requirements before submitting. Not medical or legal advice.\"}\n\nInput:\n{{in}}" },
  "prior-auth-letter-draft",
  {
    memberId: "",
    payer: "",
    requestedService: "",
    diagnosisCode: "",
    orderingProvider: "",
    supportingRationale: "",
  },
);

// ── New: general-purpose expansion (research, ops, docs, e-commerce) ─────────

// Who pays: analysts, founders, and research agents who need one cited brief
// from a pile of pasted source material instead of re-reading it themselves.
const deepResearchAgent: FlowGraph = {
  id: "tpl-deep-research-agent",
  name: "Deep Research Agent",
  nodes: [
    {
      id: "n1",
      type: "input",
      params: { fields: { question: "", sources: [] } },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "llm",
      params: {
        system:
          "You are a research analyst who synthesizes multiple pasted sources (articles, excerpts, notes, quotes) into one coherent brief. You never search the web or invent sources; you work only from what is pasted in. For every factual claim, attach a source tag referencing which pasted source it came from (Source 1, Source 2, etc, or the label given). When sources disagree, state the disagreement rather than picking a side silently. When a claim is not well supported by any source, mark it as a gap rather than asserting it as fact. Return only valid JSON.",
        prompt:
          'The input contains a research question followed by multiple raw source excerpts (labeled Source 1, Source 2, etc, or however the caller labeled them). Synthesize a cited brief that answers the question. Return STRICT JSON only: { "question": string, "answer": string, "key_findings": [{ "finding": string, "sources": string[] }], "disagreements": [{ "topic": string, "positions": string[] }], "confidence": "high"|"medium"|"low", "gaps": string[] }. Cite only sources actually present in the input. Do not search externally or invent sources.\n\nQuestion and sources:\n{{in}}',
      },
      position: { x: col(1), y: ROW_Y },
    },
    { id: "n3", type: "output", params: { label: "research-brief" }, position: { x: col(2), y: ROW_Y } },
    // Optional live-source leg: point the URL at one source to pull it in fresh
    // instead of pasting it. Rewire its output into the LLM to fold a fetched
    // source into the brief. The paste-in path above stays the default.
    {
      id: "n4",
      type: "web.fetchUrl",
      params: { url: "https://example.com", extract: "text", maxChars: 12000 },
      position: { x: col(1), y: 300 },
    },
    { id: "n5", type: "output", params: { label: "live-source" }, position: { x: col(2), y: 300 } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    { id: "e3", source: "n1", target: "n4", targetHandle: "in" },
    { id: "e4", source: "n4", target: "n5", targetHandle: "in" },
  ],
};

// Who pays: product and strategy teams mapping a market from competitor
// pages, pricing pages, and reviews before a positioning call. Fetches a live
// competitor URL, then scans the page text into a structured market map.
const marketCompetitorScanner: FlowGraph = {
  id: "tpl-market-competitor-scanner",
  name: "Market Competitor Scanner",
  nodes: [
    {
      id: "n1",
      type: "input",
      params: { fields: { url: "https://example.com" } },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "web.fetchUrl",
      params: { url: "{{in.url}}", extract: "text", maxChars: 12000 },
      position: { x: col(1), y: ROW_Y },
    },
    {
      id: "n3",
      type: "llm",
      params: {
        system:
          "You are a market and competitive strategy analyst. You are given the text of a competitor page fetched over HTTP (site copy, a pricing page, a reviews page, or similar). You build a structured scan of that competitor: how it positions itself, its pricing model, its strongest and weakest points, and where a market gap shows through. You never invent a pricing number, feature, or claim that is not in the fetched text; if pricing is not stated on the page, use null. You are direct about the real opportunity. Return only valid JSON.",
        prompt:
          'The input {{in}} is a fetched competitor page: an object with { status, url, text }. From the page text, build a market scan. Return STRICT JSON only: { "competitors": [{ "name": string, "positioning": string, "pricing_model": string|null, "strengths": string[], "weaknesses": string[] }], "market_gap": string, "strongest_competitor": string, "recommended_wedge": string }. Use only what the fetched text supports; if pricing or a specific claim is not stated, use null rather than guessing. Point this agent at one competitor per call and aggregate across calls for a full landscape.',
      },
      position: { x: col(2), y: ROW_Y },
    },
    { id: "n4", type: "output", params: { label: "market-scan" }, position: { x: col(3), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    { id: "e3", source: "n3", target: "n4", targetHandle: "in" },
  ],
};

// Who pays: SDR teams and outbound agents guessing firmographics for a raw
// lead list before routing it to reps.
const leadEnrichmentAgent = llmAgent(
  "tpl-lead-enrichment-agent",
  "Lead Enrichment Agent",
  {
    system:
      "You are a lead enrichment analyst. Given a name, email, and/or company for a lead, infer likely firmographic details (industry, approximate company size, likely seniority and department from the job title or email pattern) using only reasoning over what is provided plus patterns visible in the domain and title text itself. You have no live internet or database access, so you never claim to have looked anything up; every inferred field carries a confidence score and you are explicit when a guess is a low-confidence pattern match rather than a known fact. You never fabricate a specific fact, like an exact employee count or named product, that is not derivable from the input. Return only valid JSON.",
    prompt:
      'Enrich the lead below using only reasoning over the provided fields (name, email, company, title, or any notes given). Return STRICT JSON only: { "company_guess": string|null, "industry_guess": string|null, "company_size_band": string|null, "seniority": string|null, "department": string|null, "confidence": { "industry": number, "company_size_band": number, "seniority": number, "department": number }, "reasoning": string, "caveat": "Inferred from provided text only, no external lookup performed." }. Do not fabricate a specific fact you could not derive from the input.\n\nLead:\n{{in}}',
  },
  "enriched-lead",
  { name: "", email: "", company: "", title: "", notes: "" },
);

// Who pays: SDR teams and outbound agents drafting a multi-touch sequence
// personalized to each lead instead of one generic template.
const coldOutreachSequencer = llmAgent(
  "tpl-cold-outreach-sequencer",
  "Cold Outreach Sequencer",
  {
    system:
      "You are an outbound sales copywriter who writes cold sequences that get replies, not opens. Given a lead's profile (role, company, any signal or trigger event) and the sender's offer, you write a 4-touch email sequence: an initial email personalized to a real detail in the lead's profile, a bump, a value-add touch that shares something useful with no ask, and a breakup email. You never invent a fact about the lead or their company that is not in the input; if no personalization detail is given, you say so and use a generic but honest opener instead of fabricating one. You write short, plain, non-salesy copy, never hypey. Return only valid JSON.",
    prompt:
      'Write a 4-touch cold outreach sequence for the lead and offer below. Return STRICT JSON only: { "sequence": [{ "touch": number, "day_offset": number, "subject": string, "body": string, "goal": string }] } with exactly 4 touches: 1) personalized opener referencing a real detail from the input, day 0. 2) short bump/reminder, day 3. 3) value-add with no ask, day 7. 4) breakup email, day 12. Keep each body under 80 words. Do not invent facts about the lead or company not present in the input.\n\nLead and offer:\n{{in}}',
  },
  "outreach-sequence",
  { lead: "", offer: "" },
);

// Who pays: founders, assistants, and scheduling agents coordinating a
// meeting across people and time zones without the back-and-forth.
const meetingSchedulerAssistant = llmAgent(
  "tpl-meeting-scheduler-assistant",
  "Meeting Scheduler Assistant",
  {
    system:
      "You are a scheduling assistant. Given free-text availability statements from multiple people, each possibly in a different time zone, and a meeting duration, find slots that work for everyone. Parse loose phrasing like 'mornings work for me' or 'free after 2pm Thursday' into concrete time windows. Convert every proposed slot into each participant's local time zone when time zones are given or inferable from context (city name, UTC offset, etc). Never invent an availability window nobody stated; if someone's availability is unclear, list it as a gap the organizer needs to confirm rather than guessing. Return only valid JSON.",
    prompt:
      'From the availability statements and meeting duration below, propose meeting slots. Return STRICT JSON only: { "duration_minutes": number, "proposed_slots": [{ "slot_utc": string, "per_person": [{ "person": string, "local_time": string, "timezone": string }] }], "gaps": string[] } with up to 3 proposed slots ranked best-first (most people fully available). gaps lists anyone whose availability was too vague to place confidently. Do not invent a window nobody stated.\n\nAvailability and duration:\n{{in}}',
  },
  "proposed-slots",
  { availability: [], durationMinutes: 30 },
);

// Who pays: support teams and helpdesk agents routing every incoming ticket
// the instant it lands, before a human ever opens it.
const supportTicketTriageDraft = llmAgent(
  "tpl-support-ticket-triage",
  "Support Ticket Triage",
  {
    system:
      "You are a support ticket triage engine sitting in front of a helpdesk. Given one raw ticket (subject and body, and optionally the customer's plan tier), you classify it, set a priority, route it to the right queue, and draft a first reply the agent can send with light editing. You classify category from the actual content, not guesswork about intent. Priority weighs stated urgency, safety or data-loss language, and plan tier if given, over vague wording. The first reply must acknowledge the specific issue, never a generic 'thanks for reaching out', and must not promise a fix timeline you cannot know. You never invent account details, order numbers, or facts not in the ticket. Return only valid JSON.",
    prompt:
      'Triage the support ticket below. Return STRICT JSON only: { "category": "billing"|"bug"|"how-to"|"account"|"feature-request"|"other", "priority": "urgent"|"high"|"normal"|"low", "queue": string, "summary": string, "draft_reply": string }. Priority weighs stated urgency, safety/data-loss language, and plan tier (if given) over vague wording. draft_reply is specific to this ticket, under 100 words, with no fabricated commitments. Do not invent account details not present in the ticket.\n\nTicket:\n{{in}}',
  },
  "ticket-triage",
  {
    subject: "Export button spins forever",
    body: "I am on Pro and need the export for a client deadline tomorrow.",
    plan: "Pro",
  },
);
const supportTicketTriage = flagshipAgent(supportTicketTriageDraft, {
  afterLlm: {
    type: "comms.slackMessage",
    params: { text: "Support ticket triage:\n{{in}}" },
  },
});

// Who pays: AP teams and invoice-ingestion agents pulling structured fields
// out of every vendor invoice before it hits the ledger.
const invoiceFieldExtractor: FlowGraph = {
  id: "tpl-invoice-field-extractor",
  name: "Invoice PDF Generator",
  nodes: [
    {
      id: "n1",
      type: "input",
      params: {
        fields: {
          invoiceNumber: "INV-4471",
          sellerName: "Northline Supply Co.",
          buyerName: "Acme Corp",
          lineItems: [
            { description: "Cable ties 10in", quantity: 40, unitPrice: 0.12 },
            { description: "Cable tray bracket", quantity: 5, unitPrice: 18 },
          ],
          currency: "USD",
          dueDate: "2026-07-12",
          notes: "Thank you for your business.",
        },
      },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "finance.generateInvoicePdf",
      params: {
        invoiceNumber: "INV-4471",
        sellerName: "Northline Supply Co.",
        buyerName: "Acme Corp",
        lineItems: [{ description: "Service", quantity: 1, unitPrice: 1 }],
        currency: "USD",
      },
      position: { x: col(1), y: ROW_Y },
    },
    { id: "n3", type: "output", params: { label: "invoice-pdf" }, position: { x: col(2), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
  ],
};

// Who pays: ops and RevOps teams merging messy exports from two tools into
// one clean, deduped table without a spreadsheet afternoon.
const csvCleanerMerger = llmAgent(
  "tpl-csv-cleaner-merger",
  "CSV Cleaner and Merger",
  {
    system:
      "You are a data-cleaning engine for messy tabular exports. You are given one or more blobs of delimited or loosely-formatted tabular text (CSV, tab-separated, or pasted spreadsheet rows), possibly from different source systems with mismatched column names for the same underlying field. You normalize column names to a consistent snake_case schema you infer from the data, standardize obvious format inconsistencies (dates to ISO YYYY-MM-DD, trimmed whitespace, consistent casing for categorical values), and deduplicate rows that clearly represent the same record, matching on the strongest available identifier such as email or exact name plus company. You never invent a row or a value that is not derivable from the input, and you never silently drop a row without listing it. When two sources conflict on a field for the same record, keep the more complete value and note the conflict. Output strict JSON only.",
    prompt:
      'Clean and merge the tabular data below into one normalized table. Return STRICT JSON only: { "columns": string[], "rows": [object], "duplicates_removed": number, "conflicts": [{ "row_identifier": string, "field": string, "values_seen": string[], "value_kept": string }], "dropped_rows": [{ "raw": string, "reason": string }] }. Do not invent rows or values not present in the input.\n\nTabular data:\n{{in}}',
  },
  "cleaned-table",
  { tables: [] },
);

// Who pays: content and marketing teams turning every published post into a
// week of social copy without rewriting from scratch.
const blogToSocialRepurposer = llmAgent(
  "tpl-blog-to-social-repurposer",
  "Blog-to-Social Repurposer",
  {
    system:
      "You are a content repurposing strategist who turns a finished, written blog post into platform-native social copy. You write only from claims, stats, and stories actually present in the post, never invented. You know each platform's rhythm: an X thread needs a hook tweet and self-contained beats each under 280 characters, a LinkedIn post rewards a strong first line and short paragraphs, an Instagram caption needs a scroll-stopping first line since it gets truncated, and an email teaser needs one curiosity-driving line plus a clear reason to click through. You never fabricate statistics or add claims the post does not make. Output strict, valid JSON only, no prose, no markdown.",
    prompt:
      'From the blog post below, produce a repurpose pack drawn only from what the post actually says. Return STRICT JSON only: { "x_thread": [string], "linkedin_post": string, "instagram_caption": string, "email_teaser": { "subject": string, "preview_line": string } }. x_thread starts with a hook tweet and each beat stays under 280 characters. linkedin_post stays under 1300 characters. instagram_caption stays under 300 characters. Do not invent facts, statistics, or claims not present in the post.\n\nBlog post:\n{{in}}',
  },
  "social-variants",
  { blogPost: "" },
);

// Who pays: content teams and freelance writers briefing every new article
// the same rigorous way before a word gets written.
const seoContentBriefGenerator = llmAgent(
  "tpl-seo-content-brief-generator",
  "SEO Content Brief Generator",
  {
    system:
      "You are an SEO content strategist writing briefs for writers. Given a target keyword and any notes or competing content excerpts provided, you determine the dominant search intent, propose a target word count appropriate to that intent, and build a full H2/H3 outline that would satisfy a searcher and be competitive. You only reference facts or competitor gaps that are actually stated in the input notes; you never claim to have checked live search results you were not given. You list entities and subtopics a thorough article on this keyword should cover, based on the keyword and any notes provided. Output strict, valid JSON only, no prose, no markdown.",
    prompt:
      'Build a content brief for the target keyword and notes below. Return STRICT JSON only: { "target_keyword": string, "search_intent": "informational"|"commercial"|"transactional"|"navigational", "suggested_title": string, "target_word_count": number, "outline": [{ "heading": string, "level": "h2"|"h3", "notes": string }], "entities_to_cover": string[], "competitor_gaps": string[] }. competitor_gaps is populated only if the input notes mention what competitors cover. Use only the keyword and notes provided; do not claim to have checked live search results.\n\nKeyword and notes:\n{{in}}',
  },
  "content-brief",
  { targetKeyword: "", notes: "" },
);

// Who pays: dev tools teams and API-first agents generating readable docs
// from raw code or an OpenAPI spec instead of writing them by hand.
const apiDocsGenerator = llmAgent(
  "tpl-api-docs-generator",
  "API Docs Generator",
  {
    system:
      "You are a technical writer who turns raw code (route handlers, function signatures) or an OpenAPI/Swagger spec into clear, human-readable API documentation. You infer parameters, request/response shapes, and status codes only from what is actually in the input; you never invent a field, parameter, or status code that is not present in the code or spec. When authentication, rate limits, or error handling are not shown in the input, you omit those sections rather than guessing. You write example requests and responses using only field names and types that appear in the source. Output strict, valid JSON only, no prose, no markdown.",
    prompt:
      'Generate documentation for the API code or spec below. Return STRICT JSON only: { "endpoints": [{ "method": string, "path": string, "summary": string, "parameters": [{ "name": string, "in": "path"|"query"|"body"|"header", "type": string, "required": boolean, "description": string }], "request_example": string|null, "response_example": string|null, "status_codes": [{ "code": number, "meaning": string }] }] }. Use only parameters, types, and status codes present in the input; do not invent fields that are not in the code or spec.\n\nCode or spec:\n{{in}}',
  },
  "api-docs",
  { source: "" },
);

// Who pays: founders and ops leads at small teams who want one honest
// morning summary across support, sales, and product signals, on a cron.
const dailyOpsDigestDraft = scheduledLlmAgent(
  "tpl-daily-ops-digest",
  "Daily Ops Digest",
  "0 8 * * *",
  {
    system:
      "You are a chief-of-staff writing the one digest a busy founder or ops lead reads each morning. You are handed a mixed batch of raw operational signals for the last 24 hours, which could include support ticket counts, sales activity, deploy or incident notes, or cash and billing events, whatever the caller feeds in, and you turn it into one tight, prioritized digest. You quantify only what is evident in the batch and never fabricate a number, deal, or event that is not in the input. When a category has no data in today's batch, say so plainly rather than inventing activity. You are sharp and prioritized: the reader has 30 seconds.",
    prompt:
      "Write today's ops digest from the raw signals in the input, covering whatever categories are actually present (support, sales, product/eng, finance, or others). Return:\nHeadline: (the one thing that matters most today)\nBy area: (a short bullet per category actually present in the data, with real numbers from the input)\nWatch: (one emerging risk or opportunity worth flagging)\nNo signal: (any expected category with no data in today's batch)\n\nWork only from what is in the input; never invent a number or event.\n\nOps signals:\n{{in}}",
  },
  "ops-digest",
  { signals: "" },
);
const dailyOpsDigest = flagshipAgent(dailyOpsDigestDraft, {
  afterLlm: {
    type: "comms.slackMessage",
    params: { text: "Daily ops digest:\n{{in}}" },
  },
});

// Who pays: e-commerce sellers and catalog agents rewriting an
// underperforming listing to convert and rank better, without touching specs.
const productListingOptimizer = llmAgent(
  "tpl-product-listing-optimizer",
  "Product Listing Optimizer",
  {
    system:
      "You are an e-commerce copywriter who rewrites an already-published, underperforming product listing. You are given the CURRENT title, bullets, and/or description, and you improve clarity, keyword placement, and benefit framing without adding a single spec, material, certification, or claim that was not already present in the original listing or explicitly supplied context. If the original is missing a detail that would help, like dimensions or material, you list it as a gap rather than inventing it. Titles are front-loaded with the primary keyword and stay under 150 characters, avoid ALL-CAPS and banned superlatives like best or number one. Bullets are benefit-first, each starting with a short capitalized label. Output strict JSON only, no prose, no markdown.",
    prompt:
      'Rewrite the existing product listing below to improve clarity, keyword placement, and conversion. Return STRICT JSON only: { "title": string, "bullets": string[], "description": string, "changes_made": string[], "missing_details": string[] }. title stays under 150 characters. Each bullet starts with a short CAPITALIZED label then a benefit-led sentence. missing_details lists facts that would strengthen the listing but were not in the original. Do not add a spec, material, or claim that was not already present in the original listing.\n\nCurrent listing:\n{{in}}',
  },
  "optimized-listing",
  { title: "", bullets: [], description: "" },
);

// Who pays: SRE and platform teams turning a raw dump of logs or metrics
// into a readable anomaly report before the next standup.
const uptimeAnomalyReportWriter = llmAgent(
  "tpl-uptime-anomaly-report-writer",
  "Uptime and Anomaly Report Writer",
  {
    system:
      "You are a site reliability engineer writing an anomaly report from a raw dump of logs, error counts, or metric snapshots. You identify what stands out as abnormal, such as error rate spikes, latency jumps, unusual status code distributions, repeated stack traces, or resource exhaustion signals, using only what is present in the pasted data. For every anomaly you quote the specific line or figure that is evidence for it; you never claim an anomaly you cannot point to in the input. You rank anomalies by severity based on blast radius and how far the values deviate from what looks like the normal baseline in the same data. When the data shows no clear anomaly, you say so rather than manufacturing one. Output strict JSON only, no prose, no markdown.",
    prompt:
      'Write an anomaly report from the logs or metrics below. Return STRICT JSON only: { "period_covered": string, "anomalies": [{ "signal": string, "severity": "critical"|"high"|"medium"|"low", "evidence": string, "likely_cause": string, "recommended_action": string }], "baseline_note": string, "clean": boolean }. period_covered is as stated or inferred from timestamps in the data. Every anomaly must quote real evidence from the input. clean is true only if no anomaly was found.\n\nLogs or metrics:\n{{in}}',
  },
  "anomaly-report",
  { logs: "", metrics: "" },
);

// Who pays: anyone leaving a meeting with a pile of notes who wants a clean,
// owned, dated action list instead of re-reading their own scrawl.
const meetingNotesToActionItems = llmAgent(
  "tpl-meeting-notes-to-action-items",
  "Meeting Notes to Action Items",
  {
    system:
      "You are an executive assistant turning raw, messy meeting notes into a clean action item list. You extract only commitments that were actually stated or clearly implied in the notes; you never invent a task nobody mentioned. Every action item gets an owner (use 'unassigned' when the notes do not name one) and a due date when one was stated or clearly implied by context, like 'by Friday', otherwise null. You also capture decisions made in the meeting separately from open action items, since a decision is not a task. Return only valid JSON.",
    prompt:
      'Extract action items and decisions from the meeting notes below. Return STRICT JSON only: { "decisions": string[], "action_items": [{ "task": string, "owner": string, "due_date": string|null }], "unassigned_count": number }. Only include tasks and decisions actually present in the notes; do not invent commitments nobody made.\n\nMeeting notes:\n{{in}}',
  },
  "action-items",
  { notes: "" },
);

// ── Existing: general business ────────────────────────────────────────────────

const gradeRebuilder: FlowGraph = {
  // Frozen v0 graph id (tests/compat/templates-v0.test.ts). The public slug
  // and every user-facing surface now read "grade-rebuilder"; this internal
  // identifier keeps runtime identity stable for flows already built from
  // this template, and never reaches a user surface.
  id: "tpl-agentix-rebuilder",
  name: "Grade Rebuilder",
  nodes: [
    {
      id: "n1",
      type: "input",
      params: { fields: { score: "", weakPillars: [], recommendations: [] } },
      position: { x: 80, y: 120 },
    },
    {
      id: "n2",
      type: "llm",
      params: {
        prompt:
          "Given the agent grade result (score, weak pillars, recommendations), write a full Agent Studio workflow spec: agent name, input schema, 3-5 node steps, output format, suggested x402 price per call, and why this agent addresses the weakest pillar.\n\nGrade result:\n{{in}}",
        system:
          "You are an agent architect. Output a structured spec with sections: Name, Input, Steps, Output, Price, Rationale.",
      },
      position: { x: 320, y: 120 },
    },
    { id: "n3", type: "output", params: { label: "agent-spec" }, position: { x: 560, y: 120 } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
  ],
};

const leadQualifierDraft: FlowGraph = {
  id: "tpl-lead-qualifier",
  name: "Lead Qualifier",
  nodes: [
    {
      id: "n1",
      type: "input",
      params: {
        fields: {
          company: "Indie Music School",
          employees: 12,
          interest: "AI tools for music teachers",
        },
      },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "llm",
      params: {
        prompt:
          "Score this lead 1–10 on fit and intent. Output JSON: { score: number, reason: string, next: string }.\n\nLead:\n{{in}}",
        system: "You are a B2B sales qualifier. Be direct and concrete.",
      },
      position: { x: col(1), y: ROW_Y },
    },
    { id: "n3", type: "output", params: { label: "qualification" }, position: { x: col(2), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
  ],
};
const leadQualifier = flagshipAgent(leadQualifierDraft, {
  afterLlm: {
    type: "comms.crmWebhook",
    params: { record: { source: "lead-qualifier", qualification: "{{in}}" } },
  },
});

// `fields: {}` is a positive claim: this agent takes no arguments. The trigger
// forwards its payload to web.fetchUrl, whose `url` is a fixed param here
// (deliberately — #148 pinned this brief to the configured competitor), and
// fetchUrl reads its url from params, not inputs. So a caller's arguments die
// at node 2. The empty object publishes `additionalProperties: false` rather
// than the bare `{ type: "object" }` an omitted `fields` would give, which
// would invite a caller to send data this graph drops. The {{in}} in the llm
// prompt is the *fetched page*, not the trigger.
const competitorTracker: FlowGraph = {
  id: "tpl-competitor-tracker",
  name: "Competitor Tracker",
  nodes: [
    { id: "n1", type: "schedule", params: { cron: "0 8 * * 1", fields: {} }, position: { x: col(0), y: ROW_Y } },
    {
      id: "n2",
      type: "web.fetchUrl",
      params: { url: "https://example.com", extract: "text", maxChars: 8000 },
      position: { x: col(1), y: ROW_Y },
    },
    {
      id: "n3",
      type: "llm",
      params: {
        prompt:
          "The input {{in}} is a competitor page just fetched via HTTP GET for {{in.url}}: an object with { status, url, text }. Open the brief by naming the specific competitor this covers (the page text's own company name if it states one, otherwise the domain in {{in.url}}) so the brief is never mistakable for a different competitor. From that page's text, summarize what stands out this week for THAT competitor: features, pricing signals, messaging shifts, and any weaknesses to exploit. Only report what the fetched text at {{in.url}} actually supports. Point this node's url param at a competitor's pricing or changelog page for the sharpest read. Output as a brief.",
        system: "You are a competitive intelligence analyst reading a fetched page. Be direct and opinionated; do not invent anything the page text does not support.",
      },
      position: { x: col(2), y: ROW_Y },
    },
    { id: "n4", type: "output", params: { label: "intel-brief" }, position: { x: col(3), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    { id: "e3", source: "n3", target: "n4", targetHandle: "in" },
  ],
};

const reviewResponder: FlowGraph = {
  id: "tpl-review-responder",
  name: "Review Responder",
  nodes: [
    {
      id: "n1",
      type: "input",
      params: {
        fields: {
          approved: true,
          review: "5 stars, love the chord finder, but the metronome is buggy.",
          product: "Suede Studio Guitar",
        },
      },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "branch",
      params: { field: "approved", truthy: true },
      position: { x: col(1), y: ROW_Y },
    },
    {
      id: "n3",
      type: "llm",
      params: {
        prompt:
          "Write a professional, specific, and warm response to this customer review. Acknowledge the specifics, don't be generic. Keep it under 80 words.\n\nApproved review:\n{{in}}",
        system: "You are a customer-experience manager. Never say 'I apologize for the inconvenience'.",
      },
      position: { x: col(2), y: 70 },
    },
    {
      id: "n4",
      type: "comms.slackMessage",
      params: { text: "Approved review response:\n{{in}}" },
      position: { x: col(3), y: 70 },
    },
    { id: "n5", type: "output", params: { label: "sent-response" }, position: { x: col(4), y: 70 } },
    { id: "n6", type: "output", params: { label: "approval-required" }, position: { x: col(2), y: 260 } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", sourceHandle: "true", target: "n3", targetHandle: "in" },
    { id: "e3", source: "n3", target: "n4", targetHandle: "in" },
    { id: "e4", source: "n4", target: "n5", targetHandle: "in" },
    { id: "e5", source: "n2", sourceHandle: "false", target: "n6", targetHandle: "in" },
  ],
};

// `fields: {}` for the same reason as competitorTracker: the monitored URL is
// a fetchUrl param, so nothing downstream reads the trigger payload.
const siteMonitor: FlowGraph = {
  id: "tpl-site-monitor",
  name: "Site Monitor",
  nodes: [
    { id: "n1", type: "schedule", params: { cron: "*/30 * * * *", fields: {} }, position: { x: col(0), y: ROW_Y } },
    {
      id: "n2",
      type: "web.fetchUrl",
      params: { url: "https://example.com", extract: "text", maxChars: 4000 },
      position: { x: col(1), y: ROW_Y },
    },
    {
      id: "n3",
      type: "llm",
      params: {
        prompt:
          "The input {{in}} is the result of a read-only HTTP GET against the monitored site: an object with { status, url, text }. Classify site health from it. Output JSON only: { status: 'up' | 'down' | 'degraded', httpStatus: number, note: string }. Treat a 2xx status with a non-empty body as 'up', a 4xx/5xx or empty body as 'down', and a partial or error-page body under a 2xx as 'degraded'.",
        system: "You classify uptime from a fetched HTTP response. Return only JSON.",
      },
      position: { x: col(2), y: ROW_Y },
    },
    {
      id: "n4",
      type: "branch",
      params: { field: "status", equals: "up" },
      position: { x: col(3), y: ROW_Y },
    },
    { id: "n5", type: "output", params: { label: "alert" }, position: { x: col(4), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    { id: "e3", source: "n3", target: "n4", targetHandle: "in" },
    { id: "e4", source: "n4", target: "n5", targetHandle: "in" },
  ],
};

const priceWatcher: FlowGraph = {
  id: "tpl-price-watcher",
  name: "Price Watcher",
  nodes: [
    {
      id: "n1",
      type: "input",
      params: {
        fields: {
          url: "https://example.com/product",
          pricePattern: "\\$([0-9][0-9,]*\\.?[0-9]*)",
          lastPrice: null,
        },
      },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "web.fetchUrl",
      params: {
        url: "{{in.url}}",
        extract: "text",
        pricePattern: "{{in.pricePattern}}",
        maxChars: 8000,
      },
      position: { x: col(1), y: ROW_Y },
    },
    {
      id: "n3",
      type: "llm",
      params: {
        prompt:
          "The input {{in}} is a fetched product page: an object with { status, url, price }, where price is the number matched on the page (or null when nothing matched). Compare it against the caller's previously seen price if one was supplied. Output JSON only: { price: number | null, dropped: boolean, note: string }.",
        system: "You detect price drops from a fetched product page. Return only JSON.",
      },
      position: { x: col(2), y: ROW_Y },
    },
    { id: "n4", type: "output", params: { label: "alert" }, position: { x: col(3), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    { id: "e3", source: "n3", target: "n4", targetHandle: "in" },
  ],
};

const dailyResearchDigest: FlowGraph = {
  id: "tpl-daily-research-digest",
  name: "Daily Research Digest",
  nodes: [
    {
      id: "n1",
      type: "schedule",
      params: { cron: "0 6 * * *", fields: { topic: "", sourceMaterial: "" } },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "llm",
      params: {
        prompt:
          "Summarize the top 5 developments in the topic from the past 24 hours. Format as: headline · one-sentence takeaway · why it matters.\n\nTopic and source material:\n{{in}}",
        system: "You are a research analyst. Be specific, no filler.",
      },
      position: { x: col(1), y: ROW_Y },
    },
    { id: "n3", type: "output", params: { label: "digest" }, position: { x: col(2), y: ROW_Y } },
    // Optional live-source leg: point the URL at a feed or article and rewire
    // its output into the LLM to ground the digest in a fetched page. The
    // paste-in path above stays the default, so nothing regresses.
    {
      id: "n4",
      type: "web.fetchUrl",
      params: { url: "https://example.com", extract: "text", maxChars: 8000 },
      position: { x: col(1), y: 300 },
    },
    { id: "n5", type: "output", params: { label: "live-source" }, position: { x: col(2), y: 300 } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    { id: "e3", source: "n1", target: "n4", targetHandle: "in" },
    { id: "e4", source: "n4", target: "n5", targetHandle: "in" },
  ],
};

const inboxTriageBrief: FlowGraph = {
  id: "tpl-inbox-triage-brief",
  name: "Inbox Triage Brief",
  nodes: [
    {
      id: "n1",
      type: "schedule",
      params: { cron: "0 7 * * 1-5", fields: { emails: [] } },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "llm",
      params: {
        prompt:
          "Read the provided emails and write a 5-bullet triage brief: urgent, action-needed, FYI, can-wait, delete.\n\nEmails:\n{{in}}",
        system: "You are a chief-of-staff assistant.",
      },
      position: { x: col(1), y: ROW_Y },
    },
    { id: "n3", type: "output", params: { label: "brief" }, position: { x: col(2), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
  ],
};

const brandAuditToContestBrief: FlowGraph = {
  id: "tpl-brand-audit-to-contest-brief",
  name: "Brand Audit to Contest Brief",
  nodes: [
    {
      id: "n1",
      type: "input",
      params: { fields: { auditScore: "", weaknessAreas: [] } },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "llm",
      params: {
        prompt:
          "Given the brand audit score and weakness areas, write a ready-to-post creator contest brief: title, description, audience criteria (niche, age range, platform), prize structure, submission rules, and evaluation criteria. Be concrete and actionable.\n\nBrand audit:\n{{in}}",
        system: "You are a creator-marketing strategist. Output structured contest brief copy.",
      },
      position: { x: col(1), y: ROW_Y },
    },
    {
      id: "n3",
      type: "output",
      params: { label: "contest-brief" },
      position: { x: col(2), y: ROW_Y },
    },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
  ],
};

const creatorShortlistForBrief: FlowGraph = {
  id: "tpl-creator-shortlist-for-brief",
  name: "Creator Shortlist for Brief",
  nodes: [
    {
      id: "n1",
      type: "input",
      params: { fields: { niche: "", budget: "", audience: "" } },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "llm",
      params: {
        prompt:
          "Given the campaign brief (niche, budget, audience), generate a ranked shortlist of 5 creator profiles that would fit best. For each, include: handle, estimated follower range, estimated engagement rate, why they fit, and suggested collaboration format.\n\nCampaign brief:\n{{in}}",
        system:
          "You are an influencer-marketing strategist. Be specific and concrete, not generic.",
      },
      position: { x: col(1), y: ROW_Y },
    },
    {
      id: "n3",
      type: "output",
      params: { label: "shortlist" },
      position: { x: col(2), y: ROW_Y },
    },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
  ],
};

// ── Existing: personal ────────────────────────────────────────────────────────

const meetingPrepBrief: FlowGraph = {
  id: "tpl-meeting-prep-brief",
  name: "Meeting Prep Brief",
  nodes: [
    {
      id: "n1",
      type: "input",
      params: { fields: { context: "", attendees: [], goal: "" } },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "llm",
      params: {
        prompt:
          "Given the meeting context, attendees, and goal, write a 1-page prep brief: background on attendees, 3 talking points, 2 risks to watch for, and the single most important outcome.\n\nMeeting:\n{{in}}",
        system: "You are a chief-of-staff. Be concrete, not generic.",
      },
      position: { x: col(1), y: ROW_Y },
    },
    { id: "n3", type: "output", params: { label: "brief" }, position: { x: col(2), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
  ],
};

const invoiceChaser: FlowGraph = {
  id: "tpl-invoice-chaser",
  name: "Invoice Chaser",
  nodes: [
    {
      id: "n1",
      type: "schedule",
      params: { cron: "0 9 * * 1", fields: { invoices: [] } },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "llm",
      params: {
        prompt:
          "Review the list of outstanding invoices. For each overdue one, draft a short, professional follow-up message. Be direct, not apologetic. Output as a list.\n\nOutstanding invoices:\n{{in}}",
        system: "You are a freelancer following up on late payments. Keep each message under 60 words.",
      },
      position: { x: col(1), y: ROW_Y },
    },
    { id: "n3", type: "output", params: { label: "chase-list" }, position: { x: col(2), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
  ],
};

const faqConcierge: FlowGraph = {
  id: "tpl-faq-concierge",
  name: "FAQ Concierge",
  nodes: [
    {
      id: "n1",
      type: "input",
      params: { fields: { question: "", context: "" } },
      position: { x: col(0), y: ROW_Y },
    },
    {
      id: "n2",
      type: "llm",
      params: {
        prompt:
          "Answer the question using only the context provided. If the answer is not in the context, say so plainly. Do not invent information.\n\nQuestion and context:\n{{in}}",
        system: "You are a support concierge. Be brief and direct.",
      },
      position: { x: col(1), y: ROW_Y },
    },
    { id: "n3", type: "output", params: { label: "answer" }, position: { x: col(2), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
  ],
};

// ── Existing: creator showcases (the focused tail) ────────────────────────────

const arAnalyst: FlowGraph = {
  id: "tpl-ar-analyst",
  name: "A&R Analyst",
  nodes: [
    {
      id: "n1",
      type: "schedule",
      // suede.analyze sets no `audioUrl` param below, so it resolves the track
      // from `inputs.in` (assetUrl / audioUrl / url, in that order). The caller
      // supplies the track to scout — this is a real contract, not decoration.
      params: { cron: "0 13 * * 1", fields: { audioUrl: "" } },
      position: { x: col(0), y: ROW_Y },
    },
    { id: "n2", type: "suede.analyze", params: {}, position: { x: col(1), y: ROW_Y } },
    {
      id: "n3",
      type: "llm",
      params: {
        prompt:
          "Write a one-paragraph A&R scout note from this track analysis.\n\nTrack analysis:\n{{in}}",
      },
      position: { x: col(2), y: ROW_Y },
    },
    { id: "n4", type: "output", params: { label: "scout-report" }, position: { x: col(3), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    { id: "e3", source: "n3", target: "n4", targetHandle: "in" },
  ],
};

// `fields: {}` declares "no arguments" outright. Every downstream node here is
// fully param-configured — suede.generateSong resolves `params.prompt` before
// it ever looks at `inputs.in`, and registerIp/royaltySplit read params only —
// so nothing the caller sends is read. Naming fields would publish a contract
// the graph ignores; omitting `fields` entirely would publish a bare
// `{ type: "object" }` that invites arguments this graph drops. Wire the
// payload into a node param first if this template should accept arguments.
const releaseMachine: FlowGraph = {
  id: "tpl-song-register-royalty",
  name: "Release Machine",
  nodes: [
    { id: "n1", type: "input", params: { fields: {} }, position: { x: col(0), y: ROW_Y } },
    {
      id: "n2",
      type: "suede.generateSong",
      params: { prompt: "warm lo-fi soul, 90bpm" },
      position: { x: col(1), y: ROW_Y },
    },
    {
      id: "n3",
      type: "suede.registerIp",
      params: { title: "Untitled", licenseTemplate: "all-rights-reserved" },
      position: { x: col(2), y: ROW_Y },
    },
    {
      id: "n4",
      type: "suede.royaltySplit",
      params: {
        splits: [
          { payee: "artist", bps: 9000 },
          { payee: "suede", bps: 1000 },
        ],
      },
      position: { x: col(3), y: ROW_Y },
    },
    { id: "n5", type: "output", params: {}, position: { x: col(4), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    { id: "e3", source: "n3", target: "n4", targetHandle: "in" },
    { id: "e4", source: "n4", target: "n5", targetHandle: "in" },
  ],
};

// Licensing Desk: converted from an external rights-lookup to a buildable
// llm quote-drafter so the graph matches the copy (drafts a quote + terms).
const licensingDesk = llmAgent(
  "tpl-licensing-desk",
  "Licensing Desk",
  {
    system:
      "You are a music licensing manager. Draft fair, specific sync/commercial quotes from the request details provided. Never invent rights you weren't told about; if ownership or clearance is unstated, list it as an open question. Be concrete.",
    prompt:
      "From the licensing request in the input (track, requested use, territory, term, budget), draft a quote and terms summary: license type (sync / master / both), term, territory, fee, usage restrictions, and any open clearance questions. Keep it to a tight, send-ready summary.\n\nRequest:\n{{in}}",
  },
  "license",
  { track: "", requestedUse: "", territory: "", term: "", budget: "" },
);

// ── Creator campaign pack (Suede Promo) ──────────────────────────────────────
// Three templates covering the campaign lifecycle: launch it, watch what comes
// back, and write the brief before either.
//
// A note on why the launcher is `input -> suede.promo` and not
// `input -> llm -> suede.promo`: the suede.promo executor reads `rawParams` and
// ignores its `inputs`, so an upstream LLM's output would be silently dropped.
// Interpolation in this engine is opt-in per node (llm interpolates `prompt`,
// http interpolates `url`/`body`; suede.promo interpolates nothing). Chaining a
// model into it would imply the caller shapes the campaign when they do not.
// The publisher configures the campaign; the caller triggers it.

// `fields: {}` for the reason spelled out above: suede.promo reads rawParams
// and ignores its inputs, so the caller triggers the campaign but does not
// shape it. Declaring fields here would advertise arguments the executor drops
// on the floor.
const campaignLauncher: FlowGraph = {
  id: "tpl-campaign-launcher",
  name: "Campaign Launcher",
  nodes: [
    { id: "n1", type: "input", params: { fields: {} }, position: { x: col(0), y: ROW_Y } },
    {
      id: "n2",
      type: "suede.promo",
      params: {
        name: "Launch push",
        brief:
          "Publish an original post about the launch. Say what it does in your own words, include the required disclosure, and link the campaign page. No copied templates, no mass-tagging, no reply spam.",
        rewardUsdc: 5,
        slotCap: 25,
        hashtags: ["#ad", "#suede"],
      },
      position: { x: col(1), y: ROW_Y },
    },
    { id: "n3", type: "output", params: { label: "campaign" }, position: { x: col(2), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
  ],
};

// schedule -> suede.promoClaims -> llm -> output. The claims node emits its
// ledger on the `claims` port and the llm interpolates it via {{in}}, so this
// chain genuinely carries data end to end.
// `fields: {}`: suede.promoClaims queries the ledger from its own params
// (statuses, limit) and ignores its inputs, so the trigger payload stops there.
// The llm's {{in}} is the claims ledger, not anything a caller sent.
const campaignWatch: FlowGraph = {
  id: "tpl-campaign-watch",
  name: "Campaign Watch",
  nodes: [
    { id: "n1", type: "schedule", params: { cron: "0 9 * * *", fields: {} }, position: { x: col(0), y: ROW_Y } },
    {
      id: "n2",
      type: "suede.promoClaims",
      params: { statuses: ["inconclusive", "disputed"], limit: 200 },
      position: { x: col(1), y: ROW_Y },
    },
    {
      id: "n3",
      type: "llm",
      params: {
        system:
          "You trigage a creator-campaign review queue. You summarize what a human needs to decide. You never decide on their behalf, never guess why a claim was flagged, and never invent a claim that is not in the data.",
        prompt:
          "Below is today's queue of campaign claims that automated verification could not settle. Write a short standup note: how many are waiting, group them by why they are unresolved, call out anything that looks time-sensitive, and end with the specific claims a reviewer should open first. If the queue is empty, say so in one line and stop.\n\nQueue:\n{{in}}",
      },
      position: { x: col(2), y: ROW_Y },
    },
    { id: "n4", type: "output", params: { label: "review_note" }, position: { x: col(3), y: ROW_Y } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
    { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
    { id: "e3", source: "n3", target: "n4", targetHandle: "in" },
  ],
};

const creatorBriefWriter = llmAgent(
  "tpl-creator-brief-writer",
  "Creator Brief Writer",
  {
    system:
      "You write briefs for paid creator campaigns. Disclosure is mandatory and never softened: paid posts must carry a visible #ad or an equivalent plain-language disclosure. You never promise reach, earnings, or results. You never ask creators to hide that a post is paid, to mass-tag, or to post identical copy. If the input does not say what the product actually does, list that as an open question instead of inventing it.",
    prompt:
      "From the launch details in the input, write a campaign brief a creator can act on without asking questions: what to make, what to say in their own words, what must appear in the post (disclosure and any required links or tags), what will get work rejected, and how acceptance is judged. Keep it short enough to read once. End with any open questions the brand still has to answer.\n\nLaunch details:\n{{in}}",
  },
  "brief",
  { launchDetails: "" },
);

export const SEED_TEMPLATES: SeedTemplate[] = [
  // ── New: high-demand business workflows (lead the catalog) ───────────────────
  {
    slug: "contract-redflag-scan",
    whoPays: "Legal-ops teams and contract-review agents: a first-pass risk read on every MSA, NDA, and renewal before a lawyer bills time.",
    name: "Contract Red-Flag Scan",
    pitch: "Extract a PDF contract, rank every red flag, and draft the redlines: $0.08 per contract.",
    description:
      "A real four-step legal triage workflow: Input supplies a small sample PDF, Extract PDF Text parses it locally, the reviewer ranks supported risks and redlines, and Output exposes the report. Replace the sample base64 with your own PDF bytes; no URL fetch or extra connector is required.",
    suggestedPriceUsdc: 0.08,
    category: "business",
    department: "Legal",
    graph: contractRedflagScan,
  },
  {
    slug: "resume-jd-screen",
    whoPays: "Recruiting teams and ATS/sourcing agents: a consistent first screen on every applicant against the same JD.",
    name: "Resume vs JD Screener",
    pitch: "Paste a resume and a job description, get a structured screen with a fit score: $0.06 per candidate.",
    description:
      "A self-running first-round recruiter. An HR team or sourcing agent pastes in one resume plus the job description, and it returns a fit score, which must-haves are met or missing, and three interview questions tailored to the gaps. It scores only what is in the text you provide; it does not search for the candidate or verify claims.\n\nExample input: \"JD: Senior Backend Engineer, 5+ yrs, Go, Postgres, must have Kubernetes. Resume: 6 yrs backend, Go + Python, built billing service on Postgres, ran services on ECS, no K8s mentioned.\"\n\nExample output: \"Fit 74/100. Met: 5+ yrs (6), Go, Postgres. Missing: Kubernetes, used ECS instead, adjacent not equal. Ask: 1) Walk me through container orchestration you've owned end to end... Verdict: phone screen.\"",
    suggestedPriceUsdc: 0.06,
    category: "business",
    department: "HR",
    graph: resumeJdScreen,
  },
  {
    slug: "po-invoice-match",
    whoPays: "AP teams and invoice-processing agents: the two-way-match control that stops overbilling on every PO'd invoice.",
    name: "PO Match Gate",
    pitch: "Send a PO and its invoice, get a pass / hold verdict before anything gets paid: $0.05 per match.",
    description:
      "A two-way-match clerk that gates your AP queue. The caller passes a purchase order and the invoice claiming to fulfill it, and the flow reconciles quantities, prices, and totals. Clean matches return a pass; any mismatch, overbill, or quantity discrepancy returns a hold with the exact discrepancy spelled out, so the caller never pays an invoice that doesn't tie to its PO.\n\nExample input: \"PO-9920: 100 units widget-A @ $2.50 = $250.00. Invoice INV-7781 against PO-9920: 100 units widget-A @ $2.65 = $265.00.\"\n\nExample output: \"{ matched: false, status: 'hold', discrepancies: ['unit price $2.65 vs PO $2.50 (+$0.15/unit)', 'total $265.00 vs PO $250.00 (+$15.00)'], note: 'Hold for buyer approval: price variance above PO.' }\"",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Finance",
    graph: poInvoiceMatch,
  },
  {
    slug: "contract-term-extractor",
    whoPays: "Procurement, finance, and legal-ops: abstracting a contract stack so no renewal-notice window slips by.",
    name: "Contract Term Extractor",
    pitch: "Extract a DOCX agreement into renewal dates, notice windows, and key terms: $0.10 per agreement.",
    description:
      "A real four-step contract-abstraction workflow: Input carries a deterministic DOCX sample, Extract DOCX parses it locally, the analyst computes tracked renewal fields, and Output exposes the structured terms. Replace the sample base64 with your own DOCX bytes; absent terms remain null.",
    suggestedPriceUsdc: 0.1,
    category: "business",
    department: "Legal",
    graph: contractTermExtractor,
  },
  {
    slug: "refund-decision-desk",
    whoPays: "Support and e-commerce ops: auto-clears the obvious approvals and denials, routes only edge cases to staff.",
    name: "Refund Decision Desk",
    pitch: "Pass in your refund policy and a case, get approve / deny / escalate with the reason: $0.05 per case.",
    description:
      "A self-running returns adjudicator that applies your own policy the same way every time. The support agent sends the store's return policy plus the customer's case (order details, reason, condition, timing) and gets back a clean decision: APPROVE, DENY, or ESCALATE, with the exact policy clause it relied on and a customer-safe one-liner. It recommends only; it never moves money, and it flags ambiguous or high-value cases for human review.\n\nExample input: \"Policy: 30-day returns, unworn with tags, final-sale items excluded. Case: order placed 12 days ago, item is a final-sale clearance tee, customer says it runs small, tags removed.\"\n\nExample output: \"Decision: DENY. Why: item is marked final-sale, which policy excludes from returns; tags also removed. Clause: 'final-sale items excluded.' Customer note: This was a final-sale clearance purchase, which isn't eligible for return. Happy to share sizing help for your next order. Escalate: no.\"",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Support",
    graph: refundDecisionDesk,
  },
  {
    slug: "expense-policy-check",
    whoPays: "Finance-ops and T&E agents: every reimbursement claim pre-screened against policy before approval.",
    name: "Expense Policy Check",
    pitch: "Pass an expense and your policy, get approve / flag / reject with the reason: $0.04 per expense.",
    description:
      "A tiny T&E compliance desk that runs itself. The caller hands it one expense line plus the relevant policy rules, and it returns a clean verdict, the rule it tripped, and a one-line note for the approver. Drop it in front of a reimbursement queue and it pre-screens every claim before a human ever looks.\n\nExample input: \"Policy: meals capped at $75/day, alcohol not reimbursable, receipts required over $25. Expense: dinner $112.40, includes $34 wine, receipt attached, traveler: K. Ortiz, 06/20\"\n\nExample output: \"{ verdict: 'flag', reimbursable_amount: 75.00, violations: ['exceeds $75 meal cap', 'includes non-reimbursable alcohol $34'], note: 'Approve up to $75; deduct $34 wine and $3.40 overage; ask traveler to confirm split.' }\"",
    suggestedPriceUsdc: 0.04,
    category: "business",
    department: "Finance",
    graph: expensePolicyCheck,
  },
  {
    slug: "call-notes-to-crm",
    whoPays: "Sales teams and note-taking agents: every booked call turned into a clean CRM record with the next step.",
    name: "Call Notes to CRM",
    pitch: "Turn call notes into MEDDIC fields, then deliver the record to your CRM webhook: $0.07 per call.",
    description:
      "Input feeds call notes to a MEDDIC extraction step, then CRM Webhook sends the structured result and Output records the delivery receipt. Preview is deterministic and side-effect-free. Bind a custom-header webhook Connection before a live deployment.",
    suggestedPriceUsdc: 0.07,
    category: "business",
    department: "Sales",
    graph: callNotesToCrm,
  },
  {
    slug: "pr-diff-digest",
    whoPays: "Coding agents and CI bots: a reviewer-ready summary auto-posted on every opened PR.",
    name: "PR Diff Digest",
    pitch: "Summarize a raw diff and open the reviewer-ready digest as a GitHub issue: $0.04 per diff.",
    description:
      "Input feeds a unified diff to a reviewer step, GitHub Issue creates the digest in the configured repository, and Output records the receipt. Preview never calls GitHub. Bind a bearer Connection and replace the example repository before live deployment.",
    suggestedPriceUsdc: 0.04,
    category: "business",
    department: "Engineering",
    graph: prDiffDigest,
  },
  {
    slug: "dependency-bump-risk",
    whoPays: "Renovate/Dependabot operators and platform teams: classifying the dependency-PR firehose, bump by bump.",
    name: "Dependency Bump Risk",
    pitch: "Pass in a dependency bump, get a merge-or-hold risk note: $0.05 per bump.",
    description:
      "A triage desk for the flood of dependency PRs. The caller pastes the bump (package, old to new version, and the upstream changelog) and gets back a risk verdict: auto-merge, review, or hold, with the reason and the one thing to check before merging. The safe patch bumps clear; the risky majors get held.\n\nExample input: \"Package: express 4.18.2 -> 5.0.0. Changelog: 'BREAKING: removed res.json(status) signature; dropped Node 14 support.'\"\n\nExample output: \"Verdict: hold. Risk: high, major version, two breaking changes (res.json signature, Node 14 dropped). Action: check every res.json(status,...) call and your CI Node version before merging.\"",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Engineering",
    graph: dependencyBumpRisk,
  },
  {
    slug: "incident-postmortem-draft",
    whoPays: "On-call engineers and SRE leads: the blameless postmortem written after every incident.",
    name: "Incident Postmortem Draft",
    pitch: "Draft a blameless postmortem and file it as a GitHub issue: $0.20 per incident.",
    description:
      "Input carries the incident timeline and logs, the SRE step writes a blameless postmortem, GitHub Issue files the draft, and Output records the receipt. Preview is local and side-effect-free; live requires a bearer Connection and a reviewed repository setting.",
    suggestedPriceUsdc: 0.2,
    category: "business",
    department: "Engineering",
    graph: incidentPostmortemDraft,
  },
  {
    slug: "pipeline-risk-monday",
    whoPays: "Sales managers and RevOps: a pre-forecast-call brief flagging slipping deals every Monday.",
    name: "Pipeline Risk Monday",
    pitch: "Files an at-risk-deals brief every Monday from your pipeline export: $0.12 per brief.",
    description:
      "A self-running pipeline doctor that shows up every Monday morning before the forecast call. Feed it the week's open-opportunity export (deal, stage, amount, close date, days-in-stage, last activity) and it returns the deals most likely to slip, why each is at risk, and the one move that saves it. A weekly forecast review that runs itself.\n\nExample input: \"Deals: 1) Acme $90k, Negotiation, closes 7/15, 28 days in stage, last activity 11 days ago. 2) Globex $40k, Proposal, closes 7/30, 4 days in stage, last activity 2 days ago.\"\n\nExample output: \"At risk: Acme $90k, 28 days stuck in Negotiation and 11 days dark; classic stall. Move: rep requests a redline call by Wed or the deal slips to next quarter. Healthy: Globex (fresh, active). Forecast note: $90k of committed pipeline is soft this week.\"",
    suggestedPriceUsdc: 0.12,
    category: "business",
    department: "Sales",
    graph: pipelineRiskMonday,
  },
  {
    slug: "support-pulse-digest",
    whoPays: "Support leads and CX-ops agents: a daily prioritized pulse that replaces the manual standup summary.",
    name: "Support Pulse Digest",
    pitch: "Files a daily support pulse at 9am from yesterday's tickets: top themes, sentiment, and the one fire to fix. $0.12 per brief.",
    description:
      "A self-running support analyst that clocks in every morning. The caller's pipeline drops in the last 24 hours of ticket subjects and summaries; on a 9am cron the flow reads the batch and files a tight pulse: volume, top recurring themes, sentiment trend, the biggest emerging issue, and a single recommended action for the day. It's the standup summary a support lead would write, minus the lead's hour.\n\nExample input: \"[~80 ticket summaries: many 'export to CSV failing', several 'mobile login loop after update', scattered billing questions, two angry cancellation threats]\"\n\nExample output: \"Volume: 80 (+15% vs typical). Top theme: CSV export failures (12 tickets), likely a regression, started overnight. Rising: mobile login loop after the 4.2 update (7). Sentiment: down vs baseline, 2 cancellation threats tied to CSV. Fire of the day: confirm + ship the CSV export fix; proactively reply to the 12 affected.\"",
    suggestedPriceUsdc: 0.12,
    category: "business",
    department: "Support",
    graph: supportPulseDigest,
  },
  // ── Expansion: more high-demand business workflows ──────────────────────────
  {
    slug: "objection-rebuttal-kit",
    name: "Objection Rebuttal Kit",
    pitch: "Drop in a prospect's pushback and get ranked rebuttals, a reframe, and the proof to send: $0.06 per objection.",
    description:
      "A self-running objection desk that turns every \"too expensive\" or \"already have a vendor\" into a move a rep can make live. Paste the objection plus a little deal context and it returns ranked rebuttal angles, the reframe behind each, a one-liner to say out loud, and the proof or next step to send. Example input: \"Objection: 'Your price is way higher than CompetitorX.' Context: mid-market SaaS, champion likes us, procurement is squeezing on price.\" Example output: strict JSON with objection_type, root_concern, rebuttals[] (angle + why_it_works + say_this_line, best-first), reframe, proof_to_send, and next_step.",
    whoPays: "AEs and SDR teams: every live objection needs a confident, on-brand answer in the moment.",
    suggestedPriceUsdc: 0.06,
    category: "business",
    department: "Sales",
    graph: objectionRebuttalKit,
  },
  {
    slug: "ai-visibility-prospector",
    name: "AI Visibility Prospector",
    pitch: "Turn an AI-engine transcript into a citation read, gap hypotheses, and a cold open that leads with proof: $0.08 per prospect.",
    description:
      "A prospecting desk for anyone selling AI-visibility work. Paste a prospect, the brand at stake, and the AI-engine answers you actually collected, and it returns who the engines crown, cite, or skip, the gap hypotheses a paid audit would verify, and the email and DM that open with the finding. It refuses to invent engine results: no transcripts, no claims. Example input: \"Prospect: an SEO agency. Client brand: MyCase. Category: legal practice management software. Transcript: Perplexity crowned Clio 'the best overall choice'; MyCase got a niche mention for client messaging.\" Example output: strict JSON with citation_read (brand_position, crowned, also_cited[]), finding, qualified, gap_hypotheses[] (gap + why), and outreach (subject, email under 150 words, DM under 280 characters).",
    whoPays: "Agencies, consultants, and SDR agents selling AI-visibility or SEO services: every prospect arrives with a checkable finding and the outreach already drafted.",
    suggestedPriceUsdc: 0.08,
    category: "business",
    department: "Sales",
    graph: aiVisibilityProspector,
  },
  {
    slug: "renewal-churn-read",
    name: "Renewal Churn Read",
    pitch: "Score any renewal 1-10 for churn risk with the signals behind it and the save play to run: $0.08 per account.",
    description:
      "A self-running churn-risk read for CS and account teams. Paste the account's renewal signals (usage trend, support history, stakeholder changes, sentiment, contract notes) and it returns a churn-risk score, the red and green flags it weighed, the likely reason they'd leave, and a concrete save play with talking points. Example input: \"Renewal in 45 days. Usage down 30% since their champion left, two escalations last quarter, new VP hasn't met us, but they expanded seats in Q1.\" Example output: strict JSON with churn_risk_score (1-10), risk_band, red_flags[], green_flags[], likely_churn_reason, save_play (plays[] + talking_points[]), recommended_owner, urgency, and missing_signals[].",
    whoPays: "Customer success and account managers: every upcoming renewal needs a risk read before the QBR.",
    suggestedPriceUsdc: 0.08,
    category: "business",
    department: "Sales",
    graph: renewalChurnRead,
  },
  {
    slug: "battlecard-from-notes",
    name: "Battlecard From Notes",
    pitch: "Turn raw competitor intel into a sales battlecard: landmines, traps to set, and win themes. $0.18 per card.",
    description:
      "A self-running competitive enablement desk. Paste your messy notes about a competitor (from a lost deal, a review site, a prospect call, a teardown) and it returns a rep-ready battlecard: how to position, the landmines they'll drop on you, traps to set in your favor, their strengths to respect, and the win themes that close. Example input: \"CompetitorX: cheaper, strong brand, but slow support, no SSO on lower tiers, locks data on export. Lost two deals to them on price.\" Example output: strict JSON with competitor, our_positioning, their_strengths[], their_weaknesses[], landmines_they_set[] (claim + your_counter), traps_to_set[] (question + why), win_themes[], and how_to_win.",
    whoPays: "Sales enablement and product marketing: every competitive deal needs a current battlecard reps can carry.",
    suggestedPriceUsdc: 0.18,
    category: "business",
    department: "Sales",
    graph: battlecardFromNotes,
  },
  {
    slug: "stacktrace-triage",
    name: "Stack-Trace Triage",
    pitch: "Turn any stack trace into a ranked root-cause call and the exact frame to fix: $0.05 per trace.",
    description:
      "A self-running on-call triage desk. Paste a raw exception and stack trace (optionally a few surrounding log lines) and it returns ranked root-cause hypotheses, the single frame most likely at fault, and a concrete fix direction, so the dev stops scrolling and starts fixing. Example input: a Python KeyError traceback ending in user_settings['locale'] with 8 frames. Example output: strict JSON with top_frame \"settings.py:142, user_settings['locale']\", root_cause \"locale key absent for users created before the i18n migration\", confidence \"high\", hypotheses[], fix \"use user_settings.get('locale', DEFAULT_LOCALE) and backfill nulls\", repro_hint \"load any pre-2023 user\".",
    whoPays: "Backend and on-call engineers: every unfamiliar traceback gets a root-cause call before they burn 20 minutes reading frames.",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Engineering",
    graph: stacktraceTriage,
  },
  {
    slug: "fn-to-testcases",
    name: "Function-to-Test-Cases",
    pitch: "Paste one function, get a full edge-case test suite back as runnable code: $0.08 per function.",
    description:
      "A tiny test-writing service that never gets lazy about edge cases. Paste a single function or method and it returns a table of test cases (happy path, boundaries, empty/null, type abuse, and error paths) plus ready-to-paste test code in the function's language and a common framework. Example input: a JS function slugify(title) that lowercases and hyphenates. Example output: strict JSON with language \"javascript\", framework \"vitest\", cases[] (name, input, expected, including empty string, non-ascii, and null-throws), and a complete code string importing the function under test.",
    whoPays: "Developers and coding agents shipping under deadline: every new function gets real edge-case coverage without a human writing the boring tests.",
    suggestedPriceUsdc: 0.08,
    category: "business",
    department: "Engineering",
    graph: fnToTestcases,
  },
  {
    slug: "explain-plan-advisor",
    name: "Query-Plan Index Advisor",
    pitch: "Paste a slow query plus its EXPLAIN and get the index that fixes it: $0.12 per plan.",
    description:
      "A query-tuning consultant that bills by the plan, not the hour. Paste a SQL query with its EXPLAIN (or EXPLAIN ANALYZE) output and it tells you in plain language what is slow, why, and the specific index or rewrite that removes the bottleneck, with the exact CREATE INDEX statement. Example input: a Postgres query filtering orders by customer_id and status whose plan shows a Seq Scan over 2M rows. Example output: strict JSON with verdict, hotspots[] (node, cost, why), recommendations[] (type, ddl, expected), rewrite, and caveats, e.g. ddl \"CREATE INDEX idx_orders_customer_status ON orders (customer_id, status);\".",
    whoPays: "Backend and data engineers chasing slow endpoints: every regressed query gets a concrete index recommendation before they page a DBA.",
    suggestedPriceUsdc: 0.12,
    category: "business",
    department: "Engineering",
    graph: explainPlanAdvisor,
  },
  {
    slug: "regex-from-examples",
    name: "Regex From Examples",
    pitch: "Paste what should match and what shouldn't, get a regex that does it, explained: $0.04 per build.",
    description:
      "A regex desk that works from examples instead of from a headache. Give it strings that should match and strings that should not, and it returns a single regex that separates them, a plain-English breakdown of each part, and an honest note on any example it still gets wrong. Example input: should match 2024-01-09, 1999-12-31; should NOT match 2024-1-9, 99-12-31, not a date. Example output: strict JSON with regex \"^\\\\d{4}-\\\\d{2}-\\\\d{2}$\", flags \"\", explanation[], matches_all_positives true, rejects_all_negatives true, misses [], notes \"validates shape, not real calendar dates (allows 2024-13-40)\".",
    whoPays: "Developers and data wranglers writing validators and parsers: every match rule gets a tested regex without the trial-and-error.",
    suggestedPriceUsdc: 0.04,
    category: "business",
    department: "Engineering",
    graph: regexFromExamples,
  },
  {
    slug: "release-notes-writer",
    name: "Release Notes Writer",
    pitch: "Turn merged PRs into release notes and dispatch your release workflow: $0.05 per release.",
    description:
      "Input carries merged PRs or changelog lines, the editor writes customer-facing release notes, GitHub Workflow Dispatch starts the reviewed release workflow, and Output records the receipt. Preview does not call GitHub; live requires a bearer Connection and reviewed repo/workflow settings.",
    whoPays: "Product and dev-rel teams: every release turned from raw commits into publishable notes, ship after ship.",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Engineering",
    graph: releaseNotesWriter,
  },
  {
    slug: "transaction-categorizer",
    name: "Transaction Categorizer",
    pitch: "Paste a bank or card transaction feed, get each line coded to a GL category with a deductible flag: $0.04 per batch.",
    description:
      "A self-running bookkeeping clerk that codes the bank feed nobody wants to touch. Paste a batch of raw bank or credit-card lines (date, description, amount) and it returns each one mapped to a general-ledger category, marked business or personal, flagged deductible or not, with a confidence score and a low-confidence pile for human review. It only reads the lines you hand it; it never connects to a bank. Example input: \"2025-06-03 SQ *BLUE BOTTLE COFFEE $6.50 | 2025-06-04 AMZN MKTP US*2K4XY $89.20 | 2025-06-05 DELTA AIR 0061234567 $412.00 | 2025-06-06 GUSTO PAYROLL FEE $46.00\". Example output: strict JSON with lines[] (desc, category, business, deductible, deductiblePct, confidence, review) and reviewCount.",
    whoPays: "Bookkeepers and accounting agents: every bank and card statement gets pre-coded to the GL before month-end close.",
    suggestedPriceUsdc: 0.04,
    category: "business",
    department: "Finance",
    graph: transactionCategorizer,
  },
  {
    slug: "bank-rec-discrepancy",
    name: "Bank Rec Discrepancy Finder",
    pitch: "Send your bank statement and your ledger, get the exact unreconciled items before you close the month: $0.06 per reconciliation.",
    description:
      "A self-running reconciliation desk that finds the breaks for you. Paste a bank statement's lines and the matching book/ledger lines for the same period; it pairs what ties out and surfaces every exception (a payment with no book entry, a duplicate, a transposed amount, an uncleared check, a missed fee) with the dollar delta on each. It reconciles only the two sets you provide; it never logs into a bank. Example input: \"BANK: 06/02 DEP +$2,400.00 | 06/05 ACH VENDOR-X -$780.00 | 06/05 ACH VENDOR-X -$780.00 | 06/08 SVC FEE -$32.00. BOOKS: 06/02 Customer deposit +$2,400.00 | 06/05 Vendor X bill pay -$780.00 | 06/07 Check #1042 -$540.00.\" Example output: strict JSON with reconciled false, matched 2, exceptions[] (type, detail, amount), net_unreconciled -1352.00, and a note on what to chase first.",
    whoPays: "Controllers and close agents: every period-end bank reconciliation gets its breaks isolated before the books are closed.",
    suggestedPriceUsdc: 0.06,
    category: "business",
    department: "Finance",
    graph: bankRecDiscrepancy,
  },
  {
    slug: "vendor-risk-read",
    name: "Vendor Risk Read",
    pitch: "Paste a new vendor's profile, get an onboarding risk grade with the red flags called out: $0.08 per vendor.",
    description:
      "A self-running vendor-vetting desk for the procurement queue. Paste what you have on a prospective supplier (W-9 or registration details, ownership, references, a banking-change request) and it returns a risk grade, the specific flags worth a second look (name/tax-ID mismatch, brand-new entity, a sudden bank-detail change that smells like payment fraud, thin operating history), and a clear onboard / hold / decline call with what to collect first. It reads only the profile you give it; it never pulls a credit report or browses. Example input: \"NorthBridge Supply LLC. W-9 legal name 'NorthBridge Holdings LLC' (mismatch). Formed 2 months ago. Wants first payment by wire to a personal-name account. No trade references. First PO $58,000.\" Example output: strict JSON with grade \"HIGH RISK\", flags[], decision \"hold\", collect[], note.",
    whoPays: "Procurement and vendor-onboarding teams: every new supplier risk-graded before it's added to the payable master.",
    suggestedPriceUsdc: 0.08,
    category: "business",
    department: "Ops",
    graph: vendorRiskRead,
  },
  {
    slug: "transcript-to-social-pack",
    name: "Transcript-to-Social Pack",
    pitch: "Turn one podcast or video transcript into a full multi-platform repurpose pack: $0.18 per transcript.",
    description:
      "A content-repurposing studio that runs on a single paste. Feed it a podcast or video transcript and it returns a ready-to-post pack (a LinkedIn post, an X/Twitter thread, three short-form video hooks, and a pull-quote set) each drawn only from what was actually said. One long recording becomes a week of distribution. Example input: a 3,000-word interview where the guest explains why most onboarding flows fail and gives a 3-step fix. Example output: strict JSON with linkedin_post, x_thread (array of <=280-char posts), short_hooks (array of 3), and pull_quotes (array).",
    whoPays: "Content teams, podcasters, and repurposing agents: every new episode or recording needs platform-native posts, so it recurs per drop.",
    suggestedPriceUsdc: 0.18,
    category: "business",
    department: "Marketing",
    graph: transcriptToSocialPack,
  },
  {
    slug: "keyword-cluster-planner",
    name: "Keyword Cluster Planner",
    pitch: "Drop a raw keyword list, get topic clusters mapped to pages with search intent: $0.12 per list.",
    description:
      "A self-running keyword-architecture desk. Paste a messy list of keywords and it groups them into topic clusters, labels the search intent of each, recommends one page per cluster, and names the pillar page that ties them together, turning a keyword dump into a content plan a writer can act on. Example input: \"running shoes for flat feet, best stability running shoes, overpronation shoes, how to fix overpronation, what is overpronation, motion control running shoes, flat feet running pain\". Example output: strict JSON with clusters[] (cluster_name, intent, keywords, recommended_page_type, suggested_title) and a pillar_page, e.g. cluster \"Overpronation basics\", intent \"informational\", page \"blog guide\", title \"Overpronation Explained: Causes, Signs, and Fixes\".",
    whoPays: "SEO strategists and content-planning agents: every new site, niche, or quarterly content sprint starts from a raw keyword list that needs clustering.",
    suggestedPriceUsdc: 0.12,
    category: "business",
    department: "Marketing",
    graph: keywordClusterPlanner,
  },
  {
    slug: "spec-to-listing-seo",
    name: "Spec Sheet to Listing + SEO",
    pitch: "Turn a raw product spec into a marketplace-ready title, bullets, and description with keywords baked in: $0.06 per product.",
    description:
      "A self-running copy desk for your catalog. Paste a product's spec sheet or attribute dump and it returns a sales-ready listing: an SEO title under the marketplace cap, five benefit-led bullets, a description, a backend keyword line, and meta tags. No blank-page time, no freelancer queue. Example input: \"Stainless insulated water bottle, 32oz, double-wall vacuum, keeps cold 24h / hot 12h, leakproof lid, BPA-free, powder-coat finish, fits cup holders, colors: black/sage/sand.\" Example output: strict JSON with title, bullets[5], description, backend_keywords, meta_title, meta_description, primary_keyword.",
    whoPays: "Catalog and merchandising teams: every new SKU needs launch-ready copy and keywords before it can sell.",
    suggestedPriceUsdc: 0.06,
    category: "business",
    department: "Marketing",
    graph: specToListingSeo,
  },
  {
    slug: "listing-quality-qa",
    name: "Listing Quality QA Gate",
    pitch: "Catch the gaps that kill conversion or get a listing suppressed: score any listing 0-100 with the exact fixes before it goes live. $0.05 per listing.",
    description:
      "A pre-publish gate for your storefront. Paste a finished listing (title, bullets, description, image count, attributes) and it returns a quality score, a pass/fix/block verdict, and a checklist of concrete problems (missing size or material, title over the cap, keyword stuffing, banned promo claims, thin bullets) so nothing half-baked reaches the buyer. Example input: {\"title\":\"AMAZING Best Shoes Ever!!!\",\"bullets\":[\"Nice\",\"Good quality\"],\"description\":\"Buy now.\",\"images\":2,\"attributes\":{\"color\":\"red\"}}. Example output: strict JSON with score 24, verdict \"block\", dimension_scores, issues[] (field, severity, problem, fix), and a one-line summary.",
    whoPays: "Marketplace sellers and listing-ops agents: every SKU gets a consistent quality check before publish instead of a manual eyeball.",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Marketing",
    graph: listingQualityQa,
  },
  {
    slug: "review-theme-rollup",
    name: "Review Theme Rollup",
    pitch: "Distill a wall of product reviews into ranked themes, fix signals, and a buyer-question list: $0.18 per product.",
    description:
      "A voice-of-customer analyst for a single SKU. Paste a batch of reviews (any number, mixed ratings) and it returns the top praise and complaint themes ranked by frequency, the specific product or listing fixes the reviews are begging for, the common questions buyers ask, and a quotable line per theme, so product, merchandising, and support all see the same truth. Example input: 40 reviews for a coffee grinder, ratings 1-5. Example output: strict JSON with summary, overall_sentiment, praise_themes[] (theme, mentions, quote), complaint_themes[] (theme, mentions, severity, quote), fix_signals[], and buyer_questions[].",
    whoPays: "Product and merchandising teams: every SKU gets a theme rollup that tells them what to fix, restock, or kill.",
    suggestedPriceUsdc: 0.18,
    category: "business",
    department: "Support",
    graph: reviewThemeRollup,
  },
  {
    slug: "cart-crosssell-bundler",
    name: "Cart Cross-Sell & Bundler",
    pitch: "Turn any cart into ranked add-on and bundle suggestions with ready-to-show copy: $0.04 per cart.",
    description:
      "A merchandiser for the checkout page. Paste the cart contents plus your available catalog and it returns the best complementary add-ons, a bundle suggestion with a reason, and a one-line nudge for each, grounded only in products you actually carry, so you upsell without a recommender engine or a tagging project. It only recommends from the catalog you supply and never invents SKUs. Example input: {\"cart\":[\"Yoga mat 6mm\"],\"catalog\":[\"Yoga blocks (pair)\",\"Cork yoga wheel\",\"Microfiber yoga towel\",\"Resistance bands set\",\"Steel water bottle\"]}. Example output: strict JSON with addons[] (product, reason, nudge, rank) and a bundle (name \"Home Practice Kit\", items, reason).",
    whoPays: "DTC and marketplace sellers: every cart gets live add-on and bundle suggestions to lift average order value.",
    suggestedPriceUsdc: 0.04,
    category: "business",
    department: "Marketing",
    graph: cartCrosssellBundler,
  },
  {
    slug: "kb-article-drafter",
    name: "KB Article Drafter",
    pitch: "Turn any resolved ticket into a publish-ready help-center article: $0.06 per article.",
    description:
      "A self-running knowledge-base writer that turns solved tickets into reusable docs so the same question stops coming back. Paste a resolved ticket thread (the problem and how it got fixed) and it returns a clean help-center article: a searchable title, the symptom, the cause, numbered steps, and a short list of search terms, all genericized so no customer's name or data leaks in. Example input: \"Customer couldn't connect their Outlook calendar; 'authorization failed.' Their admin had blocked third-party OAuth apps. We had them allowlist our app ID in the Microsoft admin center, then it worked.\" Example output: strict JSON with title, symptom, cause, steps[], and searchTerms[].",
    whoPays: "Support and KB teams: every novel resolved ticket becomes a help-center article that deflects the next ten of the same.",
    suggestedPriceUsdc: 0.06,
    category: "business",
    department: "Support",
    graph: kbArticleDrafter,
  },
  {
    slug: "open-response-themes",
    name: "Open-Response Theme Clusterer",
    pitch: "Cluster hundreds of free-text survey answers into named themes with counts and quotes: $0.18 per batch.",
    description:
      "A research analyst that takes a column of open-ended responses and hands back the 4-10 themes actually present, each with how many responses it covers and a couple of real verbatim quotes. It turns an unreadable pile of comments into a ranked, defensible summary you could drop into a deck, without reading every row. Example input: 200 answers to 'What almost stopped you from signing up?'. Example output: strict JSON with themes[] (label \"Pricing felt unclear\", count 54, share 0.27, sentiment \"negative\", quotes[]), unthemed 12, total 200.",
    whoPays: "Product researchers and CX teams: every survey export gets clustered into ranked themes before the readout meeting.",
    suggestedPriceUsdc: 0.18,
    category: "business",
    department: "Support",
    graph: openResponseThemes,
  },
  {
    slug: "citation-formatter",
    name: "Citation Cleanup Desk",
    pitch: "Drop in a messy pile of references, get back clean, consistently formatted citations in the style you ask for: $0.05 per batch.",
    description:
      "A reference desk for anyone assembling a bibliography from scraps. Paste rough references (half-remembered titles, raw URLs, copy-pasted lines) and a target style, and it returns properly formatted citations plus a flag on any entry missing required pieces. Example input: style 'APA' plus three lines including 'Smith 2021 deep learning survey arxiv' and a bare URL. Example output: strict JSON with style \"APA\" and citations[], e.g. {\"formatted\":\"Smith, J. (2021). A survey of deep learning. arXiv.\",\"missing\":[\"volume\",\"page numbers\"]} and {\"formatted\":\"Author unknown. (n.d.). Retrieved from https://...\",\"missing\":[\"author\",\"title\",\"date\"]}.",
    whoPays: "Researchers, analysts, and content teams: every report's reference list gets formatted and gap-checked before it ships.",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Ops",
    graph: citationFormatter,
  },
  {
    slug: "nps-verbatim-themes",
    name: "NPS Verbatim Themes",
    pitch: "Files a weekly NPS read every Monday: top themes, detractor drivers, and the one fix to make. $0.12 per brief.",
    description:
      "A self-running voice-of-customer analyst that clocks in every Monday. Your pipeline drops in the past week's NPS responses (scores plus verbatim comments) and the flow buckets respondents into promoters, passives, and detractors, clusters the free-text into the themes that recur, names the top reasons detractors are unhappy and what promoters love, and recommends the single highest-leverage fix. It quantifies only what's in the batch; it never fabricates a score or a count. Example input: \"[120 responses. Scores + comments, e.g. 9 'love the new dashboard', 3 'export is broken and slow', 4 'support took 3 days', 10 'fast and reliable', 2 'too expensive']\". Example output: \"NPS sample 120 (62 promoters, 31 passives, 27 detractors), NPS ~+29. Promoters love: dashboard speed, reliability. Detractor drivers: broken CSV export (11), slow support (8), price-to-value (5). Theme of the week: export reliability. Biggest fix: ship the CSV export bug.\"",
    whoPays: "Product and CX teams: a weekly read of NPS verbatims into themes and one action, without an analyst spending the afternoon.",
    suggestedPriceUsdc: 0.12,
    category: "business",
    department: "Support",
    graph: npsVerbatimThemes,
  },
  {
    slug: "decision-memo-builder",
    name: "Decision Memo Builder",
    pitch: "Turn a tangle of options into a one-page decision memo with a clear recommendation: $0.18 per memo.",
    description:
      "A self-running desk that converts a messy set of options and constraints into the decision memo an exec would actually sign. Paste the options, the criteria that matter, and any constraints. It returns a recommendation, the runner-up, the trade-offs, the risks, and the open questions, formatted as a tight one-pager. Example input: \"Decision: which support tool. Options: Zendesk, Intercom, Help Scout. Criteria: price, AI deflection, Slack integration, setup time. Constraints: budget $800/mo, live in 3 weeks, team of 4.\" Example output: strict JSON with decision, recommendation, rationale, option_scores[], runner_up (option + would_win_if), key_tradeoffs[], top_risks[], and open_questions[].",
    whoPays: "Founders, chiefs of staff, and ops agents: every recurring build-vs-buy or vendor call needs a defensible one-pager before the meeting.",
    suggestedPriceUsdc: 0.18,
    category: "business",
    department: "Ops",
    graph: decisionMemoBuilder,
  },
  {
    slug: "rice-prioritizer",
    name: "RICE Prioritizer",
    pitch: "Score and rank any backlog of ideas with RICE and a one-line rationale each: $0.10 per ranked list.",
    description:
      "A prioritization desk that ends the \"which do we do first\" argument. Paste a raw list of features, bets, or tasks (with whatever context you have) and it returns each one scored on Reach, Impact, Confidence, and Effort, with the RICE number computed and the list ranked top to bottom. Every item gets a one-line why, and anything it had to assume is flagged so you can correct it. Example input: \"Q3 ideas: (1) SSO login: enterprise keeps asking, big deals. (2) dark mode: lots of requests, easy. (3) rebuild onboarding: high effort, unclear payoff. (4) bulk export: a few power users, quick.\" Example output: strict JSON with effort_unit, ranked[] (rank, item, reach, impact, confidence, effort, rice_score, rationale), and assumptions[].",
    whoPays: "Product managers and roadmap agents: every planning cycle needs a defensible ranked backlog, and the inputs change every sprint.",
    suggestedPriceUsdc: 0.1,
    category: "business",
    department: "Ops",
    graph: ricePrioritizer,
  },
  {
    slug: "interview-scorecard-builder",
    name: "Interview Scorecard Builder",
    pitch: "Paste a job description, get a structured interview scorecard with rubric and questions: $0.07 per role.",
    description:
      "A self-running interview-kit desk so every panel scores the same way. Paste the job description and it returns a competency-based scorecard: the 4-6 competencies that actually matter, a 1-4 rating anchor for each, two targeted interview questions per competency, and which interviewer should own each area. It builds only from the JD you provide. Example input: \"Senior Product Manager, 6+ yrs, owns roadmap for B2B SaaS billing, must do data-driven prioritization, cross-functional leadership, strong written comms, fintech a plus.\" Example output: strict JSON with competencies[] (name, why, anchors {1,4}, questions[2], owner) and a summary line.",
    whoPays: "Hiring managers and recruiting ops: every open role gets a consistent, competency-based interview kit before the panel meets.",
    suggestedPriceUsdc: 0.07,
    category: "business",
    department: "HR",
    graph: interviewScorecardBuilder,
  },
  {
    slug: "performance-review-draft",
    name: "Performance Review Draft",
    pitch: "Paste your raw notes on a report, get a balanced, evidence-based review draft: $0.10 per review.",
    description:
      "A self-running review-writing desk for managers at cycle time. Paste the raw material (bullet notes, wins, misses, peer feedback, the period's goals) and it returns a structured, balanced performance review: a summary, specific strengths tied to evidence, growth areas stated constructively, progress against goals, and concrete next-period focus areas. It writes only from the notes you provide; it does not invent accomplishments or assign a rating you didn't give. Example input: \"Q2 review, Maya, senior designer. Wins: shipped onboarding redesign, mentored two juniors. Misses: missed pricing-page deadline 3 wks, goes quiet in cross-team threads. Goal: own a major surface end-to-end. Did. Peer: 'great craft, wish she pushed back earlier on scope creep.'\" Example output: strict JSON with summary, strengths[] (point, evidence), growth_areas[] (point, framing), goal_progress, and next_focus[].",
    whoPays: "Managers and HR ops: every review cycle, raw notes on each report become a balanced, evidence-based draft.",
    suggestedPriceUsdc: 0.1,
    category: "business",
    department: "HR",
    graph: performanceReviewDraft,
  },
  {
    slug: "listing-copy-from-facts",
    name: "Listing Copy From Facts",
    pitch: "Turn raw property facts into MLS-ready listing copy with headline, body, and feature bullets: $0.06 per listing.",
    description:
      "A self-running copy desk for every new listing. Paste the property facts (beds, baths, square footage, lot, upgrades, neighborhood) and it returns a Fair-Housing-aware listing description with a headline, a 120-150 word body, and scannable feature bullets, so a coordinator never stares at a blank MLS field again. Example input: \"3bd/2ba, 1,840 sqft, built 1998, renovated kitchen w/ quartz + new SS appliances, primary suite, fenced 0.25ac, 2-car garage, walkable to Lincoln Elementary, Maplewood subdivision, $429,000.\" Example output: strict JSON with headline, body, bullets[], fair_housing_notes, and missing_facts[].",
    whoPays: "Listing agents and brokerage marketing coordinators: every new listing needs MLS copy on a deadline, and they cut several a week.",
    suggestedPriceUsdc: 0.06,
    category: "business",
    department: "Marketing",
    graph: listingCopyFromFacts,
  },
  {
    slug: "cma-comp-adjuster",
    name: "CMA Comp Adjuster",
    pitch: "Turn a subject home plus comps into an adjusted value range with a defensible narrative: $0.18 per CMA.",
    description:
      "A pricing analyst that runs on every listing appointment. Paste the subject property and 3-6 comparable sales with their key facts, and it returns line-item dollar adjustments for size, beds/baths, garage, lot, condition, and date-of-sale, an adjusted value range, a suggested list price, and a short narrative an agent can read aloud to a seller. Example input: \"SUBJECT: 4bd/3ba, 2,400sqft, 0.30ac, 3-car, good condition. COMP1: sold $540k, 4/2.5, 2,250sqft, 0.25ac, 2-car, 45 days ago. COMP2: sold $575k, 4/3, 2,520sqft, 0.30ac, 3-car, 90 days ago.\" Example output: strict JSON with assumptions, adjusted_comps[] (comp, sale_price, adjustments, net_adjustment, adjusted_value), value_range, suggested_list, confidence, narrative, and a 'not a licensed appraisal' disclaimer.",
    whoPays: "Listing agents and inside-sales teams prepping CMAs: every listing pitch and price-reduction conversation needs a defensible number.",
    suggestedPriceUsdc: 0.18,
    category: "business",
    department: "Sales",
    graph: cmaCompAdjuster,
  },
  {
    slug: "offer-stack-comparator",
    name: "Offer Stack Comparator",
    pitch: "Rank competing offers by true net-to-seller with the risks each one carries: $0.12 per offer round.",
    description:
      "A seller's-table analyst for multiple-offer situations. Paste two or more offers with their price, financing, concessions, contingencies, and close timeline, and it returns a side-by-side comparison ranked by estimated net-to-seller, surfaces the strings attached to each (appraisal gap, financing type, inspection and sale-of-home contingencies, requested credits) and gives the listing agent a one-line recommendation to present. Example input: \"OFFER A: $610k, conventional 20% down, $8k seller credit, waived appraisal, 21-day close, inspection contingency. OFFER B: $625k, FHA, $12k credit, appraisal contingency, sale-of-home contingency, 45-day close.\" Example output: strict JSON with offers[] (net_to_seller, financing, contingencies, strength, risks), ranked_by_net, strongest_overall, recommendation, net_basis, and a disclaimer.",
    whoPays: "Listing agents in competitive markets: every multiple-offer property forces a net-to-seller comparison at the kitchen table.",
    suggestedPriceUsdc: 0.12,
    category: "business",
    department: "Sales",
    graph: offerStackComparator,
  },
  {
    slug: "bol-field-extractor",
    name: "Bill of Lading Field Extractor",
    pitch: "Drop a bill of lading or packing list as raw text and get every field back as clean structured JSON: $0.05 per document.",
    description:
      "A tiny data-entry clerk that never mis-keys. Paste the raw text of a bill of lading, packing list, or commercial invoice and it returns a normalized record (shipper, consignee, carrier, BOL number, piece and weight totals, line items, incoterms, hazmat flag) so your TMS or freight-audit agent ingests structured data instead of a wall of text. Flags anything missing so you know what to chase before the shipment moves. Example input: \"BILL OF LADING BOL# 884213 Ship From: Acme Mfg, 14 Industrial Rd, Akron OH Ship To: Northwind DC, 200 Dock Ave, Columbus OH Carrier: Blue Line Freight PRO 55-7781 Pieces: 6 pallets Wt: 3,420 lb Class 70 Terms: Prepaid Items: 4x Pump A-22, 2x Valve kit V-9\". Example output: strict JSON with bol_number, pro_number, shipper, consignee, carrier, pieces, weight_lb, freight_class, terms, hazmat, line_items[], and missing_fields[].",
    whoPays: "Freight-audit and TMS ingestion agents: every inbound BOL or packing list has to become a structured record before it can be matched or paid.",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Ops",
    graph: bolFieldExtractor,
  },
  {
    slug: "detention-demurrage-watch",
    name: "Detention & Demurrage Watch",
    pitch: "A daily sweep of your container status dump that flags every box about to rack up detention or demurrage fees: $0.12 per brief.",
    description:
      "A self-running fee-avoidance watchdog for drayage and import teams. On a daily cron it reads the container/yard status text you feed the run and flags every container whose free time is running out (last free day approaching, still at terminal, or empty not yet returned) ranked by how soon the clock bites and the estimated daily charge if known. Flags and prioritizes; it does not schedule the move. Example input: \"MSCU1234567 discharged 06-26, last_free_day 06-30, status at_terminal, demurrage_rate 175/day. TCLU7654321 picked up 06-27, empty_due 06-30, status out, detention_rate 120/day. HLBU2223334 last_free_day 07-05, at_terminal.\" Example output: strict JSON with as_of, alerts[] (container, clock, days_until_charge, est_daily_charge_usd, action, priority), watch[], critical_count, and a summary.",
    whoPays: "Drayage coordinators and import ops: every morning a container creeping toward its last free day needs flagging before the daily fee starts.",
    suggestedPriceUsdc: 0.12,
    category: "business",
    department: "Ops",
    graph: detentionDemurrageWatch,
  },
  {
    slug: "claim-summary-fnol",
    name: "FNOL Claim Summarizer",
    pitch: "Turn any messy first-notice-of-loss into a clean, structured claim file: $0.06 per claim.",
    description:
      "A tiny self-running claims-intake desk. Paste the raw first-notice-of-loss (the adjuster's call notes, the policyholder's email, the form dump) and it returns one structured claim file: parties, dates, loss type, location, cause, severity band, coverage line, and the missing fields someone has to chase. It never decides the claim; it just makes the intake clean so the adjuster starts at minute ten, not minute zero. Example input: a 300-word voicemail transcript where a driver rear-ends someone in a parking lot, no police report, photos promised later. Example output: strict JSON with claimType \"auto - collision\", lossDate, namedInsured, claimantOrThirdParty, locationType \"parking lot\", policeOrIncidentReport false, severityBand \"minor\", summary, and missingFields [\"police report number\",\"third-party insurer\",\"photos\"].",
    whoPays: "Claims-intake teams and FNOL bots: every new loss report gets normalized into a structured file before an adjuster touches it.",
    suggestedPriceUsdc: 0.06,
    category: "business",
    department: "Ops",
    graph: claimSummaryFnol,
  },
  {
    slug: "claim-denial-appeal",
    name: "Claim Denial Appeal Letter",
    pitch: "Draft a clean, citable appeal letter from any denial: $0.12 per appeal.",
    description:
      "A tiny appeals desk for billing teams and patient advocates. Paste the denial reason plus the admin facts (member ID, claim number, date of service, code, and what the policy actually says) and it drafts a structured appeal letter that answers the stated denial reason point by point. It writes the letter; it does not send it, decide the outcome, or offer medical or legal advice. Missing items come back as bracketed placeholders plus a checklist. Example input: a denial marked 'not medically necessary' with the procedure code, the plan's coverage language, and the ordering provider's note reference. Example output: a ready-to-edit appeal letter addressing the exact denial reason, citing the supplied claim/member numbers and policy language, plus a JSON list of placeholders still to fill.",
    whoPays: "Medical billing teams and patient-advocacy bots: every denied claim gets a first-draft appeal in seconds instead of an hour.",
    suggestedPriceUsdc: 0.12,
    category: "business",
    department: "Finance",
    graph: claimDenialAppeal,
  },
  {
    slug: "prior-auth-letter",
    name: "Prior-Authorization Request Letter",
    pitch: "Draft a complete prior-auth request letter from your admin facts: $0.10 per request.",
    description:
      "A tiny prior-authorization desk for medical-billing and scheduling teams. Paste the administrative facts (member ID, payer, requested service/code, ordering provider, diagnosis code, and the supporting documentation you're attaching) and it drafts a clean PA request letter to the payer, organized the way utilization-review intake wants it. It assembles the paperwork; it makes no clinical judgement, asserts no medical necessity beyond the notes you supply, and sends nothing. Missing items come back as bracketed placeholders plus a checklist. Example input: member and payer details, CPT for an MRI, ICD-10 code, ordering physician, and 'attaching conservative-treatment notes.' Example output: a ready-to-edit prior-auth letter with a clean RE: block, an itemized request, an attachments list, and a JSON checklist of placeholders and commonly-required items still missing.",
    whoPays: "Medical billing and scheduling teams: every service needing prior auth gets a complete first-draft request packet on demand.",
    suggestedPriceUsdc: 0.1,
    category: "business",
    department: "Finance",
    graph: priorAuthLetter,
  },

  // ── Existing: general business ───────────────────────────────────────────────
  {
    slug: "lead-qualifier",
    whoPays: "Sales teams and SDR agents: every inbound lead scored against your ICP before a human follows up.",
    name: "Lead Qualifier",
    pitch: "Score a lead, explain the next step, and deliver the qualification to CRM: $0.05 per lead.",
    description:
      "Input supplies a useful lead fixture, the qualifier scores fit and intent, CRM Webhook delivers the structured qualification, and Output records the receipt. Preview is side-effect-free. Bind a custom-header webhook Connection before live deployment.",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Sales",
    graph: leadQualifier,
  },
  {
    slug: "competitor-tracker",
    whoPays: "Founders and product marketers: a weekly read on a rival's pricing, features, and messaging.",
    name: "Competitor Tracker",
    pitch: "Files a weekly competitive brief every Monday: $0.15 per brief.",
    description:
      "Weekly snapshot of a competitor's pricing, features, and messaging changes.\n\nExample input: \"Competitor: Gumloop, track: pricing, features, Twitter activity\"\n\nExample output: \"Pricing: unchanged. New feature: visual canvas editor (launched June 12). Twitter: 3 posts about no-code agents...\"",
    suggestedPriceUsdc: 0.15,
    category: "business",
    department: "Marketing",
    graph: competitorTracker,
  },
  {
    slug: "review-responder",
    whoPays: "Support and brand teams: an on-voice reply drafted for every App Store and G2 review.",
    name: "Review Responder",
    pitch: "Approve a specific review response, then send it to the team in Slack: $0.03 per response.",
    description:
      "Input includes an explicit approval flag. Branch refuses unapproved work, the CX step drafts a specific reply only on the approved path, Slack Message sends it to the team, and separate outputs expose sent versus approval-required outcomes. Preview is side-effect-free; live requires a Slack webhook Connection.",
    suggestedPriceUsdc: 0.03,
    category: "business",
    department: "Support",
    graph: reviewResponder,
  },
  {
    slug: "site-monitor",
    whoPays: "Anyone running a site: a cheap uptime check every 30 minutes, no PagerDuty seat required.",
    name: "Site Monitor",
    pitch: "Checks every 30 minutes, alerts on degraded status: $0.01 per check.",
    description:
      "Pings your site every 30 minutes and returns a status JSON: up, down, or degraded. Routes to an output when not up. No PagerDuty subscription needed.",
    suggestedPriceUsdc: 0.01,
    category: "business",
    department: "Engineering",
    graph: siteMonitor,
  },
  {
    slug: "price-watcher",
    whoPays: "Shoppers and commerce agents: a price-drop signal on any product page you point it at.",
    name: "Price Watcher",
    pitch: "Pass in a product page, get a price-drop alert: $0.02 per check.",
    description:
      "Parses a product page for the current price and signals when it drops. Wire multiple instances for multiple products. Other agents pay $0.02 per check.",
    suggestedPriceUsdc: 0.02,
    category: "business",
    department: "Ops",
    graph: priceWatcher,
  },
  {
    slug: "daily-research-digest",
    whoPays: "Analysts and operators: the top five developments in a topic, filed every morning.",
    name: "Daily Research Digest",
    pitch: "Drops a 5-item digest every morning: $0.10 to anyone who wants the feed.",
    description:
      "Runs at 6 AM every day and summarizes the top 5 developments in your topic. Headline, takeaway, and why it matters. A research desk on a schedule.",
    suggestedPriceUsdc: 0.1,
    category: "business",
    department: "Ops",
    graph: dailyResearchDigest,
  },
  {
    slug: "inbox-triage-brief",
    whoPays: "Busy operators: a prioritized 5-bullet read of the inbox before the workday starts.",
    name: "Inbox Triage Brief",
    pitch: "Runs every weekday morning and files a 5-bullet brief: $0.05 per brief.",
    description:
      "Reads your email queue every weekday at 7 AM and returns a prioritized triage: urgent, action-needed, FYI, can-wait, delete. A morning brief on a schedule.",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Ops",
    graph: inboxTriageBrief,
  },
  {
    slug: "grade-rebuilder",
    whoPays: "Agent builders: turns an agent grade into a ready-to-build spec targeting the weakest pillar.",
    name: "Grade Rebuilder",
    pitch: "Turns an agent grade into a ready-to-build Agent Studio spec: $0.05 per spec.",
    description:
      "Takes a grade result from the Studio's agent grader (/grade) and outputs a structured Agent Studio workflow spec targeting the weakest pillar.\n\nExample input: \"Grade: 68/100. Weak: Traction. Recommendations: add discovery channels, publish to x402 directory\"\n\nExample output: \"Agent: Discovery Amplifier. Input: agent handle. Steps: 1. Fetch x402 listing 2. LLM writes pitch 3. Submit to 3 directories. Price: $0.08/call. Rationale: directly addresses Traction gap...\"",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Ops",
    graph: gradeRebuilder,
  },
  {
    slug: "brand-audit-to-contest-brief",
    whoPays: "Creator-marketing teams: a brand audit turned into a ready-to-post creator contest.",
    name: "Brand Audit to Contest Brief",
    pitch: "Turns a brand audit score into a ready-to-post creator contest brief: $0.10 per brief.",
    description:
      "Turns a brand audit score into a ready-to-post creator contest brief with audience criteria and prize structure.\n\nExample input: \"Brand: Suede Labs AI, score: 72, weakness: AEO\"\n\nExample output: \"Contest title: 'AI for Creators Challenge'. Prize: $500 + Suede Pro. Audience: music producers 18–35...\"",
    suggestedPriceUsdc: 0.1,
    category: "business",
    department: "Marketing",
    graph: brandAuditToContestBrief,
  },
  {
    slug: "creator-shortlist-for-brief",
    whoPays: "Brand and influencer teams: a ranked creator shortlist for any campaign brief.",
    name: "Creator Shortlist for Brief",
    pitch: "Generates a ranked creator shortlist for any campaign brief: $0.08 per list.",
    description:
      "Generates a ranked shortlist of creators for a campaign brief based on niche, audience size, and engagement.\n\nExample input: \"Brief: guitar gear unboxing, budget: $2000, audience: hobbyist guitarists\"\n\nExample output: \"1. @GearHeadJoe (120k, 4.2% eng) 2. @SixStringReviews (85k, 5.8% eng)...\"",
    suggestedPriceUsdc: 0.08,
    category: "business",
    department: "Marketing",
    graph: creatorShortlistForBrief,
  },
  // ── New: general-purpose expansion (research, ops, docs, e-commerce) ────────
  {
    slug: "deep-research-agent",
    whoPays: "Analysts, founders, and research agents turning scattered source material into one cited brief instead of re-reading everything themselves.",
    name: "Deep Research Agent",
    pitch: "Paste raw notes and source excerpts, get a cited synthesis brief with a confidence read on every claim, $0.15 per brief.",
    description:
      "A synthesis desk for research that already happened somewhere else. Paste in a question plus a stack of labeled source excerpts (articles, transcripts, notes, quotes) and it returns one answer with every finding tagged back to its source, disagreements called out instead of papered over, and the gaps flagged when the sources don't actually cover something. It never searches the web or invents a source; it only reasons over what you hand it.\n\nExample input: \"Question: Should we build our own vector search or use a hosted provider? Source 1 (internal eng notes): 'Our query volume is under 50k/day, self-hosting pgvector has worked fine so far.' Source 2 (vendor comparison doc): 'Hosted providers add ~$400/mo at our scale but remove the ops burden.'\"\n\nExample output: \"{ answer: 'At current volume, self-hosting remains viable; the tradeoff is ops time against roughly $400/mo.', key_findings: [{ finding: 'Query volume under 50k/day works fine on pgvector today', sources: ['Source 1'] }, { finding: 'Hosted adds about $400/mo but removes ops burden', sources: ['Source 2'] }], confidence: 'medium', gaps: ['no data on projected query volume growth'] }\"",
    suggestedPriceUsdc: 0.15,
    category: "business",
    department: "Ops",
    graph: deepResearchAgent,
  },
  {
    slug: "market-competitor-scanner",
    whoPays: "Product and strategy teams mapping a market by scanning competitor pages, pricing pages, and reviews before a positioning decision.",
    name: "Market Competitor Scanner",
    pitch: "Point it at a competitor URL, get a structured scan with pricing, positioning, and the gap to exploit, $0.10 per scan.",
    description:
      "A landscape scan built from live pages, not a single-competitor sales deep dive. Give it a competitor URL, a pricing page, a features page, or a reviews page, and it fetches the page over a read-only GET and returns that competitor's positioning, pricing model, strengths, and weaknesses, plus the market gap the page hints at. Run it once per competitor and aggregate the scans for a full landscape. For a sales-call battlecard, use the single-competitor Battlecard From Notes template instead.\n\nExample input: \"url: https://competitor.example.com/pricing\"\n\nExample output: \"{ competitors: [{ name: 'Competitor A', positioning: 'Enterprise security-first', pricing_model: 'custom/enterprise', strengths: ['security', 'trust'], weaknesses: ['slow support', 'long onboarding'] }], market_gap: 'Fast setup with enterprise-grade reporting, nobody covers both', strongest_competitor: 'Competitor A', recommended_wedge: 'Lead with self-serve speed plus reporting depth this competitor lacks.' }\"",
    suggestedPriceUsdc: 0.1,
    category: "business",
    department: "Marketing",
    graph: marketCompetitorScanner,
  },
  {
    slug: "lead-enrichment-agent",
    whoPays: "Sales development teams and outbound agents guessing firmographics for a raw lead list before routing it to reps.",
    name: "Lead Enrichment Agent",
    pitch: "Send an email and company name, get a structured firmographic guess with a confidence score on every field, $0.05 per lead.",
    description:
      "A firmographic first pass for a raw lead, not a database lookup. Send a name, email, and/or company and it returns a best-guess read on industry, company size band, seniority, and department, reasoned from the domain, title, and any notes given, with a confidence score attached to every field so a rep knows what to trust and what to verify. It never claims to have looked anything up externally.\n\nExample input: \"Name: Priya Shah, email: pshah@northlake-logistics.com, title: VP of Operations\"\n\nExample output: \"{ industry_guess: 'logistics/supply chain', company_size_band: 'likely mid-market (51-500)', seniority: 'VP / senior leadership', department: 'operations', confidence: { industry: 0.8, company_size_band: 0.45, seniority: 0.9, department: 0.9 }, reasoning: 'Company name signals logistics; VP title implies senior leadership and ops ownership; size is a pattern guess from the domain alone.' }\"",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Sales",
    graph: leadEnrichmentAgent,
  },
  {
    slug: "cold-outreach-sequencer",
    whoPays: "SDR teams and outbound agents drafting a multi-touch sequence personalized to each lead instead of one generic template.",
    name: "Cold Outreach Sequencer",
    pitch: "Send a lead profile and your offer, get a personalized 4-touch outreach sequence with subject lines, $0.07 per lead.",
    description:
      "A sequence writer that runs per lead instead of per campaign. Send a lead's profile and the offer, and it returns a 4-touch email sequence, opener, bump, value-add, breakup, each personalized to a real detail from the input rather than a mail-merge token. No invented facts about the lead or their company; if there's nothing to personalize with, it says so instead of making something up.\n\nExample input: \"Lead: Marcus Webb, Head of Support at Fenwick Retail, recently posted about ticket backlog on LinkedIn. Offer: AI support triage that cuts first-response time.\"\n\nExample output: \"{ sequence: [{ touch: 1, day_offset: 0, subject: 'Your ticket backlog post', body: 'Marcus, saw your note on the ticket backlog at Fenwick...', goal: 'open a conversation on the specific pain' }, { touch: 2, day_offset: 3, subject: 'Following up', body: '...', goal: 'bump without repeating the pitch' }, { touch: 3, day_offset: 7, subject: 'One idea, no pitch', body: '...', goal: 'give value, no ask' }, { touch: 4, day_offset: 12, subject: 'Closing the loop', body: '...', goal: 'breakup, leave door open' }] }\"",
    suggestedPriceUsdc: 0.07,
    category: "business",
    department: "Sales",
    graph: coldOutreachSequencer,
  },
  {
    slug: "support-ticket-triage",
    whoPays: "Support teams and helpdesk agents routing every incoming ticket the instant it lands, before a human ever opens it.",
    name: "Support Ticket Triage",
    pitch: "Triage one ticket, draft the first reply, and alert the right team in Slack: $0.04 per ticket.",
    description:
      "Input carries a realistic ticket, the triage step assigns category, priority, queue, and a specific first reply, Slack Message alerts the team, and Output records the receipt. Preview is deterministic and side-effect-free. Bind a Slack webhook Connection before live deployment.",
    suggestedPriceUsdc: 0.04,
    category: "business",
    department: "Support",
    graph: supportTicketTriage,
  },
  {
    slug: "invoice-field-extractor",
    whoPays: "Finance and services teams generating a clean PDF invoice from structured billing data without another SaaS subscription.",
    name: "Invoice PDF Generator",
    pitch: "Turn structured line items into a real PDF invoice with a computed total: $0.05 per invoice.",
    description:
      "Input starts with editable seller, buyer, due date, notes, and line items. Generate Invoice PDF computes totals and renders a real base64 PDF locally; Output exposes both the file and total amount. No connection or extra paid service is required.",
    suggestedPriceUsdc: 0.05,
    category: "business",
    department: "Finance",
    graph: invoiceFieldExtractor,
  },
  {
    slug: "csv-cleaner-merger",
    whoPays: "Ops and RevOps teams merging messy exports from two tools into one clean, deduped table without a spreadsheet afternoon.",
    name: "CSV Cleaner and Merger",
    pitch: "Paste one or more messy tabular exports, get a cleaned, deduped, normalized table back, $0.06 per run.",
    description:
      "A cleanup pass for pasted spreadsheet data from mismatched sources. Drop in one or more blobs of tabular text, even with inconsistent column names and formats between them, and it returns a single normalized table: consistent snake_case columns, ISO dates, deduped rows on the strongest shared identifier, and every conflict or dropped row listed out rather than silently resolved.\n\nExample input: \"Source A (CRM export): Name,Email,Company / Jane Doe,jane@acme.co,Acme. Source B (event signups): full_name,email,org / Jane Doe,jane@acme.co,Acme Corp\"\n\nExample output: \"{ columns: ['name','email','company'], rows: [{ name: 'Jane Doe', email: 'jane@acme.co', company: 'Acme Corp' }], duplicates_removed: 1, conflicts: [{ row_identifier: 'jane@acme.co', field: 'company', values_seen: ['Acme','Acme Corp'], value_kept: 'Acme Corp' }], dropped_rows: [] }\"",
    suggestedPriceUsdc: 0.06,
    category: "business",
    department: "Ops",
    graph: csvCleanerMerger,
  },
  {
    slug: "blog-to-social-repurposer",
    whoPays: "Content and marketing teams turning every published post into a week of social copy without rewriting from scratch.",
    name: "Blog-to-Social Repurposer",
    pitch: "Paste a finished blog post, get platform-specific variants for X, LinkedIn, Instagram, and email, $0.06 per post.",
    description:
      "A repurposing desk built for finished written copy, not a spoken transcript. Paste in a published blog post and it returns an X thread, a LinkedIn post, an Instagram caption, and an email teaser, each shaped to how that platform actually gets read, using only the claims and stories already in the post.\n\nExample input: \"Blog post: 'We cut our support response time from 6 hours to 40 minutes by triaging tickets with AI before a human ever sees them. The trick wasn't automating replies, it was automating routing.'\"\n\nExample output: \"{ x_thread: ['We cut support response time from 6 hours to 40 minutes.', 'The trick wasn't automating replies. It was automating routing.', ...], linkedin_post: 'We cut our support response time from 6 hours to 40 minutes...', instagram_caption: '6 hours to 40 minutes. Here's what actually moved the number.', email_teaser: { subject: 'How we cut response time 9x', preview_line: 'The trick wasn't the replies.' } }\"",
    suggestedPriceUsdc: 0.06,
    category: "business",
    department: "Marketing",
    graph: blogToSocialRepurposer,
  },
  {
    slug: "seo-content-brief-generator",
    whoPays: "Content teams and freelance writers briefing every new article the same rigorous way before a word gets written.",
    name: "SEO Content Brief Generator",
    pitch: "Send a target keyword and topic notes, get a full content brief with an outline and search intent, $0.06 per brief.",
    description:
      "A per-article brief, not a keyword clustering pass; for grouping a whole keyword list into topic clusters, use Keyword Cluster Planner instead. Send one target keyword plus any notes, and it returns the dominant search intent, a target word count, a full H2/H3 outline, and the entities a thorough article should cover.\n\nExample input: \"Keyword: 'invoice reconciliation software'. Notes: mostly SaaS finance teams searching this, comparison intent likely.\"\n\nExample output: \"{ target_keyword: 'invoice reconciliation software', search_intent: 'commercial', suggested_title: 'Invoice Reconciliation Software: How to Choose the Right Tool', target_word_count: 1800, outline: [{ heading: 'What invoice reconciliation software does', level: 'h2', notes: 'define the category' }, { heading: 'Key features to compare', level: 'h2', notes: 'matching, exception handling, integrations' }], entities_to_cover: ['two-way match', 'three-way match', 'ERP integration'], competitor_gaps: [] }\"",
    suggestedPriceUsdc: 0.06,
    category: "business",
    department: "Marketing",
    graph: seoContentBriefGenerator,
  },
  {
    slug: "api-docs-generator",
    whoPays: "Dev tools teams and API-first agents generating readable docs from raw code or an OpenAPI spec instead of writing them by hand.",
    name: "API Docs Generator",
    pitch: "Paste route handler code or an OpenAPI spec, get human-readable endpoint docs with examples, $0.06 per endpoint set.",
    description:
      "A docs draft straight from the source, not a rewrite of docs you already have. Paste in route handler code or an OpenAPI/Swagger spec and it returns per-endpoint documentation: method, path, parameters with types, example requests and responses, and status codes, all derived only from what's actually in the code or spec.\n\nExample input: \"router.post('/orders/:id/cancel', requireAuth, async (req, res) => { const { reason } = req.body; if (!reason) return res.status(400).json({ error: 'reason required' }); ... res.status(200).json({ orderId: req.params.id, status: 'cancelled' }); });\"\n\nExample output: \"{ endpoints: [{ method: 'POST', path: '/orders/:id/cancel', summary: 'Cancel an order', parameters: [{ name: 'id', in: 'path', type: 'string', required: true, description: 'Order ID' }, { name: 'reason', in: 'body', type: 'string', required: true, description: 'Cancellation reason' }], response_example: '{ orderId: 123, status: cancelled }', status_codes: [{ code: 200, meaning: 'Order cancelled' }, { code: 400, meaning: 'Missing reason' }] }] }\"",
    suggestedPriceUsdc: 0.06,
    category: "business",
    department: "Engineering",
    graph: apiDocsGenerator,
  },
  {
    slug: "daily-ops-digest",
    whoPays: "Founders and ops leads at small teams who want one honest morning summary across support, sales, and product signals instead of five dashboards.",
    name: "Daily Ops Digest",
    pitch: "At 8am, write one prioritized ops digest and send it to Slack: $0.10 per day.",
    description:
      "Schedule triggers at 08:00 UTC, the chief-of-staff step writes a prioritized digest from the run's operational signals, Slack Message sends it, and Output records the receipt. Preview never posts. Bind a Slack webhook Connection before live deployment.",
    suggestedPriceUsdc: 0.1,
    category: "business",
    department: "Ops",
    graph: dailyOpsDigest,
  },
  {
    slug: "product-listing-optimizer",
    whoPays: "E-commerce sellers and catalog agents rewriting an underperforming listing to convert and rank better, without touching the real specs.",
    name: "Product Listing Optimizer",
    pitch: "Paste your current live listing, get a rewritten title, bullets, and description built to convert, $0.06 per listing.",
    description:
      "A rewrite pass for a listing you already published, not a generator from a raw spec sheet; for building a listing from scratch facts, use Spec Sheet to Listing + SEO instead. Paste your current title, bullets, and description, and it returns an improved version with better keyword placement and benefit framing, plus exactly what changed and what facts are still missing, never adding a spec that wasn't already there.\n\nExample input: \"Current title: 'Water Bottle'. Current description: 'Good water bottle, keeps drinks cold.'\"\n\nExample output: \"{ title: 'Insulated Stainless Steel Water Bottle, Keeps Drinks Cold', bullets: ['KEEPS COLD: insulated stainless steel construction'], description: 'This insulated stainless steel water bottle keeps drinks cold...', changes_made: ['front-loaded the material and benefit into the title', 'expanded the one-line description'], missing_details: ['capacity in oz/ml', 'exact insulation duration', 'lid type'] }\"",
    suggestedPriceUsdc: 0.06,
    category: "business",
    department: "Marketing",
    graph: productListingOptimizer,
  },
  {
    slug: "uptime-anomaly-report-writer",
    whoPays: "SRE and platform teams turning a raw dump of logs or metrics into a readable anomaly report before the next standup.",
    name: "Uptime and Anomaly Report Writer",
    pitch: "Paste raw logs or metric snapshots, get an anomaly report ranked by severity with the evidence line quoted, $0.08 per report.",
    description:
      "A read-only anomaly report from pasted logs or metrics, not a live monitor; there is no connector here, only what you paste in. Drop in a batch of log lines or metric snapshots and it returns every anomaly it can actually point to evidence for, ranked by severity, with a likely cause and the next action, and it says so plainly when nothing looks abnormal instead of manufacturing a finding.\n\nExample input: \"[02:10] p99 latency 180ms. [02:14] p99 latency 2400ms. [02:14] 47x 'connection pool exhausted' errors. [02:20] p99 latency 190ms.\"\n\nExample output: \"{ anomalies: [{ signal: 'p99 latency spike', severity: 'high', evidence: '[02:14] p99 latency 2400ms, 47x connection pool exhausted errors', likely_cause: 'connection pool exhaustion under load', recommended_action: 'raise pool size or add a circuit breaker for the affected period' }], baseline_note: 'p99 sits around 180-190ms outside the 02:14 window.', clean: false }\"",
    suggestedPriceUsdc: 0.08,
    category: "business",
    department: "Engineering",
    graph: uptimeAnomalyReportWriter,
  },
  // ── Existing: personal ───────────────────────────────────────────────────────
  {
    slug: "meeting-prep",
    whoPays: "Founders and sellers: a one-page prep brief before any sales or partnership meeting.",
    name: "Meeting Prep Brief",
    pitch: "A 1-page prep brief for any meeting: $0.08 per brief.",
    description:
      "Generates a 1-page prep brief before a sales or partnership meeting: company summary, pain points, talking points.\n\nExample input: \"Company: Splice, contact: Head of Creator Partnerships, meeting type: partnership\"\n\nExample output: \"Splice is a subscription sample library with 6M+ users. Pain: creator monetization gap. Talking points: paid creator campaigns and agent workflows...\"",
    suggestedPriceUsdc: 0.08,
    category: "personal",
    graph: meetingPrepBrief,
  },
  {
    slug: "invoice-chaser",
    whoPays: "Freelancers and small teams: polite, firmer-over-time reminders drafted for every overdue invoice.",
    name: "Invoice Chaser",
    pitch: "Drafts follow-ups for every overdue invoice every Monday: $0.05 per run.",
    description:
      "Drafts polite, progressively firmer payment reminder emails for overdue invoices.\n\nExample input: \"Client: Beat Collective LLC, invoice: INV-2026-047, amount: $1200, overdue: 14 days\"\n\nExample output: \"Subject: Friendly reminder: INV-2026-047. Hi Beat Collective team, just a quick note that invoice #047 for $1,200 is now 14 days past due...\"",
    suggestedPriceUsdc: 0.05,
    category: "personal",
    graph: invoiceChaser,
  },
  {
    slug: "faq-concierge",
    whoPays: "Support teams: questions answered straight from your docs, with the source cited.",
    name: "FAQ Concierge",
    pitch: "Answers any question from your knowledge base: $0.02 per answer.",
    description:
      "Answers customer questions using your product docs and past support tickets. Returns the answer plus the source.\n\nExample input: \"Question: How do I export my stems? Product: Suede Create\"\n\nExample output: \"Go to Create → Stems tab → Export. Supported formats: WAV 44.1kHz 16-bit, AIFF. Source: docs.suedeai.ai/stems#export\"",
    suggestedPriceUsdc: 0.02,
    category: "personal",
    graph: faqConcierge,
  },
  // ── New: general-purpose expansion (personal) ────────────────────────────────
  {
    slug: "meeting-scheduler-assistant",
    whoPays: "Founders, assistants, and scheduling agents coordinating a meeting across people and time zones without the back-and-forth.",
    name: "Meeting Scheduler Assistant",
    pitch: "Paste everyone's stated availability, get 3 proposed meeting slots converted to each person's time zone, $0.04 per request.",
    description:
      "Turns a thread of loose availability replies into a short list of slots that actually work. Paste in whatever people said, 'mornings are best', 'free after 2pm Thursday', with rough locations or time zones, plus the meeting length, and it returns up to three ranked slots converted into each person's local time, and calls out anyone whose availability was too vague to place.\n\nExample input: \"Duration: 30 min. Dana (NYC): free Tue/Wed afternoons. Priya (London): mornings only, GMT. Lucas (SF): flexible Wed-Thu.\"\n\nExample output: \"{ duration_minutes: 30, proposed_slots: [{ slot_utc: '2026-07-14T14:00:00Z', per_person: [{ person: 'Dana', local_time: '10:00 AM EDT', timezone: 'America/New_York' }, { person: 'Priya', local_time: '3:00 PM BST', timezone: 'Europe/London' }, { person: 'Lucas', local_time: '7:00 AM PDT', timezone: 'America/Los_Angeles' }] }], gaps: [] }\"",
    suggestedPriceUsdc: 0.04,
    category: "personal",
    graph: meetingSchedulerAssistant,
  },
  {
    slug: "meeting-notes-to-action-items",
    whoPays: "Anyone leaving a meeting with a pile of notes who wants a clean, owned, dated action list instead of re-reading their own scrawl.",
    name: "Meeting Notes to Action Items",
    pitch: "Paste raw meeting notes, get a clean action item list with an owner and a due date on every line, $0.03 per meeting.",
    description:
      "Turns the scrawl from a meeting into a list you can actually act on. Paste in raw notes and it separates what was decided from what still needs doing, assigns an owner to every action item when one was named (or marks it unassigned), and pulls a due date when one was stated or clearly implied, without inventing a commitment nobody made.\n\nExample input: \"Notes: agreed to move launch to Aug 3. Sam will send the updated timeline by Friday. Still need to confirm the vendor contract, nobody owns that yet.\"\n\nExample output: \"{ decisions: ['Launch date moved to Aug 3'], action_items: [{ task: 'Send updated timeline', owner: 'Sam', due_date: 'Friday' }, { task: 'Confirm vendor contract', owner: 'unassigned', due_date: null }], unassigned_count: 1 }\"",
    suggestedPriceUsdc: 0.03,
    category: "personal",
    graph: meetingNotesToActionItems,
  },
  // ── Existing: creator showcases ──────────────────────────────────────────────
  {
    slug: "ar-analyst",
    whoPays: "Labels and A&R scouts: a weekly scouting note on the track you point it at.",
    name: "A&R Analyst",
    pitch: "Files a scout report every Monday: sell the analysis for $0.15.",
    description:
      "Runs weekly on its own: analyzes the track you point it at and has Claude write the A&R scout note. A research desk on a schedule.",
    suggestedPriceUsdc: 0.15,
    category: "creator",
    graph: arAnalyst,
  },
  {
    slug: "song-register-royalty",
    whoPays: "Artists and labels: generate, register the IP, and split the royalties in one call.",
    name: "Release Machine",
    pitch: "Generate, register the IP, split the royalties: a $0.50 release desk that runs itself.",
    description:
      "The full ownership loop in one call: generate an original Suede song, register it on the IP registry, and route a 90/10 royalty split. Releasing as a service.",
    suggestedPriceUsdc: 0.5,
    category: "creator",
    graph: releaseMachine,
  },
  // ── Creator campaign pack (Suede Promo) ────────────────────────────────────
  {
    slug: "campaign-launcher",
    whoPays:
      "Brands and labels running a launch: one call opens a funded creator campaign on Suede Promo.",
    name: "Campaign Launcher",
    pitch: "Open a paid creator campaign from one call: sell the launch button for $0.25.",
    description:
      "Turns a single call into a live campaign brief on Suede Promo. You set the reward, the slot count, and the disclosure terms when you publish; every call opens a campaign against that configuration and hands back the campaign ID and its public URL.\n\nCampaigns land unfunded and in draft — Suede ops confirm escrow before anything goes live and before any creator can claim a slot. This agent proposes work; it cannot move money.\n\nExample output: \"{ campaignId: '72ebb90c-509c-415e-9fe7-90fe09a84889', campaignUrl: 'https://promo.suedeai.ai/c/72ebb90c-509c-415e-9fe7-90fe09a84889', name: 'Launch push' }\"",
    suggestedPriceUsdc: 0.25,
    category: "creator",
    graph: campaignLauncher,
  },
  {
    slug: "campaign-watch",
    whoPays:
      "Anyone running campaigns: a 9am standup note on the claims a human still has to judge.",
    name: "Campaign Watch",
    pitch: "Reads the review queue every morning and tells you what to open first: $0.06 a run.",
    description:
      "Runs on its own each morning: pulls the campaign claims automated verification could not settle, then has Claude write a short standup note grouping them by why they are stuck and naming the ones to open first.\n\nRead-only. Suede Promo stays the system of record — this reads the claim ledger and never approves, rejects, or pays anything. An empty queue gets one line, not a report.",
    suggestedPriceUsdc: 0.06,
    category: "creator",
    graph: campaignWatch,
  },
  {
    slug: "creator-brief-writer",
    whoPays:
      "Brands briefing creators: turn a rough launch note into a brief creators can act on without a call.",
    name: "Creator Brief Writer",
    pitch: "Rough launch note in, disclosure-safe creator brief out: $0.04 a draft.",
    description:
      "Turns a rough launch description into a brief a creator can act on without asking questions: what to make, what must appear in the post, what gets work rejected, and how acceptance is judged.\n\nDisclosure is written in, never softened — paid posts carry a visible #ad or plain-language equivalent. It promises no reach, earnings, or results, and when the input never says what the product actually does it lists that as an open question instead of inventing one.\n\nNo side effects: this drafts the brief, it does not open a campaign.",
    suggestedPriceUsdc: 0.04,
    category: "creator",
    graph: creatorBriefWriter,
  },
  {
    slug: "licensing-desk",
    whoPays: "Artists and music supervisors: a send-ready sync/commercial licensing quote on demand.",
    name: "Licensing Desk",
    pitch: "Drafts a licensing quote and terms summary on demand: $0.05 a lookup.",
    description:
      "Drafts a music licensing quote and terms summary for a sync or commercial use request.\n\nExample input: \"Track: 'Quiet Signal' by Jason C. Use: 30s ad spot, national broadcast. Budget: $800\"\n\nExample output: \"License type: Sync + Master. Term: 1 year. Territory: US. Fee: $800. Restrictions: no political advertising...\"",
    suggestedPriceUsdc: 0.05,
    category: "creator",
    graph: licensingDesk,
  },

  // ── Connection-free data utility workflows ─────────────────────────────────
  {
    slug: "spreadsheet-cleanup-dedupe",
    whoPays: "RevOps, finance, and operations teams cleaning recurring CSV or XLSX exports before import or analysis.",
    name: "Spreadsheet Cleanup and Dedupe",
    pitch: "Filter, dedupe, sort, and export a clean XLSX without a model call: $0.03 per file.",
    description:
      "A rule-based four-step data service: parse CSV bytes, drop empty rows, remove duplicate records by selected keys, keep and sort the fields you need, then return a downloadable XLSX artifact. The included contact fixture makes the workflow runnable immediately; replace it with a CSV export, or switch Parse Spreadsheet to XLSX before supplying a workbook. No connector, warehouse, or LLM is required.",
    suggestedPriceUsdc: 0.03,
    category: "business",
    department: "Ops",
    graph: spreadsheetCleanupAndDedupe,
  },
  {
    slug: "spreadsheet-quality-report",
    whoPays: "Data and operations teams that need an inspectable cleanup summary before handing a file to another system.",
    name: "Spreadsheet Cleanup PDF Summary",
    pitch: "Clean a spreadsheet and return its rules, counts, and row preview as a plain-text PDF summary: $0.03 per file.",
    description:
      "Parses a CSV locally, removes blank and duplicate records using explicit settings, and renders the applied rules, cleanup counts, and a bounded row preview into a plain-text PDF summary. It is rule-based, credential-free, and model-free.",
    suggestedPriceUsdc: 0.03,
    category: "business",
    department: "Ops",
    graph: spreadsheetQualityReport,
  },
  {
    slug: "csv-to-xlsx-converter",
    whoPays: "Operators and downstream agents that receive CSV but need a bounded, immediately downloadable Excel workbook.",
    name: "CSV to XLSX Converter",
    pitch: "Turn CSV rows into an XLSX that escapes leading formula-like characters: $0.02 per file.",
    description:
      "A credential-free conversion service that parses CSV bytes, creates a single-sheet XLSX workbook with a header row, frozen header, and autofilter, escapes leading formula-like text characters, and returns an allowlisted downloadable artifact. It uses bounded local computation and no model call.",
    suggestedPriceUsdc: 0.02,
    category: "business",
    department: "Ops",
    graph: csvToXlsxConverter,
  },
  {
    slug: "data-analysis-agent",
    whoPays: "Ops, finance, and RevOps teams (or their reporting agents): a fast interpretive read on a data pull without wiring up a live warehouse connection, on every ad-hoc question.",
    name: "Data Analysis Agent",
    pitch: "Parse a CSV into rows, then return the strongest trend, anomaly, method, and chart spec: $0.10 per file.",
    description:
      "A real four-step data workflow: Input carries a deterministic CSV sample, Parse Spreadsheet turns bytes into typed row objects, the analyst computes a supported trend and anomaly, and Output exposes the result. Replace the sample base64 with your own CSV; no warehouse or paid connector is required.",
    suggestedPriceUsdc: 0.1,
    category: "business",
    department: "Ops",
    graph: dataAnalysisAgent,
  },
  {
    slug: "ad-campaign-auditor",
    whoPays: "Performance marketers and media-buying agents auditing spend across Google/Meta/LinkedIn campaigns against their own CPA and budget rules, every reporting cycle.",
    name: "Ad Campaign Auditor",
    pitch: "Paste your ad campaign performance data, get a pause / scale / keep verdict per campaign with the CPA math attached: $0.08 per audit.",
    description:
      "A performance read for pasted campaign data, not a live connection to any ad account. Paste in spend, impressions, clicks, conversions, and CPA per campaign or ad set (CSV-like text, a copied table, or JSON) plus your target CPA or budget rules if you have them, and it returns a per-campaign verdict of scale, keep, or pause, each one anchored to the exact CPA, target, and delta it was computed from, not a vague impression. It also flags campaigns showing a spend spike with flat conversions or an odd CTR-to-conversion mismatch, worth a manual look at the creative. It never pulls live data from an ad account and never invents a campaign or number that wasn't in the input; when a target is missing, it judges against the account's own blended CPA and says so.\n\nExample input: \"Campaign,Spend,Conversions,Target_CPA\\nSummer Sale - Search,1200,48,20\\nSummer Sale - Display,900,6,20\\nRetargeting - Meta,400,32,15\"\n\nExample output: \"{ accountSummary: { totalSpend: 2500, totalConversions: 86, blendedCpa: 29.07 }, campaigns: [{ name: 'Summer Sale - Search', spend: 1200, conversions: 48, cpa: 25.0, target: 20, verdict: 'keep', reasoning: 'CPA $25.00 is 25% over the $20 target but volume (48 conversions) is solid; not far enough over to pause.' }, { name: 'Summer Sale - Display', spend: 900, conversions: 6, cpa: 150.0, target: 20, verdict: 'pause', reasoning: 'CPA $150.00 is 7.5x the $20 target on meaningful spend ($900) with only 6 conversions.' }, { name: 'Retargeting - Meta', spend: 400, conversions: 32, cpa: 12.5, target: 15, verdict: 'scale', reasoning: 'CPA $12.50 is 17% under the $15 target with strong volume (32 conversions).' }], watchFlags: ['Summer Sale - Display: high spend, near-zero conversions: check creative fatigue or landing page'], note: 'Pause Summer Sale - Display immediately; it is burning budget at 7.5x target CPA.' }\"",
    suggestedPriceUsdc: 0.08,
    category: "business",
    department: "Marketing",
    graph: adCampaignAuditor,
  },
  {
    slug: "crm-update-diff-builder",
    name: "CRM Update Diff Builder",
    pitch: "Diff-before-write CRM updates: propose the change, never write blind. $0.09 per record",
    description:
      "Pastes in the current CRM record (as JSON) plus new context (a call transcript, an email thread, or meeting notes) and returns a structured, field-by-field diff of what should change: current value, proposed value, the exact quote that justifies it, and a confidence score, plus a one-line summary. This distills the diff-before-write safety pattern from Gumloop's CRM Agent: the model never writes to the CRM and never claims to have updated anything, it only proposes a side-by-side diff for a human or a separate write step to review and approve. It differs from Call Notes to CRM, which extracts a fresh MEDDIC-shaped record from a transcript alone. This template takes an existing record as an input, reasons about what specifically should change against it, and outputs an auditable diff rather than a full replacement record, which is what makes it safe to sit in front of an actual CRM write. Example input: current record { \"stage\": \"Discovery\", \"champion\": null, \"budget\": null } plus a call transcript where the prospect says \"I'll be the one pushing this internally\" and \"we've got about $40k set aside for this.\" Example output: { \"diff\": [ { \"field\": \"champion\", \"currentValue\": null, \"proposedValue\": \"prospect (self-identified)\", \"sourceQuote\": \"I'll be the one pushing this internally\", \"confidence\": 0.8 }, { \"field\": \"budget\", \"currentValue\": null, \"proposedValue\": \"$40,000\", \"sourceQuote\": \"we've got about $40k set aside for this\", \"confidence\": 0.85 } ], \"summary\": \"Champion and budget identified from call; stage unchanged, no evidence for a stage move.\" }",
    whoPays:
      "RevOps and sales-ops teams (and CRM-writing agents ahead of a Salesforce/HubSpot API call) who need a reviewable, evidence-backed diff before any automated CRM write: paid per record, every call or thread processed.",
    suggestedPriceUsdc: 0.09,
    category: "business",
    department: "Sales",
    graph: crmUpdateDiffBuilder,
  },
  {
    slug: "sales-call-scorecard",
    whoPays: "Sales managers and RevOps coaching agents: a consistent rubric score plus the buyer's own words for the recap email, on every rep call.",
    name: "Sales Call Scorecard",
    pitch: "Paste a sales call transcript, get a rubric scorecard and a recap email drafted in the buyer's own words: $0.09 per call.",
    description:
      "A coaching desk, not a CRM logger. Paste in a call transcript and, optionally, your own rubric criteria; it scores each area 0-10 with a one-line justification quoting the transcript (defaults to discovery, demo, and objection handling when no rubric is given), lists every objection raised and how the rep handled it, and pulls the buyer's own language on pain, budget, and timeline. It closes with a 3-sentence recap-email opener written in the buyer's own words, ready to paste into the follow-up. This is a coaching and grading pass, not CRM field extraction (see Call Notes to CRM) and not a task list (see Meeting Notes to Action Items); it exists to tell a rep how they scored and hand them the recap copy, not to populate a pipeline record or a to-do list.\n\nExample input: \"Rubric: discovery, demo, objection handling. Transcript: REP: 'What's driving the search?' BUYER: 'Our reconciliation is all manual, finance is drowning every month-end.' ... BUYER: 'Your price is higher than what we pay today.' REP: 'Let's look at the hours your team is burning on manual recon first.'\"\n\nExample output: \"{ scorecard: [{ area: 'discovery', score: 8, justification: 'Rep surfaced the real pain: \\\"reconciliation is all manual, finance is drowning\\\"' }, { area: 'objection handling', score: 6, justification: 'Reframed price objection to hours burned but did not quantify savings' }], objections: [{ objection: 'Price higher than current spend', handling: 'Reframed to time cost of manual recon', resolved: false }], buyerLanguage: { pain: 'reconciliation is all manual, finance is drowning every month-end', budget: 'not mentioned', timeline: 'not mentioned' }, recapEmailOpener: 'Thanks for walking me through how manual your month-end reconciliation has gotten. Finance drowning every close is exactly the kind of thing we fix...' }\"",
    suggestedPriceUsdc: 0.09,
    category: "business",
    department: "Sales",
    graph: salesCallScorecard,
  },
  {
    slug: "shopify-store-health-audit",
    name: "Shopify Store Health Audit",
    pitch: "Paste your store's product, pricing, and ad data, get a prioritized fix list with before/after diffs (never auto-applied): $0.12 per audit.",
    description:
      "A full-store operator audit, not a single-listing rewrite or a bundling tool. For a single listing, use Product Listing Optimizer, and for cart bundling, use Cart Cross-Sell & Bundler. Paste raw store data (product titles/descriptions, current pricing, ad spend with reported ROAS, and recent order volume) as JSON or CSV-like text, and it runs a structured health check across three lanes: SEO (weak or missing title keywords, thin meta-style descriptions), PDP conversion (missing trust signals, feature-only descriptions with no benefit stated), and ad economics (does the reported ROAS actually reconcile with the order volume, or is something off). Every finding comes back as a proposed change with a before/after diff; it reads and reasons over what you pasted, it never claims to have written anything to your store.\n\nExample input: \"{\\\"products\\\":[{\\\"title\\\":\\\"Mug\\\",\\\"description\\\":\\\"A mug.\\\",\\\"price\\\":14.99}],\\\"ad_spend_usd\\\":2000,\\\"reported_roas\\\":4.5,\\\"orders_last_30d\\\":38,\\\"avg_order_value_usd\\\":22}\"\n\nExample output: \"{ seo_findings: [{ product: 'Mug', issue: 'generic title with no keyword', before: 'Mug', after: 'Ceramic Coffee Mug, 12oz, Dishwasher Safe' }], pdp_findings: [{ product: 'Mug', issue: 'no trust signals, feature-only copy', before: 'A mug.', after: 'A sturdy 12oz ceramic mug built for daily coffee. Ships free, 30-day returns, dishwasher and microwave safe.' }], ad_economics: { reported_roas: '4.5', reconciles_with_orders: false, note: 'Reported ROAS implies ~$9,000 revenue at $2,000 spend, but 38 orders at ~$22 AOV is only ~$836. Figures do not reconcile.' }, action_items: [{ priority: 'high', area: 'ad_spend', proposed_change: 'Reconcile ad platform ROAS reporting against actual order data before trusting the reported number.', before: 'ROAS reported as 4.5x', after: 'Recalculate ROAS from actual order revenue' }], no_changes_written: true }\"",
    whoPays: "Shopify store owners and store-ops agents who want a broad operator-skill audit before touching anything: every proposed fix ships as a diff, never an applied change.",
    suggestedPriceUsdc: 0.12,
    category: "business",
    department: "Marketing",
    graph: shopifyStoreHealthAudit,
  },
];

/** Slugs that were public before a rename. Kept so links already shared in
 * the wild (grade results carry an absolute /build/new?template=... URL) keep
 * resolving instead of 404ing. */
const LEGACY_SLUG_ALIASES: Readonly<Record<string, string>> = {
  "agentix-rebuilder": "grade-rebuilder",
};

export function getTemplate(slug: string): SeedTemplate | undefined {
  const resolved = LEGACY_SLUG_ALIASES[slug] ?? slug;
  return SEED_TEMPLATES.find((template) => template.slug === resolved);
}
