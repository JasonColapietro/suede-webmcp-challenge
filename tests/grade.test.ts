/**
 * Tests for the free agent-grading endpoint that backs the Agentix iOS app's
 * core "Grade" action.
 *
 * Contract: the endpoint ALWAYS returns a valid GradeResult (HTTP 200) for valid
 * input — no provider key required, no payment, no account. A server LLM key
 * enriches the grade; without one (or on any LLM error) it falls back to a
 * deterministic on-server grade. This is the server half of the App Store 2.1
 * fix: the reviewer's core action can never dead-end on a 402/401/5xx.
 *
 * The shape mirrors the Swift `GradeResult` decoder (AgentixCore/Grade.swift):
 * { id, name, pillars{acceleration,traction,appCredibility,teamCredibility,
 *   nichePosition}, momentum: "↑"|"→"|"↓", rationale: {}, antiGamingFlags: [] }.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_GRADE_INPUT,
  MOMENTUM,
  GradeInputError,
  normalizeGradeInput,
  deterministicGrade,
  parseGradeJson,
  resolveGrade,
  type GradeResultDTO,
} from "@/lib/grade";
import { createStubLlm } from "@/lib/llm";
import { POST } from "@/app/api/grade/route";

const PILLAR_KEYS = [
  "acceleration",
  "traction",
  "appCredibility",
  "teamCredibility",
  "nichePosition",
] as const;

/** Assert a value is a wire-valid GradeResult the Swift client can decode. */
function expectValidGrade(g: GradeResultDTO): void {
  expect(typeof g.id).toBe("string");
  expect(g.id.length).toBeGreaterThan(0);
  expect(typeof g.name).toBe("string");
  expect(g.name.length).toBeGreaterThan(0);
  expect(MOMENTUM).toContain(g.momentum);
  for (const k of PILLAR_KEYS) {
    const v = g.pillars[k];
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  }
  expect(typeof g.rationale).toBe("object");
  for (const k of PILLAR_KEYS) {
    const r = (g.rationale as Record<string, unknown>)[k];
    expect(typeof r).toBe("string");
    expect((r as string).length).toBeGreaterThan(0);
  }
  expect(Array.isArray(g.antiGamingFlags)).toBe(true);
}

/** A valid GradeResult JSON string, as a well-behaved LLM would emit. */
function validGradeJson(id = "devin_ai", name = "Devin AI"): string {
  return JSON.stringify({
    id,
    name,
    pillars: {
      acceleration: 88,
      traction: 82,
      appCredibility: 91,
      teamCredibility: 87,
      nichePosition: 79,
    },
    momentum: "↑",
    rationale: {
      acceleration: "Strong week-over-week growth.",
      traction: "High DAU retention across cohorts.",
      appCredibility: "Widely covered in developer press.",
      teamCredibility: "Known founding team with prior exits.",
      nichePosition: "Clear category leader in AI coding tools.",
    },
    antiGamingFlags: [],
  });
}

function makeRequest(body: unknown, ip = `t-${Math.random().toString(36).slice(2)}`): Request {
  return new Request("https://agents.suedeai.ai/api/grade?dryRun=1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Suede-Dry-Run": "1",
      "x-real-ip": ip,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("normalizeGradeInput", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeGradeInput("  Devin AI \n")).toBe("Devin AI");
  });

  it("throws empty for blank input", () => {
    expect(() => normalizeGradeInput("   ")).toThrow(GradeInputError);
    try {
      normalizeGradeInput("");
    } catch (e) {
      expect((e as GradeInputError).kind).toBe("empty");
    }
  });

  it("throws tooLong past the max", () => {
    const long = "x".repeat(MAX_GRADE_INPUT + 1);
    try {
      normalizeGradeInput(long);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GradeInputError);
      expect((e as GradeInputError).kind).toBe("tooLong");
    }
  });

  it("accepts input exactly at the max", () => {
    const atMax = "x".repeat(MAX_GRADE_INPUT);
    expect(normalizeGradeInput(atMax)).toHaveLength(MAX_GRADE_INPUT);
  });
});

describe("deterministicGrade", () => {
  it("is stable for the same input", () => {
    expect(deterministicGrade("Devin AI")).toEqual(deterministicGrade("Devin AI"));
  });

  it("returns a wire-valid grade", () => {
    expectValidGrade(deterministicGrade("@cursor"));
  });

  it("varies across different inputs", () => {
    const a = deterministicGrade("Devin AI");
    const b = deterministicGrade("Some Other Agent");
    expect(a.pillars).not.toEqual(b.pillars);
  });

  it("derives a clean display name from a handle or URL", () => {
    expect(deterministicGrade("@devin_ai").name).not.toContain("@");
    expect(deterministicGrade("https://cursor.com").name).not.toContain("http");
  });
});

describe("parseGradeJson", () => {
  it("parses a clean JSON grade", () => {
    const g = parseGradeJson(validGradeJson(), "fallback");
    expect(g.name).toBe("Devin AI");
    expectValidGrade(g);
  });

  it("strips a ```json fenced code block", () => {
    const g = parseGradeJson("```json\n" + validGradeJson() + "\n```", "fallback");
    expectValidGrade(g);
  });

  it("fills missing rationale and flags, clamps and rounds pillar scores", () => {
    const partial = JSON.stringify({
      id: "x",
      name: "X",
      pillars: {
        acceleration: 120.7, // out of range + fractional
        traction: -5,
        appCredibility: 50.4,
        teamCredibility: 50,
        nichePosition: 50,
      },
      momentum: "→",
    });
    const g = parseGradeJson(partial, "fallback");
    expect(g.pillars.acceleration).toBe(100);
    expect(g.pillars.traction).toBe(0);
    expect(g.pillars.appCredibility).toBe(50);
    expect(g.antiGamingFlags).toEqual([]);
    expectValidGrade(g); // rationale gaps filled with DEMO_RATIONALE default
  });

  it("throws on non-JSON garbage", () => {
    expect(() => parseGradeJson("stub:not json at all", "fallback")).toThrow();
  });

  it("throws when pillars are missing", () => {
    expect(() => parseGradeJson(JSON.stringify({ id: "x", name: "X", momentum: "↑" }), "fb")).toThrow();
  });
});

describe("resolveGrade", () => {
  it("uses the LLM when it returns a valid grade", async () => {
    const llm = createStubLlm(() => validGradeJson("acme", "Acme"));
    const { result, mode } = await resolveGrade("Acme", llm);
    expect(mode).toBe("llm");
    expect(result.name).toBe("Acme");
    expectValidGrade(result);
  });

  it("falls back to deterministic when the LLM throws", async () => {
    const llm = {
      generate: async (): Promise<string> => {
        throw new Error("rate limited");
      },
    };
    const { result, mode } = await resolveGrade("Acme", llm);
    expect(mode).toBe("demo");
    expectValidGrade(result);
    expect(result).toEqual(deterministicGrade("Acme"));
  });

  it("falls back to deterministic when the LLM returns garbage", async () => {
    const llm = createStubLlm((p) => `stub:${p}`);
    const { result, mode } = await resolveGrade("Acme", llm);
    expect(mode).toBe("demo");
    expectValidGrade(result);
  });

  it("falls back to deterministic when no LLM is configured", async () => {
    const { result, mode } = await resolveGrade("Acme", null);
    expect(mode).toBe("demo");
    expect(result).toEqual(deterministicGrade("Acme"));
  });
});

describe("POST /api/grade", () => {
  it("returns 200 with a wire-valid grade for valid input", async () => {
    const res = await POST(makeRequest({ input: "Devin AI", dryRun: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as GradeResultDTO;
    expectValidGrade(body);
  });

  it("accepts a bare handle and never charges or 402s", async () => {
    const res = await POST(makeRequest({ input: "@cursor" }));
    expect(res.status).toBe(200);
  });

  it("rejects blank input with 400", async () => {
    const res = await POST(makeRequest({ input: "   " }));
    expect(res.status).toBe(400);
  });

  it("rejects a missing input field with 400", async () => {
    const res = await POST(makeRequest({ notInput: "x" }));
    expect(res.status).toBe(400);
  });

  it("rejects overlong input with 400", async () => {
    const res = await POST(makeRequest({ input: "x".repeat(MAX_GRADE_INPUT + 1) }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON body with 400", async () => {
    const res = await POST(makeRequest("}{ not json", "bad-json-ip"));
    expect(res.status).toBe(400);
  });
});
