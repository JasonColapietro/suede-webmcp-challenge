import type { JsonObjectSchema } from "./flow/input-contract";

export const CURATED_BUSINESS_COLLECTION = "business-operations";

export interface CuratedBusinessServiceContract {
  readonly key: string;
  readonly slug: string;
  readonly templateId: string;
  readonly name: string;
  readonly collection: typeof CURATED_BUSINESS_COLLECTION;
  readonly operator: "Suede Labs AI";
  readonly description: string;
  readonly buyerIntent: string;
  readonly tags: readonly string[];
  readonly inputSchema: JsonObjectSchema;
  readonly outputSchema: JsonObjectSchema;
  readonly exampleInput: Readonly<Record<string, unknown>>;
  readonly exampleOutput: Readonly<Record<string, unknown>>;
  readonly reviewPolicy: string;
  readonly dataHandling: string;
}

const nonEmptyString = (description: string): Record<string, unknown> => ({
  type: "string",
  minLength: 1,
  description,
});

const stringArray = (description: string): Record<string, unknown> => ({
  type: "array",
  description,
  items: { type: "string" },
});

const CONTRACTS: readonly CuratedBusinessServiceContract[] = [
  {
    key: "po-match",
    slug: "po-match-gate-mkgu0",
    templateId: "tpl-po-invoice-match",
    name: "PO Match Gate",
    collection: CURATED_BUSINESS_COLLECTION,
    operator: "Suede Labs AI",
    description:
      "Compare one purchase order with its invoice. Returns pass or hold, with every quantity, unit-price, vendor, and total discrepancy identified before payment approval.",
    buyerIntent:
      "Use before approving an invoice that should reconcile to a purchase order.",
    tags: ["accounts-payable", "invoice", "purchase-order", "reconciliation", "finance"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["purchaseOrder", "invoice"],
      properties: {
        purchaseOrder: nonEmptyString("Purchase-order text or structured JSON serialized as text."),
        invoice: nonEmptyString("Invoice text or structured JSON serialized as text."),
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["matched", "status", "discrepancies", "note"],
      properties: {
        matched: { type: "boolean" },
        status: { type: "string", enum: ["pass", "hold"] },
        discrepancies: stringArray("Every supported mismatch between the PO and invoice."),
        note: { type: "string" },
      },
    },
    exampleInput: {
      purchaseOrder: "PO-9920: 100 widget-A units at $2.50, total $250.00.",
      invoice: "INV-7781 for PO-9920: 100 widget-A units at $2.65, total $265.00.",
    },
    exampleOutput: {
      matched: false,
      status: "hold",
      discrepancies: ["Unit price is $2.65 on the invoice and $2.50 on the PO; delta $15.00."],
      note: "Hold for buyer approval because the invoice exceeds the PO price.",
    },
    reviewPolicy: "A human approver remains responsible for releasing payment.",
    dataHandling:
      "Inputs and outputs are stored in Agent Studio run history. See /privacy and /account-deletion.",
  },
  {
    key: "resume-jd-screen",
    slug: "resume-vs-jd-screener-wp72w",
    templateId: "tpl-resume-jd-screen",
    name: "Resume vs JD Screener",
    collection: CURATED_BUSINESS_COLLECTION,
    operator: "Suede Labs AI",
    description:
      "Compare one candidate resume with one job description. Returns an evidence-based fit score, supported and missing requirements, three interview questions, and a screening recommendation.",
    buyerIntent:
      "Use for a consistent first screen before a human recruiter reviews the candidate.",
    tags: ["recruiting", "resume", "job-description", "candidate-screening", "hr"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobDescription", "resume"],
      properties: {
        jobDescription: nonEmptyString(
          "The complete job description, including responsibilities and required qualifications.",
        ),
        resume: nonEmptyString(
          "The candidate resume text to compare with the supplied job description.",
        ),
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["fitScore", "met", "missing", "questions", "verdict"],
      properties: {
        fitScore: { type: "number", minimum: 0, maximum: 100 },
        met: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["requirement", "evidence"],
            properties: {
              requirement: nonEmptyString("A qualification stated in the job description."),
              evidence: nonEmptyString("Resume evidence supporting the qualification."),
            },
          },
        },
        missing: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["requirement", "note"],
            properties: {
              requirement: nonEmptyString("A missing or only partially supported qualification."),
              note: nonEmptyString("Why the supplied resume does not fully support the qualification."),
            },
          },
        },
        questions: {
          ...stringArray("Exactly three interview questions targeting gaps or unverified claims."),
          minItems: 3,
          maxItems: 3,
        },
        verdict: { type: "string", enum: ["advance", "phone screen", "reject"] },
      },
    },
    exampleInput: {
      jobDescription:
        "Senior Backend Engineer: 5+ years, Go, Postgres, and production Kubernetes experience required.",
      resume:
        "Six years in backend engineering using Go and Python. Built a billing service on Postgres and operated services on ECS. No Kubernetes experience listed.",
    },
    exampleOutput: {
      fitScore: 74,
      met: [
        { requirement: "5+ years of backend experience", evidence: "Six years in backend engineering." },
        { requirement: "Go and Postgres", evidence: "Used Go and built a billing service on Postgres." },
      ],
      missing: [
        { requirement: "Production Kubernetes", note: "The resume lists ECS but does not mention Kubernetes." },
      ],
      questions: [
        "What production orchestration systems have you owned end to end?",
        "How did you design and operate the Postgres-backed billing service?",
        "What would you need to learn before operating this role's Kubernetes workloads?",
      ],
      verdict: "phone screen",
    },
    reviewPolicy:
      "A human recruiter remains responsible for screening, interviewing, and hiring decisions.",
    dataHandling:
      "Resume, job-description, and output content are stored in Agent Studio run history. See /privacy and /account-deletion.",
  },
  {
    key: "contract-red-flag",
    slug: "contract-red-flag-scan-chm9v",
    templateId: "tpl-contract-redflag-scan",
    name: "Contract Red-Flag Scan",
    collection: CURATED_BUSINESS_COLLECTION,
    operator: "Suede Labs AI",
    description:
      "Extract a PDF contract and return a first-pass risk report covering liability, indemnity, renewal, termination, IP, exclusivity, governing law, and payment terms.",
    buyerIntent:
      "Use to prioritize clauses for qualified legal review before signing or renewal.",
    tags: ["contract-review", "legal-operations", "risk", "pdf", "red-flags"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["filename", "fileBase64"],
      properties: {
        filename: {
          type: "string",
          minLength: 5,
          description: "A filename ending in .pdf.",
          pattern: "\\.pdf$",
        },
        fileBase64: {
          type: "string",
          minLength: 8,
          contentEncoding: "base64",
          contentMediaType: "application/pdf",
          description: "The complete PDF encoded as base64.",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["flagCount", "flags"],
      properties: {
        flagCount: { type: "integer", minimum: 0 },
        flags: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["severity", "issue", "risk", "redline"],
            properties: {
              severity: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
              issue: { type: "string" },
              risk: { type: "string" },
              redline: { type: "string" },
            },
          },
        },
      },
    },
    exampleInput: {
      filename: "sample-msa.pdf",
      fileBase64: "JVBERi0xLjQKc3ludGhldGljLXNhbXBsZQ==",
    },
    exampleOutput: {
      flagCount: 1,
      flags: [
        {
          severity: "HIGH",
          issue: "Uncapped one-way indemnity",
          risk: "The customer bears unlimited third-party claim exposure.",
          redline: "Make indemnity mutual and subject to the negotiated liability cap.",
        },
      ],
    },
    reviewPolicy: "Informational first-pass review only. Qualified legal counsel must review decisions.",
    dataHandling:
      "Uploaded contract content and outputs are stored in Agent Studio run history. See /privacy and /account-deletion.",
  },
  {
    key: "vendor-risk",
    slug: "vendor-risk-read-q0jjq",
    templateId: "tpl-vendor-risk-read",
    name: "Vendor Risk Read",
    collection: CURATED_BUSINESS_COLLECTION,
    operator: "Suede Labs AI",
    description:
      "Assess a supplied vendor profile for onboarding risk, name and tax mismatches, thin operating history, banking-change fraud signals, and missing diligence.",
    buyerIntent:
      "Use before adding a new supplier or accepting a material vendor banking change.",
    tags: ["vendor-risk", "procurement", "supplier-onboarding", "fraud", "due-diligence"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["vendorProfile"],
      properties: {
        vendorProfile: nonEmptyString(
          "Vendor details supplied by the caller, including registration, ownership, references, and banking-change context.",
        ),
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["grade", "flags", "decision", "collect", "note"],
      properties: {
        grade: { type: "string", enum: ["LOW RISK", "MEDIUM RISK", "HIGH RISK"] },
        flags: stringArray("Risk signals supported by the supplied profile."),
        decision: { type: "string", enum: ["onboard", "hold", "decline"] },
        collect: stringArray("Documents or confirmations needed before approval."),
        note: { type: "string" },
      },
    },
    exampleInput: {
      vendorProfile:
        "NorthBridge Supply LLC. W-9 says NorthBridge Holdings LLC. Formed two months ago. Requests first payment to a personal-name bank account. No trade references. First PO is $58,000.",
    },
    exampleOutput: {
      grade: "HIGH RISK",
      flags: ["Legal-name mismatch", "Personal-name payment account", "No trade references"],
      decision: "hold",
      collect: ["Corrected W-9", "Bank-account ownership confirmation", "Two trade references"],
      note: "Hold onboarding until identity and payment destination are independently verified.",
    },
    reviewPolicy: "A human owner remains responsible for onboarding, rejection, and payment changes.",
    dataHandling:
      "Inputs and outputs are stored in Agent Studio run history. See /privacy and /account-deletion.",
  },
  {
    key: "expense-policy",
    slug: "expense-policy-check-l8o5i",
    templateId: "tpl-expense-policy-check",
    name: "Expense Policy Check",
    collection: CURATED_BUSINESS_COLLECTION,
    operator: "Suede Labs AI",
    description:
      "Compare one expense with the policy supplied by the caller. Returns approve, flag, or reject, plus the reimbursable amount and supported violations.",
    buyerIntent:
      "Use to pre-screen a reimbursement claim before a human approver reviews it.",
    tags: ["expense", "policy", "reimbursement", "finance", "compliance"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expense", "expensePolicy"],
      properties: {
        expense: nonEmptyString("Expense details, amount, category, receipt state, and relevant context."),
        expensePolicy: nonEmptyString("The exact policy rules to apply to the expense."),
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "reimbursable_amount", "violations", "note"],
      properties: {
        verdict: { type: "string", enum: ["approve", "flag", "reject"] },
        reimbursable_amount: { type: "number", minimum: 0 },
        violations: stringArray("Policy violations supported by the supplied expense and rules."),
        note: { type: "string" },
      },
    },
    exampleInput: {
      expense: "Dinner $112.40, including $34 wine. Receipt attached.",
      expensePolicy: "Meals are capped at $75 per day. Alcohol is not reimbursable. Receipts are required over $25.",
    },
    exampleOutput: {
      verdict: "flag",
      reimbursable_amount: 75,
      violations: ["Expense exceeds the $75 meal cap", "Expense includes non-reimbursable alcohol"],
      note: "Route to an approver with reimbursement capped at $75.",
    },
    reviewPolicy: "A human approver remains responsible for reimbursement and payroll decisions.",
    dataHandling:
      "Inputs and outputs are stored in Agent Studio run history. See /privacy and /account-deletion.",
  },
  {
    key: "bank-reconciliation",
    slug: "bank-rec-discrepancy-finder-bw0tt",
    templateId: "tpl-bank-rec-discrepancy",
    name: "Bank Rec Discrepancy Finder",
    collection: CURATED_BUSINESS_COLLECTION,
    operator: "Suede Labs AI",
    description:
      "Compare bank-statement lines with book entries and return matched counts, classified exceptions, the unreconciled total, and the next item to investigate.",
    buyerIntent:
      "Use during period close to isolate the transactions preventing a bank reconciliation.",
    tags: ["bank-reconciliation", "accounting", "month-end-close", "exceptions", "finance"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["bankStatement", "bookEntries"],
      properties: {
        bankStatement: nonEmptyString("Bank-statement transaction lines for one period."),
        bookEntries: nonEmptyString("Ledger or book transaction lines for the same period."),
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["reconciled", "matched", "exceptions", "net_unreconciled", "note"],
      properties: {
        reconciled: { type: "boolean" },
        matched: { type: "integer", minimum: 0 },
        exceptions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "detail", "amount"],
            properties: {
              type: {
                type: "string",
                enum: [
                  "missing_in_books",
                  "missing_on_bank",
                  "outstanding_check",
                  "duplicate_on_bank",
                  "duplicate_in_books",
                  "amount_mismatch",
                  "timing_difference",
                ],
              },
              detail: { type: "string" },
              amount: { type: "number" },
            },
          },
        },
        net_unreconciled: { type: "number" },
        note: { type: "string" },
      },
    },
    exampleInput: {
      bankStatement: "06/02 deposit +2400; 06/05 Vendor X -780; 06/05 Vendor X -780; 06/08 service fee -32.",
      bookEntries: "06/02 customer deposit +2400; 06/05 Vendor X bill pay -780; 06/07 check 1042 -540.",
    },
    exampleOutput: {
      reconciled: false,
      matched: 2,
      exceptions: [
        { type: "duplicate_on_bank", detail: "Second Vendor X debit has no matching book entry.", amount: -780 },
        { type: "missing_in_books", detail: "Bank service fee is absent from the books.", amount: -32 },
        { type: "outstanding_check", detail: "Check 1042 is in the books but not on the bank statement.", amount: -540 },
      ],
      net_unreconciled: -1352,
      note: "Confirm the duplicate debit, post the fee, and trace check 1042.",
    },
    reviewPolicy: "A controller or bookkeeper remains responsible for journal entries and closing the period.",
    dataHandling:
      "Inputs and outputs are stored in Agent Studio run history. See /privacy and /account-deletion.",
  },
] as const;

const BY_SLUG = new Map(CONTRACTS.map((contract) => [contract.slug, contract]));

export function listCuratedBusinessServiceContracts(): readonly CuratedBusinessServiceContract[] {
  return CONTRACTS;
}

/**
 * Return a curation contract only for the exact platform-operated live slug
 * and the expected template graph. Either identity drifting fails closed.
 */
export function curatedBusinessService(
  slug: string,
  graph: { readonly id: string },
): CuratedBusinessServiceContract | null {
  const contract = BY_SLUG.get(slug);
  return contract?.templateId === graph.id ? contract : null;
}

/** Input contract shared by discovery and pre-payment validation. */
export function publishedServiceInputSchema(
  slug: string,
  graph: { readonly id: string },
  fallback: JsonObjectSchema,
): JsonObjectSchema {
  return curatedBusinessService(slug, graph)?.inputSchema ?? fallback;
}

function parseJsonText(value: string): unknown {
  const trimmed = value.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  try {
    return JSON.parse(unfenced) as unknown;
  } catch {
    return null;
  }
}

function findStructuredResult(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 8) return null;
  if (typeof value === "string") {
    const parsed = parseJsonText(value);
    return parsed === null ? null : findStructuredResult(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = findStructuredResult(value[index], depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const preferred of ["result", "in", "output", "data", "text", "content", "value"]) {
    if (!(preferred in record)) continue;
    const found = findStructuredResult(record[preferred], depth + 1);
    if (found) return found;
  }
  // The parsed service object itself is the useful result.
  if (Object.keys(record).length > 0) return record;
  return null;
}

function matchesSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  depth = 0,
): boolean {
  if (depth > 12) return false;
  if (Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => Object.is(candidate, value))) return false;

  const type = schema.type;
  if (type === "string") {
    if (typeof value !== "string") return false;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (type === "integer" && !Number.isInteger(value)) return false;
    return typeof schema.minimum !== "number" || value >= schema.minimum;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return false;
    const items = schema.items;
    if (typeof items !== "object" || items === null || Array.isArray(items)) return true;
    return value.every((item) => matchesSchema(
      item,
      items as Readonly<Record<string, unknown>>,
      depth + 1,
    ));
  }
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [];
    if (required.some((key) => !(key in record))) return false;
    const properties = typeof schema.properties === "object" && schema.properties !== null &&
      !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};
    for (const [key, nestedValue] of Object.entries(record)) {
      const nestedSchema = properties[key];
      if (nestedSchema === undefined) {
        if (schema.additionalProperties === false) return false;
        continue;
      }
      if (typeof nestedSchema !== "object" || nestedSchema === null || Array.isArray(nestedSchema)) {
        return false;
      }
      if (!matchesSchema(
        nestedValue,
        nestedSchema as Readonly<Record<string, unknown>>,
        depth + 1,
      )) return false;
    }
    return true;
  }
  return true;
}

/**
 * Best-effort normalized JSON result for curated LLM workflows. Raw node
 * outputs remain the compatibility source of truth; this only adds a direct
 * machine-consumption field when the model returned parseable JSON.
 */
export function extractCuratedServiceResult(
  contract: CuratedBusinessServiceContract | null,
  graph: { readonly nodes: readonly { readonly id: string; readonly type: string }[] },
  outputs: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (!contract) return null;
  const outputNodeIds = graph.nodes
    .filter((node) => node.type === "output")
    .map((node) => node.id)
    .reverse();
  for (const nodeId of outputNodeIds) {
    const found = findStructuredResult(outputs[nodeId]);
    if (found && matchesSchema(found, contract.outputSchema)) return found;
  }
  return null;
}
