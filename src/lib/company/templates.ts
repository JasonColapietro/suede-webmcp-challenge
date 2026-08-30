import type { AgentManifest } from "@/lib/manifest/schema";

export interface CompanyTemplateEmployee {
  slug: string;
  jobDescription: string;
  monthlyBudgetUsdc?: number | null;
  publishGated?: boolean;
  manifest: AgentManifest;
}

export interface CompanyTemplateDepartment {
  name: string;
  monthlyBudgetUsdc: number | null;
  employees: CompanyTemplateEmployee[];
}

export interface CompanyTemplate {
  slug: string;
  name: string;
  mission: string;
  pitch: string;
  departments: CompanyTemplateDepartment[];
}

function marketingDepartment(campaignFocus: string): CompanyTemplateDepartment {
  return {
    name: "Marketing",
    monthlyBudgetUsdc: null,
    employees: [
      {
        slug: "promoter",
        jobDescription: "Drafts a focused campaign and launches it after approval.",
        publishGated: true,
        manifest: {
          manifestVersion: 1,
          name: "Promoter",
          description: `Drafts and launches approved campaigns for ${campaignFocus}.`,
          triggers: [{ kind: "manual" }],
          steps: [
            {
              id: "input",
              type: "input",
              config: { fields: { campaignGoal: "", audience: "", offer: "" } },
              after: [],
            },
            {
              id: "campaign-copy",
              type: "llm",
              config: {
                prompt:
                  "Write a concise campaign brief with a campaign name, audience, core message, creator instructions, deliverables, and review criteria from this input.\n\nCampaign input:\n{{in}}",
                system:
                  "You are a campaign strategist. Sell the work clearly, keep claims supportable, and return a launch-ready brief.",
              },
              after: ["input"],
            },
            {
              id: "publish-campaign",
              type: "suede.promo",
              config: { name: `${campaignFocus} Campaign`, brief: "{{in}}" },
              after: ["campaign-copy"],
            },
          ],
          meta: { createdBy: "guided" },
        },
      },
      {
        slug: "campaign-writer",
        jobDescription: "Turns a campaign goal into review-ready copy without publishing it.",
        manifest: {
          manifestVersion: 1,
          name: "Campaign Writer",
          description: `Writes review-ready campaign copy for ${campaignFocus}.`,
          triggers: [{ kind: "manual" }],
          steps: [
            {
              id: "input",
              type: "input",
              config: { fields: { campaignGoal: "", audience: "", channel: "" } },
              after: [],
            },
            {
              id: "write-campaign",
              type: "llm",
              config: {
                prompt:
                  "Write a campaign concept, headline, short body copy, call to action, and three channel-ready variants from this brief.\n\nBrief:\n{{in}}",
                system:
                  "You are a practical campaign copywriter. Be specific, concise, and honest about what the service delivers.",
              },
              after: ["input"],
            },
            {
              id: "output",
              type: "output",
              config: { label: "campaign-copy" },
              after: ["write-campaign"],
            },
          ],
          meta: { createdBy: "guided" },
        },
      },
    ],
  };
}

export const COMPANY_TEMPLATES: CompanyTemplate[] = [
  {
    slug: "rights-precheck-shop",
    name: "Rights Precheck Shop",
    mission: "Turn release details into clear rights prechecks and usable split-sheet paperwork.",
    pitch:
      "Review registry-backed rights signals, identify missing ownership details, and prepare split-sheet documents for release teams.",
    departments: [
      {
        name: "Operations",
        monthlyBudgetUsdc: null,
        employees: [
          {
            slug: "rights-precheck",
            jobDescription:
              "Checks registry-backed rights data and summarizes gaps that need human follow-up.",
            manifest: {
              manifestVersion: 1,
              name: "Rights Precheck",
              description:
                "Checks registry-backed rights data and returns a concise gap summary for review.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.25 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { assetHash: "" } },
                  after: [],
                },
                {
                  id: "rights-lookup",
                  type: "suede.rightsLookup",
                  config: {},
                  after: ["input"],
                },
                {
                  id: "gap-summary",
                  type: "llm",
                  config: {
                    prompt:
                      "Summarize the available rights record, list every missing or ambiguous field, and give the reviewer a short follow-up checklist. Do not invent ownership or clearance facts.\n\nRights lookup result:\n{{in}}",
                    system:
                      "You are a music-rights operations analyst preparing a precheck, not a legal opinion.",
                  },
                  after: ["rights-lookup"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "rights-precheck" },
                  after: ["gap-summary"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
          {
            slug: "split-sheet",
            jobDescription:
              "Builds a collaborator split table and renders the resulting paperwork as a PDF.",
            manifest: {
              manifestVersion: 1,
              name: "Split Sheet",
              description:
                "Builds a collaborator split table and renders a PDF document for review.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.5 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { splits: [] } },
                  after: [],
                },
                {
                  id: "royalty-split",
                  type: "suede.royaltySplit",
                  config: {},
                  after: ["input"],
                },
                {
                  id: "split-sheet-pdf",
                  type: "finance.generateInvoicePdf",
                  config: {
                    invoiceNumber: "SPLIT-SHEET",
                    sellerName: "Release Team",
                    buyerName: "Collaborators",
                    notes: "Review and confirm every listed split before release.",
                  },
                  after: ["royalty-split"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "split-sheet-pdf" },
                  after: ["split-sheet-pdf"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
        ],
      },
      marketingDepartment("rights precheck services"),
    ],
  },
  {
    slug: "sync-pitch-shop",
    name: "Sync Pitch Shop",
    mission: "Turn submitted track materials into clear, buyer-ready sync pitch packets.",
    pitch:
      "Extract the source material, analyze the track, and deliver a focused one-sheet for music supervisors and licensing teams.",
    departments: [
      {
        name: "Operations",
        monthlyBudgetUsdc: null,
        employees: [
          {
            slug: "pitch-packet",
            jobDescription:
              "Combines submitted track materials and audio analysis into a concise sync one-sheet.",
            manifest: {
              manifestVersion: 1,
              name: "Pitch Packet",
              description:
                "Extracts submitted materials, analyzes the track, and writes a concise sync one-sheet.",
              triggers: [{ kind: "paidCall", priceUsdc: 1 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { fileBase64: "", audioUrl: "" } },
                  after: [],
                },
                {
                  id: "extract-text",
                  type: "docs.extractText",
                  config: {},
                  after: ["input"],
                },
                {
                  id: "analyze-track",
                  type: "suede.analyze",
                  config: {},
                  after: ["extract-text"],
                },
                {
                  id: "write-one-sheet",
                  type: "llm",
                  config: {
                    prompt:
                      "Write a concise sync one-sheet with track summary, mood, tempo and sonic traits, scene-fit ideas, instrumental and vocal notes, and open clearance questions. Use only the supplied material and analysis.\n\nSource material and analysis:\n{{in}}",
                    system:
                      "You are a sync licensing coordinator. Write a specific buyer-ready one-sheet without inventing rights, placements, or clearance status.",
                  },
                  after: ["analyze-track"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "sync-one-sheet" },
                  after: ["write-one-sheet"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
        ],
      },
      marketingDepartment("sync pitch packets"),
    ],
  },
  {
    slug: "content-studio",
    name: "Content Studio",
    mission: "Turn current priorities and source documents into structured content your team can use.",
    pitch:
      "Create an operating brief when the founder requests it and convert document text into clean, reusable JSON for downstream work.",
    departments: [
      {
        name: "Operations",
        monthlyBudgetUsdc: null,
        employees: [
          {
            slug: "daily-brief",
            jobDescription: "Produces a concise operating brief when the founder fires it.",
            manifest: {
              manifestVersion: 1,
              name: "Daily Brief",
              description: "Produces a concise operating brief on the founder's request.",
              triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
              steps: [
                {
                  id: "write-brief",
                  type: "llm",
                  config: {
                    prompt:
                      "Write today's brief with priorities, deadlines, blockers, decisions needed, and the next concrete action for each item. If no operating context is supplied, return a compact brief template instead of inventing updates.\n\nOperating context:\n{{in}}",
                    system:
                      "You are an on-demand operations editor. Be concise, specific, and explicit when information is missing.",
                  },
                  after: [],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "daily-brief" },
                  after: ["write-brief"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
          {
            slug: "doc-to-json",
            jobDescription: "Extracts PDF text and reshapes it into clean structured JSON.",
            manifest: {
              manifestVersion: 1,
              name: "Document to JSON",
              description: "Extracts PDF text and returns clean structured JSON.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.05 }],
              steps: [
                {
                  id: "extract-text",
                  type: "docs.extractText",
                  config: {},
                  after: [],
                },
                {
                  id: "structure-document",
                  type: "llm",
                  config: {
                    prompt:
                      'Convert the extracted document into STRICT JSON only with this shape: { "title": string|null, "summary": string, "sections": [{ "heading": string|null, "content": string }], "entities": string[], "dates": string[] }. Preserve source meaning and use null or empty arrays when fields are absent.\n\nExtracted document:\n{{in}}',
                    system:
                      "You are a document-structuring analyst. Return valid JSON only and never invent missing facts.",
                  },
                  after: ["extract-text"],
                },
                {
                  id: "parse-json",
                  type: "transform",
                  config: { expression: "jsonParse(in)" },
                  after: ["structure-document"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "document-json" },
                  after: ["parse-json"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
        ],
      },
      marketingDepartment("content studio services"),
    ],
  },
  {
    slug: "audit-shop",
    name: "Audit Shop",
    mission: "Inspect public website signals and turn the findings into a practical review packet.",
    pitch:
      "Fetch a submitted public page and deliver a focused site audit with evidence, priorities, and next actions.",
    departments: [
      {
        name: "Operations",
        monthlyBudgetUsdc: null,
        employees: [
          {
            slug: "site-audit",
            jobDescription:
              "Inspects a submitted public webpage and returns a bounded, evidence-based audit.",
            manifest: {
              manifestVersion: 1,
              name: "Site Audit",
              description:
                "Fetches a submitted public webpage and returns a bounded audit of visible signals.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.5 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { url: "" } },
                  after: [],
                },
                {
                  id: "fetch-site",
                  type: "http",
                  config: {
                    method: "GET",
                    url: "{{in}}",
                    headers: { Accept: "text/html" },
                    timeoutMs: 10000,
                  },
                  after: ["input"],
                },
                {
                  id: "audit-site",
                  type: "llm",
                  config: {
                    prompt:
                      "Audit the fetched public page for message clarity, visible page structure, calls to action, trust signals, accessibility cues, and basic technical signals present in the response. Cite the supplied response for each finding, rank issues by priority, and give concrete next actions.\n\nFetched page response:\n{{in}}",
                    system:
                      "This audit inspects public signals only. It does not guarantee citations, recommendations, or rankings. You are a careful site auditor. Separate observed evidence from inference and say when the response does not expose a signal.",
                  },
                  after: ["fetch-site"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "site-audit" },
                  after: ["audit-site"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
        ],
      },
    ],
  },
  {
    slug: "support-triage-shop",
    name: "Support Triage Shop",
    mission:
      "Turn every incoming support ticket into a fast, consistent severity call and a clear refund or hold decision.",
    pitch:
      "Route tickets to the right severity in seconds and issue refund or hold verdicts your team can act on immediately.",
    departments: [
      {
        name: "Operations",
        monthlyBudgetUsdc: null,
        employees: [
          {
            slug: "ticket-triage",
            jobDescription: "Classifies an incoming support ticket by severity, category, and sentiment.",
            manifest: {
              manifestVersion: 1,
              name: "Ticket Triage",
              description: "Classifies an incoming support ticket by severity, category, and sentiment.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.03 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { ticketText: "" } },
                  after: [],
                },
                {
                  id: "classify-ticket",
                  type: "llm",
                  config: {
                    prompt:
                      "Classify this support ticket. Return ONLY JSON: { severity: 'low' | 'medium' | 'high' | 'urgent', category: string, sentiment: 'positive' | 'neutral' | 'negative', suggestedFirstResponse: string }.\n\nTicket:\n{{in}}",
                    system:
                      "You are a support triage analyst. Classify tickets fast and consistently from the stated text only.",
                  },
                  after: ["input"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "ticket-triage" },
                  after: ["classify-ticket"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
          {
            slug: "refund-decision",
            jobDescription: "Decides approve, deny, or escalate for a refund request against stated policy only.",
            manifest: {
              manifestVersion: 1,
              name: "Refund Decision Desk",
              description: "Decides approve, deny, or escalate for a refund request against stated policy only.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.05 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { orderDetails: "", ticketText: "" } },
                  after: [],
                },
                {
                  id: "decide-refund",
                  type: "llm",
                  config: {
                    prompt:
                      "Decide approve, deny, or escalate for this refund request using only the supplied order details and stated policy. Return ONLY JSON: { decision: 'approve' | 'deny' | 'escalate', reason: string, refundAmount: number | null }.\n\nRequest:\n{{in}}",
                    system:
                      "You are a refund-decision analyst working from stated policy only. Never invent a policy term that was not supplied.",
                  },
                  after: ["input"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "refund-decision" },
                  after: ["decide-refund"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
        ],
      },
      marketingDepartment("support triage services"),
    ],
  },
  {
    slug: "sales-pipeline-shop",
    name: "Sales Pipeline Shop",
    mission:
      "Turn inbound lead details and deal notes into qualification scores and pipeline-risk reads reps can act on.",
    pitch: "Score every inbound lead against your ICP and flag at-risk deals before they slip.",
    departments: [
      {
        name: "Operations",
        monthlyBudgetUsdc: null,
        employees: [
          {
            slug: "lead-qualifier",
            jobDescription: "Scores an inbound lead against stated ICP criteria and assigns a tier.",
            manifest: {
              manifestVersion: 1,
              name: "Lead Qualifier",
              description: "Scores an inbound lead against stated ICP criteria and assigns a tier.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.03 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { leadDetails: "" } },
                  after: [],
                },
                {
                  id: "score-lead",
                  type: "llm",
                  config: {
                    prompt:
                      "Score this lead 0-100 against the ICP criteria implied by the input and assign a tier. Return ONLY JSON: { score: number, tier: 'A' | 'B' | 'C' | 'D', reasoning: string, nextAction: string }.\n\nLead:\n{{in}}",
                    system:
                      "You are a lead-qualification analyst. Score only from the stated facts, never invent firmographic details.",
                  },
                  after: ["input"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "lead-score" },
                  after: ["score-lead"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
          {
            slug: "pipeline-risk-read",
            jobDescription: "Reads deal notes for churn and stall risk signals and recommends a next action.",
            manifest: {
              manifestVersion: 1,
              name: "Pipeline Risk Read",
              description: "Reads deal notes for churn and stall risk signals and recommends a next action.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.05 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { dealNotes: "" } },
                  after: [],
                },
                {
                  id: "read-risk",
                  type: "llm",
                  config: {
                    prompt:
                      "Read these deal notes, flag every churn or stall risk signal present in the text, and recommend one next action. Return ONLY JSON: { riskLevel: 'low' | 'medium' | 'high', signals: string[], recommendedAction: string }.\n\nDeal notes:\n{{in}}",
                    system: "You are a pipeline-risk analyst. Flag only signals supported by the stated notes.",
                  },
                  after: ["input"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "pipeline-risk" },
                  after: ["read-risk"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
        ],
      },
      marketingDepartment("sales pipeline services"),
    ],
  },
  {
    slug: "legal-intake-shop",
    name: "Legal Intake Shop",
    mission: "Give every incoming contract a fast, consistent first-pass legal read before a lawyer bills time.",
    pitch: "Extract the document, flag every red flag and unusual clause, and hand back a review-ready summary.",
    departments: [
      {
        name: "Operations",
        monthlyBudgetUsdc: null,
        employees: [
          {
            slug: "contract-scan",
            jobDescription: "Extracts a submitted contract and flags every supported red flag.",
            manifest: {
              manifestVersion: 1,
              name: "Contract Red-Flag Scan",
              description: "Extracts a submitted contract and flags every supported red flag.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.08 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { fileBase64: "", filename: "" } },
                  after: [],
                },
                {
                  id: "extract-text",
                  type: "docs.extractText",
                  config: {},
                  after: ["input"],
                },
                {
                  id: "scan-contract",
                  type: "llm",
                  config: {
                    prompt:
                      "Scan this contract text for red flags: unusual liability terms, auto-renewal, unilateral termination, indemnification imbalance, missing liability caps. Return ONLY JSON: { redFlags: [{ clause: string, risk: 'low' | 'medium' | 'high', note: string }], overallRisk: 'low' | 'medium' | 'high' }.\n\nContract text:\n{{in}}",
                    system:
                      "You are a contract reviewer. Rank only risks supported by the extracted text; never invent a clause that is not present.",
                  },
                  after: ["extract-text"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "redflag-report" },
                  after: ["scan-contract"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
          {
            slug: "term-extractor",
            jobDescription:
              "Extracts party names, dates, and payment terms from a submitted contract into structured JSON.",
            manifest: {
              manifestVersion: 1,
              name: "Contract Term Extractor",
              description: "Extracts key terms from a submitted contract into structured JSON.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.06 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { fileBase64: "", filename: "" } },
                  after: [],
                },
                {
                  id: "extract-text",
                  type: "docs.extractText",
                  config: {},
                  after: ["input"],
                },
                {
                  id: "extract-terms",
                  type: "llm",
                  config: {
                    prompt:
                      'Extract the key terms from this contract into STRICT JSON only: { "parties": string[], "effectiveDate": string | null, "term": string | null, "paymentTerms": string | null, "terminationClause": string | null, "renewalClause": string | null }. Use null for any field the text does not state.\n\nContract text:\n{{in}}',
                    system: "You are a contract-terms extraction analyst. Extract only stated facts and return valid JSON only.",
                  },
                  after: ["extract-text"],
                },
                {
                  id: "parse-terms",
                  type: "transform",
                  config: { expression: "jsonParse(in)" },
                  after: ["extract-terms"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "contract-terms" },
                  after: ["parse-terms"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
        ],
      },
      marketingDepartment("legal intake services"),
    ],
  },
  {
    slug: "finance-ops-shop",
    name: "Finance Ops Shop",
    mission: "Turn incoming POs, invoices, and expense claims into pass or hold verdicts before anything gets paid.",
    pitch:
      "Two-way-match every invoice against its PO and flag every out-of-policy expense claim before it's approved.",
    departments: [
      {
        name: "Operations",
        monthlyBudgetUsdc: null,
        employees: [
          {
            slug: "po-invoice-match",
            jobDescription: "Two-way-matches a purchase order against its invoice and returns a pass or hold verdict.",
            manifest: {
              manifestVersion: 1,
              name: "PO Match Gate",
              description: "Two-way-matches a purchase order against its invoice and returns a pass or hold verdict.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.05 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { poDetails: "", invoiceDetails: "" } },
                  after: [],
                },
                {
                  id: "match-po",
                  type: "llm",
                  config: {
                    prompt:
                      "Perform a two-way match between the purchase order and invoice below. Compare vendor, quantities, unit prices, and totals exactly. Return ONLY JSON: { matched: boolean, status: 'pass' | 'hold', discrepancies: string[] }.\n\nPO and invoice:\n{{in}}",
                    system:
                      "You are an accounts-payable matching engine. Do the arithmetic exactly and report every discrepancy.",
                  },
                  after: ["input"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "match-result" },
                  after: ["match-po"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
          {
            slug: "expense-policy-check",
            jobDescription: "Checks a submitted expense claim against a stated policy summary.",
            manifest: {
              manifestVersion: 1,
              name: "Expense Policy Check",
              description: "Checks a submitted expense claim against a stated policy summary.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.04 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { expenseDetails: "", policySummary: "" } },
                  after: [],
                },
                {
                  id: "check-policy",
                  type: "llm",
                  config: {
                    prompt:
                      "Check this expense claim against the supplied policy summary only. Return ONLY JSON: { compliant: boolean, violations: string[], recommendedAction: 'approve' | 'flag' | 'deny' }.\n\nClaim and policy:\n{{in}}",
                    system:
                      "You are an expense-policy auditor working from the stated policy only. Never invent a policy limit that was not supplied.",
                  },
                  after: ["input"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "policy-check" },
                  after: ["check-policy"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
          {
            slug: "reimbursement-voucher",
            jobDescription: "Turns an approved expense claim into a structured, printable reimbursement voucher PDF.",
            manifest: {
              manifestVersion: 1,
              name: "Reimbursement Voucher Writer",
              description: "Turns an approved expense claim into a structured, printable reimbursement voucher PDF.",
              triggers: [{ kind: "paidCall", priceUsdc: 0.06 }],
              steps: [
                {
                  id: "input",
                  type: "input",
                  config: { fields: { approvedClaim: "" } },
                  after: [],
                },
                {
                  id: "draft-voucher",
                  type: "llm",
                  config: {
                    prompt:
                      'Turn this approved expense claim into invoice-ready JSON. Return ONLY JSON: { "invoiceNumber": string, "sellerName": string, "buyerName": string, "lineItems": [{ "description": string, "quantity": number, "unitPrice": number }], "currency": string, "notes": string }. Compute line items from the stated amounts only.\n\nApproved claim:\n{{in}}',
                    system: "You are a reimbursement-voucher writer. Use only the amounts and names present in the claim.",
                  },
                  after: ["input"],
                },
                {
                  id: "parse-voucher",
                  type: "transform",
                  config: { expression: "jsonParse(in)" },
                  after: ["draft-voucher"],
                },
                {
                  id: "render-voucher",
                  type: "finance.generateInvoicePdf",
                  config: {},
                  after: ["parse-voucher"],
                },
                {
                  id: "output",
                  type: "output",
                  config: { label: "reimbursement-voucher" },
                  after: ["render-voucher"],
                },
              ],
              meta: { createdBy: "guided" },
            },
          },
        ],
      },
      marketingDepartment("finance ops services"),
    ],
  },
];
