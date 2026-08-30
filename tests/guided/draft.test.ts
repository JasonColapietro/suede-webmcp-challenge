import { describe, it, expect } from "vitest";
import {
  runFallbackTurn,
  runFallbackEditTurn,
  type ConversationTurn,
  type GuidedResponse,
} from "@/lib/guided/draft";

// Helper: simulate N turns of conversation with the fallback brain.
// On turn 1, message is the user's initial prompt.
// Subsequent turns are answers to clarifying questions.
async function simulate(messages: string[]): Promise<GuidedResponse[]> {
  const history: ConversationTurn[] = [];
  const responses: GuidedResponse[] = [];

  for (const message of messages) {
    const res = await runFallbackTurn(message, history);
    responses.push(res);
    history.push({ role: "user", content: message });
    if (res.clarifyingQuestion !== null) {
      history.push({ role: "assistant", content: res.clarifyingQuestion });
    }
  }
  return responses;
}

describe("runFallbackTurn — initial prompt matching", () => {
  it("returns a valid response (question or manifest) for a price-watching prompt", async () => {
    const res = await runFallbackTurn(
      "watch a product page and email me when the price drops",
      [],
    );
    expect(res.clarifyingQuestion !== null || res.manifest !== null).toBe(true);
    // Exactly one must be non-null (XOR).
    expect((res.clarifyingQuestion === null) !== (res.manifest === null)).toBe(true);
  });

  it("a general business prompt returns a valid response", async () => {
    const res = await runFallbackTurn("qualify my leads", []);
    expect(res.clarifyingQuestion !== null || res.manifest !== null).toBe(true);
  });

  it("a creator prompt returns a valid response", async () => {
    const res = await runFallbackTurn("generate a song and register my IP", []);
    expect(res.clarifyingQuestion !== null || res.manifest !== null).toBe(true);
  });

  it("an unrecognised prompt still returns a valid response (no crash)", async () => {
    const res = await runFallbackTurn("totally unrecognizable xyzzy input", []);
    expect(res.clarifyingQuestion !== null || res.manifest !== null).toBe(true);
  });
});

describe("runFallbackTurn — interview slot walking", () => {
  it("returns a clarifying question on the first turn", async () => {
    const res = await runFallbackTurn("I want to track prices", []);
    expect(typeof res.clarifyingQuestion).toBe("string");
    expect(res.manifest).toBeNull();
  });

  it("produces a manifest by the 4th user turn (max 4 question limit)", async () => {
    const responses = await simulate([
      "watch product pages and alert me",
      "Daily price drop alert",
      "every morning",
      "0",
    ]);
    const afterFour = responses[3];
    expect(afterFour).toBeDefined();
    expect(afterFour!.manifest).not.toBeNull();
    expect(afterFour!.clarifyingQuestion).toBeNull();
  });

  it("manifest returned at draft time is a valid AgentManifest", async () => {
    const responses = await simulate([
      "watch product pages and alert me",
      "Price Drop Alerter",
      "daily at 9am",
      "0.05",
    ]);
    const withManifest = responses.find((r) => r.manifest !== null);
    expect(withManifest).toBeDefined();
    const m = withManifest!.manifest!;
    expect(m.manifestVersion).toBe(1);
    expect(m.name.length).toBeGreaterThan(0);
    expect(m.triggers.length).toBeGreaterThan(0);
    expect(m.steps.length).toBeGreaterThan(0);
    expect(m.meta.createdBy).toBe("guided");
  });

  it("GuidedResponse: exactly one of clarifyingQuestion or manifest is non-null at every turn", async () => {
    const history: ConversationTurn[] = [];
    for (let i = 0; i < 5; i++) {
      const msg = i === 0 ? "daily research digest" : "yes";
      const res = await runFallbackTurn(msg, history);
      const questionSet = res.clarifyingQuestion !== null;
      const manifestSet = res.manifest !== null;
      // XOR — exactly one must be true
      expect(questionSet !== manifestSet).toBe(true);
      history.push({ role: "user", content: msg });
      if (questionSet) history.push({ role: "assistant", content: res.clarifyingQuestion! });
      if (manifestSet) break;
    }
  });
});

describe("runFallbackTurn — fourth question prefix", () => {
  it("3rd question starts with 'Last question.'", async () => {
    const responses = await simulate([
      "watch site uptime",
      "Site Health Monitor",
      "every 30 minutes",
    ]);
    // After 3 user turns, if we still got a question, it should be the last one.
    const questions = responses.filter((r) => r.clarifyingQuestion !== null);
    // There should be at most 3 questions (slots), and if the 3rd question exists it's last.
    if (questions.length >= 3) {
      const lastQ = questions[questions.length - 1]!.clarifyingQuestion!;
      expect(lastQ).toMatch(/^Last question\./);
    }
  });
});

describe("runFallbackTurn — schedule vs paidCall triggers", () => {
  it("'every morning' cadence produces a schedule trigger", async () => {
    const responses = await simulate([
      "watch a product page",
      "Morning Watcher",
      "every morning",
      "0",
    ]);
    const m = responses.find((r) => r.manifest !== null)!.manifest!;
    const hasSched = m.triggers.some((t) => t.kind === "schedule");
    expect(hasSched).toBe(true);
  });

  it("'on demand' cadence produces a paidCall trigger", async () => {
    const responses = await simulate([
      "qualify leads",
      "Lead Scorer",
      "on demand",
      "0.05",
    ]);
    const m = responses.find((r) => r.manifest !== null)!.manifest!;
    const hasPaid = m.triggers.some((t) => t.kind === "paidCall");
    expect(hasPaid).toBe(true);
  });
});

describe("runFallbackEditTurn — existing agent", () => {
  it("updates requested price and schedule without replacing the agent or its steps", async () => {
    const existing = {
      manifestVersion: 1 as const,
      name: "Existing employee",
      description: "Keeps the exact existing job.",
      triggers: [
        { kind: "paidCall" as const, priceUsdc: 0.25 },
        { kind: "schedule" as const, cron: "0 8 * * *" },
      ],
      steps: [
        { id: "input", type: "input", config: {}, after: [] },
        { id: "work", type: "llm", config: { prompt: "Keep me" }, after: ["input"] },
      ],
      meta: { createdBy: "studio" as const },
    };

    const response = await runFallbackEditTurn(
      "Set the price to 0.75 and schedule daily in the morning",
      existing,
    );

    expect(response.clarifyingQuestion).toBeNull();
    expect(response.manifest?.name).toBe(existing.name);
    expect(response.manifest?.description).toBe(existing.description);
    expect(response.manifest?.steps).toEqual(existing.steps);
    expect(response.manifest?.triggers).toEqual([
      { kind: "paidCall", priceUsdc: 0.75 },
      { kind: "schedule", cron: "0 9 * * *" },
    ]);
    expect(response.manifest?.meta.createdBy).toBe("guided");
  });
});
