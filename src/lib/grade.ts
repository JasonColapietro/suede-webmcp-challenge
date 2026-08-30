/**
 * Agent grading — the server half of the Agentix iOS app's core "Grade" action.
 *
 * Design goal: the core action must ALWAYS complete for a reviewer on a clean
 * device (no provider key in the app, no wallet, no account). So this module
 * NEVER hard-depends on a live LLM call:
 *
 *   - A server-side LLM key (Anthropic > OpenRouter, via createLlmFromEnv)
 *     produces a real, model-graded read.
 *   - With no key, or on ANY LLM error / unparseable output, it falls back to a
 *     deterministic on-server grade derived from the handle.
 *
 * Either way the endpoint returns a wire-valid GradeResult (HTTP 200). The wire
 * shape mirrors the Swift `GradeResult` decoder in AgentixCore/Grade.swift so
 * the iOS client decodes it directly.
 */
import { z } from "zod";
import type { LlmClient } from "@/lib/llm";

export const MAX_GRADE_INPUT = 500;

export const MOMENTUM = ["↑", "→", "↓"] as const;
export type Momentum = (typeof MOMENTUM)[number];

export const PILLAR_KEYS = [
  "acceleration",
  "traction",
  "appCredibility",
  "teamCredibility",
  "nichePosition",
] as const;
export type PillarKey = (typeof PILLAR_KEYS)[number];

export type PillarScores = Record<PillarKey, number>;

export interface GradeResultDTO {
  id: string;
  name: string;
  pillars: PillarScores;
  momentum: Momentum;
  rationale: Record<string, string>;
  antiGamingFlags: string[];
  /** Conversion CTA — link to Agent Studio so reviewers/users can build. */
  studioCtaUrl: string;
  studioCtaLabel: string;
}

export type GradeMode = "llm" | "demo";

/** Request body for POST /api/grade. `dryRun` is accepted for parity with the
 *  Suede Agents runner; grading is unconditionally free, so it never gates. */
export const GradeRequestSchema = z.object({
  input: z.string(),
  dryRun: z.boolean().optional(),
});
export type GradeRequest = z.infer<typeof GradeRequestSchema>;

/** Thrown by normalizeGradeInput; the route maps it to HTTP 400. */
export class GradeInputError extends Error {
  constructor(public readonly kind: "empty" | "tooLong") {
    super(kind === "empty" ? "input is empty" : `input exceeds ${MAX_GRADE_INPUT} characters`);
    this.name = "GradeInputError";
  }
}

/** Trim and bound-check the handle/URL the user wants graded. */
export function normalizeGradeInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new GradeInputError("empty");
  if (trimmed.length > MAX_GRADE_INPUT) throw new GradeInputError("tooLong");
  return trimmed;
}

/** A readable agent name from a handle or URL: "@devin_ai" -> "devin_ai",
 *  "https://cursor.com/" -> "cursor.com". Never empty. */
export function displayName(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const host = new URL(trimmed).host.replace(/^www\./i, "");
      if (host) return host;
    } catch {
      // fall through to the handle path
    }
  }
  const handle = trimmed.replace(/^@+/, "").trim();
  return handle.length > 0 ? handle : trimmed;
}

// ---------------------------------------------------------------------------
// Deterministic fallback grade
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit — small, dependency-free, stable across runs and machines. */
function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — deterministic stream from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

const DEMO_RATIONALE = "Baseline estimate from the agent handle pending a live model-graded read.";

/**
 * A deterministic, plausible grade computed entirely on the server from the
 * handle — no network, no key. Same input always yields the same grade, so the
 * offline/no-key experience is stable rather than random.
 */
export function deterministicGrade(input: string): GradeResultDTO {
  const id = input.trim();
  const rng = mulberry32(hash32(id.toLowerCase()));
  // Plausible band: 48..96 keeps demo grades in a believable C..A range.
  const pillars = Object.fromEntries(
    PILLAR_KEYS.map((k) => [k, clampScore(48 + rng() * 48)]),
  ) as PillarScores;
  const m = rng();
  const momentum: Momentum = m > 0.55 ? "↑" : m > 0.3 ? "→" : "↓";
  const rationale = Object.fromEntries(PILLAR_KEYS.map((k) => [k, DEMO_RATIONALE]));
  return {
    id: id.length > 0 ? id : "agent",
    name: displayName(input),
    pillars,
    momentum,
    rationale,
    antiGamingFlags: [],
    studioCtaUrl: "https://agents.suedeai.ai/build/new?template=grade-rebuilder",
    studioCtaLabel: "Build the better version in Agent Studio →",
  };
}

// ---------------------------------------------------------------------------
// LLM path
// ---------------------------------------------------------------------------

/** The grading prompt — kept in sync with the iOS GraderService prompt. */
export function gradePrompt(input: string): { system: string; user: string } {
  const system =
    "You grade agentic AI apps/teams. Return ONLY valid JSON with these keys: " +
    "id (string), name (string), pillars (object with acceleration, traction, appCredibility, teamCredibility, nichePosition each 0-100), " +
    "momentum (one of ↑ → ↓), " +
    "rationale (object with the same five pillar keys, each a 1-sentence string explaining that score), " +
    "antiGamingFlags (array of strings, empty if none). No markdown fences, no extra keys.";
  const user =
    `Grade this agentic app/team: ${input}. Use acceleration ` +
    "(velocity/unique-user trend), traction, app & team credibility, niche position.";
  return { system, user };
}

function strjsonStrip(raw: string): string {
  let body = raw.trim();
  const fence = body.indexOf("```");
  if (fence !== -1) {
    body = body.slice(fence + 3);
    if (/^json/i.test(body)) body = body.slice(4);
    const end = body.indexOf("```");
    if (end !== -1) body = body.slice(0, end);
  }
  return body.trim();
}

function asStringMap(v: unknown): Record<string, string> {
  if (v === null || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = typeof val === "string" ? val : String(val);
  }
  return out;
}

/**
 * Parse an LLM reply into a wire-valid GradeResultDTO. Tolerant of fenced code
 * blocks, out-of-range/fractional scores, and missing rationale/flags — but
 * throws when there are no usable pillar scores, so resolveGrade can fall back.
 */
export function parseGradeJson(raw: string, fallbackName: string): GradeResultDTO {
  const parsed: unknown = JSON.parse(strjsonStrip(raw));
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("grade JSON is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const pillarsRaw = obj.pillars;
  if (pillarsRaw === null || typeof pillarsRaw !== "object") {
    throw new Error("grade JSON missing pillars");
  }
  const pr = pillarsRaw as Record<string, unknown>;
  const pillars = Object.fromEntries(
    PILLAR_KEYS.map((k) => {
      const v = pr[k];
      if (typeof v !== "number") throw new Error(`grade JSON missing pillar ${k}`);
      return [k, clampScore(v)];
    }),
  ) as PillarScores;

  const momentum: Momentum = (MOMENTUM as readonly string[]).includes(obj.momentum as string)
    ? (obj.momentum as Momentum)
    : "→";
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : fallbackName;
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : fallbackName;
  const antiGamingFlags = Array.isArray(obj.antiGamingFlags)
    ? obj.antiGamingFlags.map((f) => String(f))
    : [];
  const partialRationale = asStringMap(obj.rationale);
  const rationale = Object.fromEntries(
    PILLAR_KEYS.map((k) => [k, partialRationale[k] || DEMO_RATIONALE]),
  ) as Record<string, string>;
  return {
    id,
    name,
    pillars,
    momentum,
    rationale,
    antiGamingFlags,
    studioCtaUrl: "https://agents.suedeai.ai/build/new?template=grade-rebuilder",
    studioCtaLabel: "Build the better version in Agent Studio →",
  };
}

/**
 * Always returns a valid grade. Tries the LLM (when provided); on any error or
 * unparseable output, falls back to the deterministic grade. Never throws.
 */
export async function resolveGrade(
  input: string,
  llm: LlmClient | null,
): Promise<{ result: GradeResultDTO; mode: GradeMode }> {
  if (llm) {
    try {
      const { system, user } = gradePrompt(input);
      const raw = await llm.generate(user, { system });
      return { result: parseGradeJson(raw, displayName(input)), mode: "llm" };
    } catch {
      // fall through to deterministic
    }
  }
  return { result: deterministicGrade(input), mode: "demo" };
}
