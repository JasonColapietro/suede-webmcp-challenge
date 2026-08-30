/**
 * Company guided brain — mirrors src/lib/guided/draft.ts at company scope.
 * Two paths selected at runtime:
 *   1. Real brain: ANTHROPIC_API_KEY present → generateObject against a
 *      CompanyDraft-shaped schema, then validated (and normalized) with
 *      CompanyDraftZod, plus a node-type whitelist check per employee.
 *   2. Fallback brain: no key, or any validation failure → keyword-match
 *      against COMPANY_TEMPLATES, walk two slots (name, departments).
 *
 * The API is stateless: callers pass the full conversation history each
 * turn. NOTE: this file runs server-side only (imports manifest schema,
 *       templates, generateObject). Never import it from a client component.
 *
 * CompanyDraftZod below is a structural mirror of the `CompanyDraft`
 * interface owned by src/lib/company/founding.ts. That file is being
 * created in parallel, so it is deliberately NOT imported here — TypeScript
 * is structural, so the two shapes interoperate without a shared import.
 */

import { z } from "zod";
import { AgentManifestSchema, type AgentManifest } from "@/lib/manifest/schema";
import { COMPANY_TEMPLATES, type CompanyTemplate } from "@/lib/company/templates";
import {
  MAX_COMPANY_DRAFT_EMPLOYEES,
  countCompanyDraftEmployees,
} from "@/lib/company/draft-limits";
import type { ConversationTurn } from "@/lib/guided/draft";
import { projectAvailableNodeMeta } from "@/lib/flow/node-meta";
import { CONNECTOR_LAB_FLAG } from "@/lib/connectors/flags";
import {
  modelSpendEntitlement,
  recordModelSpend,
  type ModelSpendBilling,
  type ModelSpendEntitlement,
} from "@/lib/gateway/model-spend";

// ── Shared types ──────────────────────────────────────────────────────────────

/**
 * Validates AND normalizes an employee manifest via AgentManifestSchema
 * (applies its defaults, e.g. description/meta), mirroring the
 * unknown().transform() + safeParse + addIssue pattern already used for
 * SupportedAgentManifestSchema in src/lib/manifest/schema.ts.
 */
export const CompanyDraftEmployeeManifestZod: z.ZodType<AgentManifest, z.ZodTypeDef, unknown> = z
  .unknown()
  .transform((value, context) => {
    const result = AgentManifestSchema.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) context.addIssue(issue);
      return z.NEVER;
    }
    const manifest = result.data;
    if (manifest.name.length > 120) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Manifest name is too long" });
    }
    if (manifest.description.length > 2_000) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Manifest description is too long" });
    }
    if (manifest.triggers.length > 8) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Too many manifest triggers" });
    }
    if (manifest.steps.length > 64) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Too many manifest steps" });
    }
    for (const step of manifest.steps) {
      if (step.id.length > 120 || step.type.length > 120 || (step.label?.length ?? 0) > 240) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Manifest step text is too long" });
        break;
      }
      if (step.after.length > 64) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Too many manifest step edges" });
        break;
      }
    }
    return result.data;
  });

const CompanyBudgetZod = z.number().finite().nonnegative().max(1_000_000).nullable();

export const CompanyDraftEmployeeZod = z
  .object({
    slug: z.string().trim().min(1).max(120),
    jobDescription: z.string().trim().min(1).max(2_000),
    monthlyBudgetUsdc: CompanyBudgetZod,
    publishGated: z.boolean(),
    manifest: CompanyDraftEmployeeManifestZod,
  })
  .strict();

export const CompanyDraftDepartmentZod = z
  .object({
    name: z.string().trim().min(1).max(120),
    monthlyBudgetUsdc: CompanyBudgetZod,
    employees: z.array(CompanyDraftEmployeeZod).min(1).max(16),
  })
  .strict();

/** Zod mirror of founding.ts's CompanyDraft shape (see file header). */
export const CompanyDraftZod = z
  .object({
    name: z.string().trim().min(1).max(120),
    mission: z.string().trim().min(1).max(2_000),
    departments: z.array(CompanyDraftDepartmentZod).min(1).max(16),
  })
  .strict()
  .superRefine((draft, context) => {
    if (countCompanyDraftEmployees(draft) > MAX_COMPANY_DRAFT_EMPLOYEES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Company drafts may include at most ${MAX_COMPANY_DRAFT_EMPLOYEES} employees total`,
        path: ["departments"],
      });
    }
  });

export type CompanyDraft = z.infer<typeof CompanyDraftZod>;

export const CompanyGuidedResponseSchema = z
  .object({
    clarifyingQuestion: z.string().max(4_000).nullable(),
    company: CompanyDraftZod.nullable(),
    notIncluded: z.array(z.string().max(500)).max(32),
    /**
     * Which brain answered. `fallback` is the deterministic interview —
     * a working path, used when the workspace isn't entitled to model spend
     * (see gateway/model-spend.ts) or the model failed. Optional so the many
     * literal returns below stay unchanged; the entry point stamps it.
     */
    brain: z.enum(["model", "fallback"]).optional(),
  })
  .strict()
  .refine((v) => (v.clarifyingQuestion === null) !== (v.company === null), {
    message: "Exactly one of clarifyingQuestion or company must be non-null",
  });

export type CompanyGuidedResponse = z.infer<typeof CompanyGuidedResponseSchema>;

// ── Template → draft mapping (inline; founding.ts owns the canonical
//    materializer but is being created in parallel and must not be
//    imported from here) ────────────────────────────────────────────────────

function companyTemplateToDraft(tpl: CompanyTemplate): CompanyDraft {
  return {
    name: tpl.name,
    mission: tpl.mission,
    departments: tpl.departments.map((dept) => ({
      name: dept.name,
      monthlyBudgetUsdc: dept.monthlyBudgetUsdc,
      employees: dept.employees.map((emp) => ({
        slug: emp.slug,
        jobDescription: emp.jobDescription,
        monthlyBudgetUsdc: emp.monthlyBudgetUsdc ?? null,
        publishGated: emp.publishGated ?? false,
        manifest: emp.manifest,
      })),
    })),
  };
}

/** Built once at module load for the real brain's system-prompt example. */
const EXAMPLE_COMPANY_DRAFT: CompanyDraft = companyTemplateToDraft(COMPANY_TEMPLATES[0]!);

// ── Available node types — shared by the system prompt and the real-brain
//    whitelist guard ──────────────────────────────────────────────────────────

export function availableCompanyNodeMeta() {
  return projectAvailableNodeMeta(CONNECTOR_LAB_FLAG, "visible").filter(
    (node) => node.type !== "api.operation",
  );
}

// ── Fallback brain ────────────────────────────────────────────────────────────

/** The two interview slots walked by the fallback brain. */
const COMPANY_SLOTS: ReadonlyArray<{ question: string; key: "name" | "departments" }> = [
  { question: "What would you like to name this company?", key: "name" },
  {
    question: "Keep all departments, or only some? (name them, or say all)",
    key: "departments",
  },
];

/** Count user turns already present in history. */
function userTurnsInHistory(history: ConversationTurn[]): number {
  return history.filter((t) => t.role === "user").length;
}

/** Score a company template against a prompt via word overlap (mirrors matchTemplate in draft.ts). */
function scoreCompanyTemplate(prompt: string, tpl: CompanyTemplate): number {
  const lower = prompt.toLowerCase();
  const haystack = `${tpl.slug} ${tpl.name} ${tpl.mission} ${tpl.pitch}`.toLowerCase();
  const words = lower.split(/\W+/).filter((w) => w.length > 3);
  let score = 0;
  for (const word of words) {
    if (haystack.includes(word)) score += 1;
  }
  return score;
}

/** Find the best-matching company template for the user's initial prompt. */
function matchCompanyTemplate(prompt: string): CompanyTemplate {
  let best = COMPANY_TEMPLATES[0]!;
  let bestScore = -1;
  for (const tpl of COMPANY_TEMPLATES) {
    const s = scoreCompanyTemplate(prompt, tpl);
    if (s > bestScore) {
      bestScore = s;
      best = tpl;
    }
  }
  return best;
}

interface CompanySlotState {
  templateSlug: string;
  name: string | null;
  departmentsAnswer: string | null;
}

/** Extract slot answers from conversation history (including the latest message). */
function extractCompanySlots(fullHistory: ConversationTurn[]): CompanySlotState {
  const userMessages = fullHistory.filter((t) => t.role === "user").map((t) => t.content);
  const templateSlug = userMessages[0]
    ? matchCompanyTemplate(userMessages[0]).slug
    : COMPANY_TEMPLATES[0]!.slug;
  return {
    templateSlug,
    name: userMessages[1] ?? null,
    departmentsAnswer: userMessages[2] ?? null,
  };
}

/**
 * Filter departments to the subset named in `answer` via case-insensitive
 * substring match against each department's name. An empty or unrecognized
 * answer keeps every department (never produces a company with zero
 * departments from an ambiguous answer).
 */
function filterDepartmentsByAnswer(
  departments: CompanyDraft["departments"],
  answer: string | null,
): CompanyDraft["departments"] {
  if (!answer || !answer.trim()) return departments;
  const lower = answer.toLowerCase();
  const matched = departments.filter((dept) => lower.includes(dept.name.toLowerCase()));
  return matched.length > 0 ? matched : departments;
}

/** Build a CompanyDraft from collected slot answers. */
function buildCompanyDraftFromSlots(slots: CompanySlotState): CompanyDraft {
  const tpl =
    COMPANY_TEMPLATES.find((t) => t.slug === slots.templateSlug) ?? COMPANY_TEMPLATES[0]!;
  const draft = companyTemplateToDraft(tpl);
  const name = slots.name?.trim() || draft.name;
  const departments = filterDepartmentsByAnswer(draft.departments, slots.departmentsAnswer);
  return { ...draft, name, departments };
}

/**
 * Run one turn of the fallback (deterministic) brain.
 *
 * @param message - Latest user message.
 * @param history - All prior turns (user + assistant), NOT including `message`.
 * @returns CompanyGuidedResponse with exactly one non-null field; notIncluded
 *          is always [] on this path (the fallback never recognizes
 *          unsupported asks — it only matches templates and walks slots).
 */
export async function runCompanyFallbackTurn(
  message: string,
  history: ConversationTurn[],
): Promise<CompanyGuidedResponse> {
  const priorUserTurns = userTurnsInHistory(history);
  const totalUserTurns = priorUserTurns + 1; // includes `message`

  // After >= 3 user turns (initial + 2 slot answers), MUST draft.
  if (totalUserTurns >= 3) {
    const fullHistory: ConversationTurn[] = [...history, { role: "user", content: message }];
    const slots = extractCompanySlots(fullHistory);
    const company = buildCompanyDraftFromSlots(slots);
    return { clarifyingQuestion: null, company, notIncluded: [] };
  }

  // totalUserTurns 1 → ask slot[0] (name); 2 → ask slot[1] (departments).
  const slotIndex = totalUserTurns - 1;
  const slot = COMPANY_SLOTS[slotIndex];
  if (!slot) {
    // Safety: draft defensively. Unreachable given the >= 3 check above.
    const fullHistory: ConversationTurn[] = [...history, { role: "user", content: message }];
    const slots = extractCompanySlots(fullHistory);
    return {
      clarifyingQuestion: null,
      company: buildCompanyDraftFromSlots(slots),
      notIncluded: [],
    };
  }

  return { clarifyingQuestion: slot.question, company: null, notIncluded: [] };
}

// ── Real LLM brain ────────────────────────────────────────────────────────────

/** Build the system prompt for the real brain, injecting node types + one full example. */
export function buildCompanySystemPrompt(): string {
  const nodeList = availableCompanyNodeMeta()
    .map((n) => `- ${n.type}: ${n.label} (${n.group})`)
    .join("\n");

  return [
    "You are a company-founding assistant for Suede Agent Studio.",
    "Your job: ask ONE clarifying question at a time or produce the final company draft.",
    "",
    "Rules:",
    "- Ask at most 4 clarifying questions total across the conversation, then you MUST produce a company draft.",
    "- If you have enough information to found the company, produce the draft now.",
    "- Unsupported requests must be listed in notIncluded, named specifically — never silently dropped.",
    "- When the description names a real third-party brand as the company name, do not adopt it verbatim: propose a neutral name instead and note the naming risk in notIncluded.",
    "- Respond in the user's language when you can.",
    "- Every employee manifest must be a fully valid Suede agent manifest using ONLY the available node types below.",
    `- Include at most ${MAX_COMPANY_DRAFT_EMPLOYEES} employees total across all departments.`,
    "- Be concise. Never apologize. Never say 'as an AI'.",
    "- Always set each employee manifest's meta.createdBy to 'guided'.",
    "",
    "Available node types (use ONLY these):",
    nodeList,
    "",
    "Example company draft (follow this exact shape):",
    JSON.stringify(EXAMPLE_COMPANY_DRAFT, null, 2),
    "",
    "Return JSON with exactly one of:",
    '  { "clarifyingQuestion": "<string>", "company": null, "notIncluded": [] }',
    '  { "clarifyingQuestion": null, "company": <CompanyDraft>, "notIncluded": ["<unsupported ask>", ...] }',
  ].join("\n");
}

/**
 * Run one turn using the real LLM brain (Vercel AI SDK generateObject).
 * Falls back to runCompanyFallbackTurn on any parse failure, or when any
 * employee manifest uses a step type outside the available node list.
 */
export async function runCompanyRealLlmTurn(
  message: string,
  history: ConversationTurn[],
  billing?: ModelSpendBilling,
  entitlement?: Extract<ModelSpendEntitlement, { allowed: true }>,
): Promise<CompanyGuidedResponse> {
  try {
    const { generateObject } = await import("ai");
    const { createAnthropic } = await import("@ai-sdk/anthropic");

    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const userTurns = userTurnsInHistory(history) + 1;
    const forceDraft = userTurns >= 4;

    const systemPrompt =
      buildCompanySystemPrompt() +
      (forceDraft
        ? "\n\nYou MUST produce a company draft now. Do not ask another question."
        : "");

    const conversationMessages = [
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user" as const, content: message },
    ];

    const result = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      system: systemPrompt,
      messages: conversationMessages,
      schema: z.object({
        clarifyingQuestion: z.string().nullable(),
        company: z.unknown().nullable(),
        notIncluded: z.array(z.string()).default([]),
      }),
    });

    // Book the spend here, before any of the validation paths below can bail
    // to the fallback brain: the tokens were burned either way, and a
    // rejected draft must not make the call free.
    if (billing && entitlement) {
      await recordModelSpend(billing, entitlement, result.usage?.totalTokens ?? 0, "company:found");
    }

    const raw = result.object;

    if (raw.company !== null) {
      const parsedCompany = CompanyDraftZod.safeParse(raw.company);
      if (!parsedCompany.success) {
        // Any parse failure (including an invalid employee manifest) → fallback.
        return runCompanyFallbackTurn(message, history);
      }

      const availableTypes = new Set<string>(availableCompanyNodeMeta().map((n) => n.type));
      const allStepsAvailable = parsedCompany.data.departments.every((dept) =>
        dept.employees.every((emp) =>
          emp.manifest.steps.every((step) => availableTypes.has(step.type)),
        ),
      );
      if (!allStepsAvailable) {
        // A schema-valid manifest can still reference a node type outside
        // the projected catalog (StepSchema.type is an unconstrained
        // string) — reject it the same way an invalid manifest is rejected.
        return runCompanyFallbackTurn(message, history);
      }

      return {
        clarifyingQuestion: null,
        company: parsedCompany.data,
        notIncluded: raw.notIncluded,
      };
    }

    if (typeof raw.clarifyingQuestion === "string" && raw.clarifyingQuestion.trim() !== "") {
      return {
        clarifyingQuestion: raw.clarifyingQuestion,
        company: null,
        notIncluded: raw.notIncluded,
      };
    }

    return runCompanyFallbackTurn(message, history);
  } catch {
    return runCompanyFallbackTurn(message, history);
  }
}

/**
 * Main entry point: select the brain.
 *
 * The real brain spends the funded model key, so it needs a configured key
 * AND a workspace entitled to model spend (gateway/model-spend.ts). Without
 * either, founding degrades to its deterministic interview rather than
 * failing: an unpaid workspace can still found a company from a template,
 * it just gets the fixed slot questions instead of contextual ones.
 *
 * Passing no `billing` also means no model call — a caller with no billing
 * context must never be able to spend the key by omission.
 *
 * Rate-limiting is enforced at the API route layer, not here.
 */
export async function runCompanyGuidedTurn(
  message: string,
  history: ConversationTurn[],
  billing?: ModelSpendBilling,
): Promise<CompanyGuidedResponse> {
  const deterministic = async (): Promise<CompanyGuidedResponse> => ({
    ...(await runCompanyFallbackTurn(message, history)),
    brain: "fallback",
  });

  if (!process.env.ANTHROPIC_API_KEY || !billing) return deterministic();

  const entitlement = await modelSpendEntitlement(billing);
  if (!entitlement.allowed) return deterministic();

  return { ...(await runCompanyRealLlmTurn(message, history, billing, entitlement)), brain: "model" };
}
