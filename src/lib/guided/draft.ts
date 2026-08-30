/**
 * Guided brain — two paths selected at runtime:
 *   1. Real brain: ANTHROPIC_API_KEY present → generateObject with GuidedDraftSchema
 *   2. Fallback brain: no key or parse failure → keyword-match to templates, walk slots
 *
 * The API is stateless: callers pass the full conversation history each turn.
 * NOTE: This file runs server-side only (imports manifest schema, templates).
 *       Never import it from a client component.
 */

import { z } from "zod";
import { AgentManifestSchema, type AgentManifest } from "@/lib/manifest/schema";
import { SEED_TEMPLATES } from "@/lib/templates";
import { isPublicTemplateMarketingAllowed } from "@/lib/marketing-holds";
import { projectAvailableNodeMeta } from "@/lib/flow/node-meta";
import { CONNECTOR_LAB_FLAG } from "@/lib/connectors/flags";
import { parseCron } from "@/lib/cron";
import {
  modelSpendEntitlement,
  recordModelSpend,
  type ModelSpendBilling,
  type ModelSpendEntitlement,
} from "@/lib/gateway/model-spend";

// ── Shared types ──────────────────────────────────────────────────────────────

export const ConversationTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

export const GuidedDraftSchema = z
  .object({
    clarifyingQuestion: z.string().nullable(),
    manifest: AgentManifestSchema.nullable(),
    /**
     * Which brain answered this turn. `fallback` is the deterministic
     * interview — a real, working path, used when the workspace isn't
     * entitled to model spend (see gateway/model-spend.ts) or the model
     * failed. Surfaced so the UI can be honest about why the questions are
     * fixed rather than contextual, instead of quietly looking worse.
     */
    brain: z.enum(["model", "fallback"]).optional(),
  })
  .refine((v) => (v.clarifyingQuestion === null) !== (v.manifest === null), {
    message: "Exactly one of clarifyingQuestion or manifest must be non-null",
  });

export type GuidedResponse = z.infer<typeof GuidedDraftSchema>;

// ── Fallback brain ────────────────────────────────────────────────────────────

const GUIDED_TEMPLATES = SEED_TEMPLATES.filter((template) =>
  isPublicTemplateMarketingAllowed(template.slug),
);

/** Interview slots walked by the fallback brain. */
const SLOTS: ReadonlyArray<{ question: string; key: "name" | "cadence" | "price" }> = [
  { question: "What would you like to name this agent?", key: "name" },
  {
    question:
      'How often should it run? (e.g. "every morning", "hourly", "on demand")',
    key: "cadence",
  },
  {
    question:
      "Last question. What price (in USDC) should other agents pay per call? Enter 0 for free.",
    key: "price",
  },
];

/** Count user turns already present in history. */
function userTurnsInHistory(history: ConversationTurn[]): number {
  return history.filter((t) => t.role === "user").length;
}

/** Score a template against a prompt via word overlap. */
function scoreTemplate(
  prompt: string,
  templateName: string,
  templatePitch: string,
  templateDesc: string,
): number {
  const lower = prompt.toLowerCase();
  const haystack = `${templateName} ${templatePitch} ${templateDesc}`.toLowerCase();
  const words = lower.split(/\W+/).filter((w) => w.length > 3);
  let score = 0;
  for (const word of words) {
    if (haystack.includes(word)) score += 1;
  }
  return score;
}

/** Find best-matching template slug for the user's initial prompt. */
function matchTemplate(prompt: string): string {
  let bestSlug = GUIDED_TEMPLATES[0]!.slug;
  let bestScore = -1;
  for (const tpl of GUIDED_TEMPLATES) {
    const s = scoreTemplate(prompt, tpl.name, tpl.pitch, tpl.description);
    if (s > bestScore) {
      bestScore = s;
      bestSlug = tpl.slug;
    }
  }
  return bestSlug;
}

/** Parse cadence string to a cron expression. Returns "" to signal on-demand (paidCall). */
function cadenceToCron(cadence: string): string {
  const lower = cadence.toLowerCase();
  if (/hourly|every hour/.test(lower)) return "0 * * * *";
  if (/every 30|half.?hour|30 min/.test(lower)) return "*/30 * * * *";
  if (/weekday|mon.*fri|work day/.test(lower)) return "0 9 * * 1-5";
  if (/weekly|every week|monday/.test(lower)) return "0 9 * * 1";
  if (/morning|daily|every day|once a day/.test(lower)) return "0 9 * * *";
  if (/evening|night/.test(lower)) return "0 20 * * *";
  if (/on demand|manual|per call/.test(lower)) return ""; // signals paidCall trigger
  // Default: daily 9 AM UTC
  return "0 9 * * *";
}

/** Extract price from a string. Returns 0 if unparseable. */
function parsePrice(s: string): number {
  const match = /[\d]+\.?[\d]*/.exec(s);
  if (!match) return 0;
  const n = parseFloat(match[0]);
  return isFinite(n) ? Math.max(0, n) : 0;
}

interface SlotState {
  templateSlug: string;
  name: string | null;
  cadence: string | null;
  price: number | null;
}

/** Extract slot answers from conversation history (including latest message). */
function extractSlots(fullHistory: ConversationTurn[]): SlotState {
  const userMessages = fullHistory
    .filter((t) => t.role === "user")
    .map((t) => t.content);
  const templateSlug = userMessages[0]
    ? matchTemplate(userMessages[0])
    : GUIDED_TEMPLATES[0]!.slug;
  return {
    templateSlug,
    name: userMessages[1] ?? null,
    cadence: userMessages[2] ?? null,
    price: userMessages[3] !== undefined ? parsePrice(userMessages[3]) : null,
  };
}

/** Build a manifest from collected slot answers. */
function buildManifestFromSlots(slots: SlotState): AgentManifest {
  const tpl =
    GUIDED_TEMPLATES.find((t) => t.slug === slots.templateSlug) ?? GUIDED_TEMPLATES[0]!;
  const name = slots.name?.trim() || tpl.name;
  const cron = cadenceToCron(slots.cadence ?? "");
  const price = slots.price ?? tpl.suggestedPriceUsdc;

  const usesSchedule = cron !== "";
  const triggers: AgentManifest["triggers"] = usesSchedule
    ? [{ kind: "schedule", cron }]
    : [{ kind: "paidCall", priceUsdc: price }];

  // Build steps from the matched template graph (exclude the schedule trigger node).
  const stepNodes = tpl.graph.nodes.filter((n) => n.type !== "schedule");
  const steps: AgentManifest["steps"] = stepNodes.map((n, i) => ({
    id: n.id,
    type: n.type,
    config: { ...n.params },
    after: i === 0 ? [] : [stepNodes[i - 1]!.id],
  }));

  return AgentManifestSchema.parse({
    manifestVersion: 1,
    name,
    description: tpl.description,
    triggers,
    steps,
    meta: { template: tpl.slug, createdBy: "guided" },
  });
}

function replaceTrigger(
  manifest: AgentManifest,
  kind: "schedule" | "paidCall",
  next: AgentManifest["triggers"][number],
): AgentManifest {
  const index = manifest.triggers.findIndex((trigger) => trigger.kind === kind);
  const triggers =
    index >= 0
      ? manifest.triggers.map((trigger, triggerIndex) => (triggerIndex === index ? next : trigger))
      : [...manifest.triggers, next];
  return { ...manifest, triggers };
}

/** Deterministic, lossless edits for the properties Guided exposes without an LLM key. */
export async function runFallbackEditTurn(
  message: string,
  manifest: AgentManifest,
): Promise<GuidedResponse> {
  const trimmed = message.trim();
  let edited = manifest;
  let changed = false;

  const rename = /(?:rename(?: it)?|name(?: it)?)\s+(?:to\s+)?["']?(.+?)["']?$/i.exec(trimmed);
  if (rename?.[1]?.trim()) {
    edited = { ...edited, name: rename[1].trim() };
    changed = true;
  }

  const description = /(?:description|job)\s+(?:to\s+)?["']?(.+?)["']?$/i.exec(trimmed);
  if (description?.[1]?.trim()) {
    edited = { ...edited, description: description[1].trim() };
    changed = true;
  }

  if (/price|charge|per call/i.test(trimmed)) {
    const priceMatch = /(?:\$|usdc\s*)?(\d+(?:\.\d+)?)/i.exec(trimmed);
    if (priceMatch?.[1]) {
      edited = replaceTrigger(edited, "paidCall", {
        kind: "paidCall",
        priceUsdc: Number(priceMatch[1]),
      });
      changed = true;
    }
  }

  if (/schedule|cron|hourly|morning|daily|weekday|weekly|evening|night/i.test(trimmed)) {
    const cronMatch = /((?:\S+\s+){4}\S+)/.exec(trimmed);
    const explicitCron = cronMatch?.[1] && parseCron(cronMatch[1]) ? cronMatch[1] : null;
    const cron = explicitCron ?? cadenceToCron(trimmed);
    if (cron !== "") {
      edited = replaceTrigger(edited, "schedule", { kind: "schedule", cron });
      changed = true;
    }
  }

  if (!changed) {
    return {
      clarifyingQuestion: "What should I change: its job, schedule, price, or name?",
      manifest: null,
    };
  }

  return {
    clarifyingQuestion: null,
    manifest: AgentManifestSchema.parse({
      ...edited,
      meta: { ...edited.meta, createdBy: "guided" },
    }),
  };
}

/**
 * Run one turn of the fallback (deterministic) brain.
 *
 * @param message - Latest user message.
 * @param history - All prior turns (user + assistant), NOT including `message`.
 * @returns GuidedResponse with exactly one non-null field.
 */
export async function runFallbackTurn(
  message: string,
  history: ConversationTurn[],
): Promise<GuidedResponse> {
  const priorUserTurns = userTurnsInHistory(history);
  const totalUserTurns = priorUserTurns + 1; // includes `message`

  // After 4 user turns (initial + 3 slot answers), MUST draft.
  if (totalUserTurns >= 4) {
    const fullHistory: ConversationTurn[] = [
      ...history,
      { role: "user", content: message },
    ];
    const slots = extractSlots(fullHistory);
    const manifest = buildManifestFromSlots(slots);
    return { clarifyingQuestion: null, manifest };
  }

  // Determine which slot question to ask next.
  // totalUserTurns 1 → ask slot[0]; 2 → ask slot[1]; 3 → ask slot[2] (last question).
  const slotIndex = totalUserTurns - 1; // 0-based
  const slot = SLOTS[slotIndex];
  if (!slot) {
    // Safety: draft defensively.
    const fullHistory: ConversationTurn[] = [
      ...history,
      { role: "user", content: message },
    ];
    const slots = extractSlots(fullHistory);
    return { clarifyingQuestion: null, manifest: buildManifestFromSlots(slots) };
  }

  return { clarifyingQuestion: slot.question, manifest: null };
}

// ── Real LLM brain ────────────────────────────────────────────────────────────

/** Build the system prompt for the real brain, injecting node types + few-shot examples. */
export function buildSystemPrompt(currentManifest?: AgentManifest): string {
  const nodeList = projectAvailableNodeMeta(CONNECTOR_LAB_FLAG, "visible")
    .filter((node) => node.type !== "api.operation")
    .map((n) => `- ${n.type}: ${n.label} (${n.group})`).join("\n");

  const examples = [
    {
      manifestVersion: 1,
      name: "Price Watcher",
      description: "Watches a product page and emails a brief when the price drops.",
      triggers: [{ kind: "paidCall", priceUsdc: 0.02 }],
      steps: [
        { id: "n1", type: "llm", config: { prompt: "Extract price from page" }, after: [] },
        { id: "n2", type: "output", config: {}, after: ["n1"] },
      ],
      meta: { createdBy: "guided" },
    },
    {
      manifestVersion: 1,
      name: "Daily Research Digest",
      description: "Drops a 5-item digest every morning.",
      triggers: [{ kind: "schedule", cron: "0 6 * * *" }],
      steps: [
        { id: "n1", type: "llm", config: { prompt: "Summarize top 5 developments" }, after: [] },
        { id: "n2", type: "output", config: {}, after: ["n1"] },
      ],
      meta: { createdBy: "guided" },
    },
    {
      manifestVersion: 1,
      name: "Lead Qualifier",
      description: "Scores any lead 1–10 with a reason and next step.",
      triggers: [{ kind: "paidCall", priceUsdc: 0.05 }],
      steps: [
        { id: "n1", type: "llm", config: { prompt: "Score this lead 1-10" }, after: [] },
        { id: "n2", type: "output", config: {}, after: ["n1"] },
      ],
      meta: { createdBy: "guided" },
    },
  ];

  return [
    "You are an agent builder assistant for Suede Agent Studio.",
    "Your job: ask ONE clarifying question at a time or produce the final agent manifest.",
    "",
    "Rules:",
    "- Ask at most 4 clarifying questions total across the conversation, then you MUST produce a manifest.",
    "- If you have enough information to build the agent, produce the manifest now.",
    "- The fourth question (if needed) must start with 'Last question.'",
    "- Be concise. Never apologize. Never say 'as an AI'.",
    "- If you need one more detail, say 'I need one more detail.' and ask.",
    "- Always set meta.createdBy to 'guided'.",
    ...(currentManifest
      ? [
          "- You are editing the existing manifest below. Apply only the requested change and preserve every other field exactly.",
          "- Return the complete revised manifest; never replace it with a template or create a second agent.",
        ]
      : []),
    "",
    "Available node types (use ONLY these):",
    nodeList,
    "",
    "Example manifests (follow this exact shape):",
    JSON.stringify(examples, null, 2),
    ...(currentManifest
      ? ["", "Existing manifest to revise:", JSON.stringify(currentManifest, null, 2)]
      : []),
    "",
    "Return JSON with exactly one of:",
    '  { "clarifyingQuestion": "<string>", "manifest": null }',
    '  { "clarifyingQuestion": null, "manifest": <AgentManifest> }',
  ].join("\n");
}

/**
 * Run one turn using the real LLM brain (Vercel AI SDK generateObject).
 * Falls back to runFallbackTurn on any failure.
 */
export async function runRealLlmTurn(
  message: string,
  history: ConversationTurn[],
  currentManifest?: AgentManifest,
  billing?: ModelSpendBilling,
  entitlement?: Extract<ModelSpendEntitlement, { allowed: true }>,
): Promise<GuidedResponse> {
  try {
    const { generateObject } = await import("ai");
    const { createAnthropic } = await import("@ai-sdk/anthropic");

    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const userTurns = userTurnsInHistory(history) + 1;
    const forceManifest = userTurns >= 4;

    const systemPrompt =
      buildSystemPrompt(currentManifest) +
      (forceManifest
        ? "\n\nYou MUST produce a manifest now. Do not ask another question."
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
        manifest: z.unknown().nullable(),
      }),
    });

    // Book the spend before shaping the answer: the tokens were burned
    // whether or not the object parses.
    if (billing && entitlement) {
      await recordModelSpend(billing, entitlement, result.usage?.totalTokens ?? 0, "guided:draft");
    }

    const raw = result.object;

    if (raw.manifest !== null) {
      const parsedManifest = AgentManifestSchema.safeParse(raw.manifest);
      if (!parsedManifest.success) {
        // Fall back to deterministic on manifest parse failure.
        return currentManifest
          ? runFallbackEditTurn(message, currentManifest)
          : runFallbackTurn(message, history);
      }
      return { clarifyingQuestion: null, manifest: parsedManifest.data, brain: "model" };
    }

    if (typeof raw.clarifyingQuestion === "string" && raw.clarifyingQuestion.trim() !== "") {
      return { clarifyingQuestion: raw.clarifyingQuestion, manifest: null, brain: "model" };
    }

    return currentManifest
      ? runFallbackEditTurn(message, currentManifest)
      : runFallbackTurn(message, history);
  } catch {
    return currentManifest
      ? runFallbackEditTurn(message, currentManifest)
      : runFallbackTurn(message, history);
  }
}

/**
 * Main entry point: select the brain.
 *
 * The real brain is a call against the funded model key, so it needs both a
 * configured key AND a workspace entitled to model spend — the platform rule
 * being "has paid at least once" (gateway/model-spend.ts). Without either,
 * Guided degrades to its deterministic interview rather than failing: an
 * unpaid visitor still builds and launches a working agent, they just get the
 * fixed slot questions instead of contextual ones.
 *
 * Passing no `billing` also means no model call — a caller with no billing
 * context must never be able to spend the key by omission.
 *
 * Rate-limiting is enforced at the API route layer, not here.
 */
export async function runGuidedTurn(
  message: string,
  history: ConversationTurn[],
  currentManifest?: AgentManifest,
  billing?: ModelSpendBilling,
): Promise<GuidedResponse> {
  const deterministic = async (): Promise<GuidedResponse> => ({
    ...(currentManifest
      ? await runFallbackEditTurn(message, currentManifest)
      : await runFallbackTurn(message, history)),
    brain: "fallback",
  });

  if (!process.env.ANTHROPIC_API_KEY || !billing) return deterministic();

  const entitlement = await modelSpendEntitlement(billing);
  if (!entitlement.allowed) return deterministic();

  return runRealLlmTurn(message, history, currentManifest, billing, entitlement);
}
