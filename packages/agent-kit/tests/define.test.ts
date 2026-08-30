import { describe, it, expect } from "vitest";
import { defineAgent } from "../src/define.js";
import { schedule, paidCall, manual, webhook } from "../src/triggers.js";

const NOOP_RUN = async (): Promise<unknown> => undefined;

describe("defineAgent — validation", () => {
  it("accepts a minimal valid definition", () => {
    const def = defineAgent({
      name: "price-watcher",
      triggers: [paidCall(0.25)],
      run: NOOP_RUN,
    });
    expect(def.name).toBe("price-watcher");
  });

  it("accepts multiple triggers", () => {
    const def = defineAgent({
      name: "multi-trigger",
      triggers: [schedule("0 9 * * *"), paidCall(0.1), manual(), webhook()],
      run: NOOP_RUN,
    });
    expect(def.triggers).toHaveLength(4);
  });

  it("throws on empty name", () => {
    expect(() =>
      defineAgent({ name: "", triggers: [manual()], run: NOOP_RUN }),
    ).toThrow();
  });

  it("throws on empty triggers array", () => {
    expect(() =>
      defineAgent({ name: "foo", triggers: [], run: NOOP_RUN }),
    ).toThrow();
  });

  it("throws on non-string name", () => {
    expect(() =>
       
      defineAgent({ name: 42 as any, triggers: [manual()], run: NOOP_RUN }),
    ).toThrow();
  });
});

describe("defineAgent — frozen return", () => {
  it("returns a frozen object", () => {
    const def = defineAgent({
      name: "test",
      triggers: [manual()],
      run: NOOP_RUN,
    });
    expect(Object.isFrozen(def)).toBe(true);
  });

  it("throws when mutating the frozen object", () => {
    const def = defineAgent({
      name: "test",
      triggers: [manual()],
      run: NOOP_RUN,
    });
    expect(() => {
      // @ts-expect-error intentional mutation attempt
      def.name = "hacked";
    }).toThrow();
  });
});

describe("defineAgent — explicit return type", () => {
  it("preserves description when provided", () => {
    const def = defineAgent({
      name: "with-desc",
      description: "Does something useful.",
      triggers: [paidCall(1)],
      run: NOOP_RUN,
    });
    expect(def.description).toBe("Does something useful.");
  });

  it("description is undefined when omitted", () => {
    const def = defineAgent({
      name: "no-desc",
      triggers: [manual()],
      run: NOOP_RUN,
    });
    expect(def.description).toBeUndefined();
  });
});
