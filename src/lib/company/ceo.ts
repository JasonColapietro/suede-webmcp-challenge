/**
 * The CEO brain — one turn at a time, for an already-founded company.
 * Sibling to src/lib/company/guided.ts (founding, one-shot whole-company
 * draft): this module instead takes the company's CURRENT state and
 * proposes exactly one action (hire / fireEmployee / budget /
 * createDepartment), or asks a clarifying question, or has a plain
 * conversational reply. It never
 * executes anything — src/app/api/companies/[id]/ceo/route.ts owns
 * execution, using the exact repo calls founding.ts and the existing
 * fire/departments/employees routes already use.
 *
 * Two paths selected at runtime, same convention as guided.ts:
 *   1. Real brain: ANTHROPIC_API_KEY present → generateObject, validated
 *      (and id-checked against the live company state) with
 *      CeoActionProposalZod.
 *   2. Fallback brain: no key, or any validation/id failure → deterministic
 *      keyword + word-overlap matching against the company's current
 *      departments/employees.
 *
 * Confirmation is turn-based and server-owned: if the immediately-prior
 * assistant turn in `history` carries a stored proposal, this turn's
 * message is first checked against it (yes/no) before any brain runs. This
 * deliberately does NOT mirror src/app/api/companies/found/route.ts's
 * client-echoed materialize pattern — history is now persisted server-side
 * (unlike the stateless founding wizard), so the server can and should be
 * the sole source of truth for "what was proposed," not the client.
 *
 * NOTE: server-side only (imports the manifest schema, node-meta catalog,
 * generateObject). Never import from a client component.
 */

import { z } from "zod";
import { AgentManifestSchema } from "@/lib/manifest/schema";
import { CompanyDraftEmployeeManifestZod, availableCompanyNodeMeta } from "@/lib/company/guided";
import { slugify } from "@/lib/slug";
import type { CeoMessageRecord } from "@/lib/db/repo";
import {
  modelSpendEntitlement,
  recordModelSpend,
  type ModelSpendBilling,
  type ModelSpendEntitlement,
} from "@/lib/gateway/model-spend";
import type { CompanyRecord, DepartmentRecord, EmployeeRecord } from "@/lib/company/types";

// ── Proposal shapes ──────────────────────────────────────────────────────────

const CeoBudgetAmountZod = z.number().finite().nonnegative().max(1_000_000).nullable();

export const CeoHireProposalZod = z
  .object({
    kind: z.literal("hire"),
    departmentId: z.string().trim().min(1).max(200),
    departmentName: z.string().trim().min(1).max(120),
    slug: z.string().trim().min(1).max(120),
    jobDescription: z.string().trim().min(1).max(2_000),
    monthlyBudgetUsdc: CeoBudgetAmountZod,
    manifest: CompanyDraftEmployeeManifestZod,
  })
  .strict();

export const CeoFireProposalZod = z
  .object({
    kind: z.literal("fireEmployee"),
    agentId: z.string().trim().min(1).max(200),
    employeeSummary: z.string().trim().min(1).max(240),
  })
  .strict();

export const CeoBudgetProposalZod = z
  .object({
    kind: z.literal("budget"),
    target: z.enum(["department", "employee"]),
    targetId: z.string().trim().min(1).max(200),
    targetName: z.string().trim().min(1).max(240),
    monthlyBudgetUsdc: CeoBudgetAmountZod,
  })
  .strict();

export const CeoCreateDepartmentProposalZod = z
  .object({
    kind: z.literal("createDepartment"),
    name: z.string().trim().min(1).max(120),
    monthlyBudgetUsdc: CeoBudgetAmountZod,
  })
  .strict();

export const CeoActionProposalZod = z.discriminatedUnion("kind", [
  CeoHireProposalZod,
  CeoFireProposalZod,
  CeoBudgetProposalZod,
  CeoCreateDepartmentProposalZod,
]);

export type CeoActionProposal = z.infer<typeof CeoActionProposalZod>;

export interface CeoCompanyContext {
  company: CompanyRecord;
  departments: DepartmentRecord[];
  /** Active employees only — the same scope repo.listEmployees already returns. */
  employees: EmployeeRecord[];
}

export type CeoTurnResult =
  | { readonly kind: "confirmed"; readonly proposal: CeoActionProposal }
  | { readonly kind: "cancelled"; readonly reply: string }
  | {
      readonly kind: "response";
      readonly reply: string;
      readonly proposal: CeoActionProposal | null;
      /** Which brain answered. `fallback` is the deterministic keyword brain. */
      readonly brain?: "model" | "fallback";
    };

interface CeoBrainReply {
  reply: string;
  proposal: CeoActionProposal | null;
}

// ── Confirm / cancel classification (brain-agnostic, deterministic) ────────────

const CONFIRM_RE = /^(yes|y|yep|yeah|yup|confirm|confirmed|do it|go ahead|sure|approve|approved|ok|okay)\b/i;
const CANCEL_RE = /^(no|n|nope|cancel|nevermind|never mind|stop|don'?t|do not|abort)\b/i;

function pendingProposalFrom(history: CeoMessageRecord[]): CeoActionProposal | null {
  const last = history[history.length - 1];
  if (!last || last.role !== "assistant" || last.proposal === null) return null;
  const parsed = CeoActionProposalZod.safeParse(last.proposal);
  return parsed.success ? parsed.data : null;
}

// ── Fallback brain — deterministic keyword + word-overlap matching ─────────────

/** Word-overlap score of `message` against `haystack` (mirrors scoreTemplate in src/lib/guided/draft.ts). */
function overlapScore(message: string, haystack: string): number {
  const words = message.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const target = haystack.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (target.includes(word)) score += 1;
  }
  return score;
}

function bestDepartmentMatch(message: string, departments: DepartmentRecord[]): DepartmentRecord | null {
  const scored = departments
    .map((d) => ({ d, score: overlapScore(message, d.name) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return null;
  return scored[0]!.d;
}

function bestEmployeeMatch(message: string, employees: EmployeeRecord[]): EmployeeRecord | null {
  const scored = employees
    .map((e) => ({ e, score: overlapScore(message, e.jobDescription) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return null;
  return scored[0]!.e;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function titleCase(value: string): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "New Employee";
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

function parseHire(message: string, context: CeoCompanyContext): CeoBrainReply {
  const department = bestDepartmentMatch(message, context.departments);
  if (!department) {
    const names = context.departments.map((d) => d.name).join(", ");
    return {
      reply: names
        ? `Which department should this hire join? (${names})`
        : "This company doesn't have any departments yet — add one first, then I can hire into it.",
      proposal: null,
    };
  }

  const departmentPhrase = new RegExp(`\\b(in|for|to)\\s+${escapeRegExp(department.name)}\\b`, "i");
  const role = message
    .replace(/\bhire\b/gi, "")
    .replace(departmentPhrase, "")
    .replace(/\b(another|a|an|the)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const jobDescription = role.length > 0 ? capitalize(role) : `New ${department.name} employee`;

  const manifest = AgentManifestSchema.parse({
    manifestVersion: 1,
    name: titleCase(jobDescription).slice(0, 120),
    description: jobDescription,
    triggers: [{ kind: "paidCall", priceUsdc: 0 }],
    steps: [
      { id: "n1", type: "llm", config: { prompt: jobDescription }, after: [] },
      { id: "n2", type: "output", config: {}, after: ["n1"] },
    ],
    meta: { createdBy: "guided" },
  });

  const proposal: CeoActionProposal = {
    kind: "hire",
    departmentId: department.id,
    departmentName: department.name,
    slug: slugify(jobDescription),
    jobDescription,
    monthlyBudgetUsdc: null,
    manifest,
  };

  return {
    reply: `I'll hire a new employee in ${department.name}: "${jobDescription}". Reply yes to confirm.`,
    proposal,
  };
}

function parseFire(message: string, context: CeoCompanyContext): CeoBrainReply {
  if (context.employees.length === 0) {
    return { reply: "There are no employees to let go yet.", proposal: null };
  }
  const employee = bestEmployeeMatch(message, context.employees);
  if (!employee) {
    return {
      reply: 'Which employee should I let go? Mention their role, e.g. "fire the campaign writer".',
      proposal: null,
    };
  }
  const proposal: CeoActionProposal = {
    kind: "fireEmployee",
    agentId: employee.agentId,
    employeeSummary: employee.jobDescription,
  };
  return {
    reply: `I'll remove "${employee.jobDescription}" from the company — their agent stops running publicly, but their history is kept. Reply yes to confirm.`,
    proposal,
  };
}

function extractAmount(message: string): number | null {
  const match = /\$?\s*(\d+(?:\.\d+)?)/.exec(message);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function parseBudget(message: string, context: CeoCompanyContext): CeoBrainReply {
  const amount = extractAmount(message);
  if (amount === null) {
    return { reply: "What monthly budget should I set (in USDC)?", proposal: null };
  }
  const department = bestDepartmentMatch(message, context.departments);
  const employee = bestEmployeeMatch(message, context.employees);

  if (department && !employee) {
    return {
      reply: `I'll set ${department.name}'s monthly budget to $${amount}. Reply yes to confirm.`,
      proposal: {
        kind: "budget",
        target: "department",
        targetId: department.id,
        targetName: department.name,
        monthlyBudgetUsdc: amount,
      },
    };
  }
  if (employee && !department) {
    return {
      reply: `I'll set "${employee.jobDescription}"'s monthly budget to $${amount}. Reply yes to confirm.`,
      proposal: {
        kind: "budget",
        target: "employee",
        targetId: employee.agentId,
        targetName: employee.jobDescription,
        monthlyBudgetUsdc: amount,
      },
    };
  }
  return { reply: "Whose budget should I change — a department or a specific employee?", proposal: null };
}

/** Fillers stripped from an extracted department name before use. */
function cleanDepartmentName(raw: string): string {
  return raw
    .replace(/\b(a|an|the|new|department|dept|called|named)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCreateDepartment(message: string, context: CeoCompanyContext): CeoBrainReply {
  // "called X" / "named X" wins; otherwise "a X department" / "X department".
  const called = /department\s+(?:called|named)\s+["']?([\w &/-]+?)["']?\s*(?:$|[.,!])/i.exec(message);
  const inline = /(?:a|an|new|the)\s+([\w &/-]+?)\s+department/i.exec(message);
  const raw = called?.[1] ?? inline?.[1] ?? "";
  const name = titleCase(cleanDepartmentName(raw));
  if (name === "" || name === "New Employee") {
    return { reply: "What should the new department be called?", proposal: null };
  }
  const existing = context.departments.find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    return { reply: `${existing.name} already exists — hire into it instead?`, proposal: null };
  }
  const amount = extractAmount(message);
  const budgetPhrase = amount === null ? "no budget cap" : `a $${amount}/mo budget cap`;
  return {
    reply: `I'll create a ${name} department with ${budgetPhrase}. No one runs until you hire into it. Reply yes to confirm.`,
    proposal: { kind: "createDepartment", name, monthlyBudgetUsdc: amount },
  };
}

/** Deterministic brain — no ANTHROPIC_API_KEY required, always available. */
export async function runCeoFallbackTurn(message: string, context: CeoCompanyContext): Promise<CeoBrainReply> {
  if (/\b(create|add|open|start|spin up|make|need)\b/i.test(message) && /\bdepartments?\b/i.test(message) && !/\bhire\b/i.test(message)) {
    return parseCreateDepartment(message, context);
  }
  if (/\bhire\b/i.test(message)) return parseHire(message, context);
  if (/\b(fire|remove|let go|terminate|dismiss)\b/i.test(message)) return parseFire(message, context);
  if (/\b(budget|bump|cap|spend(?:ing)? limit)\b/i.test(message)) return parseBudget(message, context);
  return {
    reply:
      'I can hire, let someone go, change a budget, or create a department. Try "hire a note-taker for Marketing" or "add a Licensing department".',
    proposal: null,
  };
}

// ── Real LLM brain ────────────────────────────────────────────────────────────

function buildCeoSystemPrompt(context: CeoCompanyContext): string {
  const nodeList = availableCompanyNodeMeta()
    .map((n) => `- ${n.type}: ${n.label} (${n.group})`)
    .join("\n");
  const departmentList =
    context.departments
      .map((d) => `- id=${d.id} name="${d.name}" monthlyBudgetUsdc=${d.monthlyBudgetUsdc ?? "none"}`)
      .join("\n") || "(none yet)";
  const employeeList =
    context.employees
      .map(
        (e) =>
          `- agentId=${e.agentId} departmentId=${e.departmentId} job="${e.jobDescription}" monthlyBudgetUsdc=${e.monthlyBudgetUsdc ?? "none"}`,
      )
      .join("\n") || "(none yet)";

  return [
    `You are the CEO assistant for "${context.company.name}" on Suede Agent Studio.`,
    "The founder gives you plain-language instructions to grow or trim the org chart. You may propose AT MOST ONE action per turn — hire, fireEmployee, budget, or createDepartment — and you never execute it yourself; the founder confirms separately.",
    "",
    "Rules:",
    "- If the request is actionable and you have enough information, return exactly one proposal plus a short reply describing it that ends by asking the founder to confirm.",
    "- If information is missing (which department, which employee, what amount, what to call a new department), return proposal: null and ask ONE clarifying question as reply.",
    "- If the request is anything other than hire/fireEmployee/budget/createDepartment, return proposal: null and say so plainly in reply.",
    "- createDepartment.name must not match an existing department name (case-insensitive). If the founder asks for one that exists, return proposal: null and point them at it.",
    "- hire.departmentId, fireEmployee.agentId, and budget.targetId must be copied EXACTLY from the ids listed below — never invent one.",
    "- A hire's manifest must be a fully valid Suede agent manifest using ONLY the available node types below, with meta.createdBy set to 'guided'.",
    "- Be concise. Never apologize. Never say 'as an AI'.",
    "",
    "Current departments:",
    departmentList,
    "",
    "Current employees:",
    employeeList,
    "",
    "Available node types (use ONLY these for a hire's manifest):",
    nodeList,
  ].join("\n");
}

/**
 * Runs the real LLM brain. Falls back to the deterministic brain on any
 * parse failure, out-of-catalog node type, or a proposal referencing an id
 * that isn't actually in `context` — mirrors runCompanyRealLlmTurn's
 * fallback-on-failure discipline in guided.ts.
 */
export async function runCeoRealLlmTurn(
  message: string,
  history: CeoMessageRecord[],
  context: CeoCompanyContext,
  billing?: ModelSpendBilling,
  entitlement?: Extract<ModelSpendEntitlement, { allowed: true }>,
): Promise<CeoBrainReply> {
  try {
    const { generateObject } = await import("ai");
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const conversationMessages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: message },
    ];

    const result = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      system: buildCeoSystemPrompt(context),
      messages: conversationMessages,
      schema: z.object({
        reply: z.string(),
        proposal: z.unknown().nullable(),
      }),
    });

    // Book the spend here, before any of the validation paths below can
    // bail to the fallback brain: the tokens were burned either way, and a
    // rejected proposal must not make the call free.
    if (billing && entitlement) {
      await recordModelSpend(billing, entitlement, result.usage?.totalTokens ?? 0, "company:ceo");
    }

    const raw = result.object;

    if (raw.proposal !== null) {
      const parsed = CeoActionProposalZod.safeParse(raw.proposal);
      if (!parsed.success) return runCeoFallbackTurn(message, context);
      const proposal = parsed.data;

      if (proposal.kind === "hire") {
        const availableTypes = new Set<string>(availableCompanyNodeMeta().map((n) => n.type));
        const stepsOk = proposal.manifest.steps.every((step) => availableTypes.has(step.type));
        if (!stepsOk || !context.departments.some((d) => d.id === proposal.departmentId)) {
          return runCeoFallbackTurn(message, context);
        }
      } else if (proposal.kind === "fireEmployee") {
        if (!context.employees.some((e) => e.agentId === proposal.agentId)) {
          return runCeoFallbackTurn(message, context);
        }
      } else if (proposal.kind === "createDepartment") {
        const duplicate = context.departments.some(
          (d) => d.name.toLowerCase() === proposal.name.toLowerCase(),
        );
        if (duplicate) return runCeoFallbackTurn(message, context);
      } else {
        const exists =
          proposal.target === "department"
            ? context.departments.some((d) => d.id === proposal.targetId)
            : context.employees.some((e) => e.agentId === proposal.targetId);
        if (!exists) return runCeoFallbackTurn(message, context);
      }

      const reply =
        typeof raw.reply === "string" && raw.reply.trim() !== ""
          ? raw.reply
          : "Ready when you are — reply yes to confirm.";
      return { reply, proposal };
    }

    if (typeof raw.reply === "string" && raw.reply.trim() !== "") {
      return { reply: raw.reply, proposal: null };
    }
    return runCeoFallbackTurn(message, context);
  } catch {
    return runCeoFallbackTurn(message, context);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Advances a company's CEO chat by one turn. `history` is every prior turn
 * for this company, oldest first, NOT including `message` (same convention
 * as runCompanyGuidedTurn). Confirmation/cancellation is checked against
 * the immediately-prior assistant turn's stored proposal before any brain
 * runs — see the module docstring for why this deviates from founding's
 * client-echoed materialize pattern.
 */
export async function runCeoTurn(
  message: string,
  history: CeoMessageRecord[],
  context: CeoCompanyContext,
  billing?: ModelSpendBilling,
): Promise<CeoTurnResult> {
  const trimmed = message.trim();
  const pending = pendingProposalFrom(history);
  if (pending) {
    if (CONFIRM_RE.test(trimmed)) return { kind: "confirmed", proposal: pending };
    if (CANCEL_RE.test(trimmed)) return { kind: "cancelled", reply: "Okay, cancelled. Nothing changed." };
    // Any other message abandons the stale proposal and is parsed as a fresh instruction below.
  }

  // The real brain spends the funded model key, so it needs a configured key
  // AND a workspace entitled to model spend (gateway/model-spend.ts). Without
  // either, the CEO answers from its deterministic brain rather than failing:
  // an unpaid workspace can still run its company, it just gets keyword
  // matching instead of a model reading the conversation.
  let brain: CeoBrainReply;
  let usedModel = false;
  if (process.env.ANTHROPIC_API_KEY && billing) {
    const entitlement = await modelSpendEntitlement(billing);
    if (entitlement.allowed) {
      brain = await runCeoRealLlmTurn(trimmed, history, context, billing, entitlement);
      usedModel = true;
    } else {
      brain = await runCeoFallbackTurn(trimmed, context);
    }
  } else {
    brain = await runCeoFallbackTurn(trimmed, context);
  }

  return {
    kind: "response",
    reply: brain.reply,
    proposal: brain.proposal,
    brain: usedModel ? "model" : "fallback",
  };
}
