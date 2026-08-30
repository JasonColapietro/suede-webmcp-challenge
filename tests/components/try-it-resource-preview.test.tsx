import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  let cursor = 0;
  return {
    begin() { cursor = 0; },
    reset() { slots.splice(0); cursor = 0; },
    state<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [
        slots[index] as T,
        (value: T | ((current: T) => T)) => {
          slots[index] = typeof value === "function"
            ? (value as (current: T) => T)(slots[index] as T)
            : value;
        },
      ] as const;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, useState: hooks.state };
});
vi.mock("@/components/moderation/ReportContentButton", () => ({ default: () => null }));

import TryIt from "@/components/agent/TryIt";

type ElementLike = {
  readonly props?: {
    readonly children?: unknown;
    readonly onClick?: () => void;
  };
};

function findButton(value: unknown, label: string): ElementLike | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const element = value as ElementLike;
  if (element.props?.children === label && element.props.onClick) return element;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return null;
}

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (!value || typeof value !== "object") return "";
  return textContent((value as ElementLike).props?.children);
}

function render() {
  hooks.begin();
  return TryIt({ agentId: "resource-agent", defaultInput: "{ \"tier\": \"paid\" }" });
}

const tick = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

beforeEach(() => {
  hooks.reset();
  vi.restoreAllMocks();
});

describe("public TryIt Resource preview", () => {
  it("requests an explicit dry-run and renders the bounded synthetic response", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      result: [{ name: "Example", tier: "paid" }],
      resourceReceipt: {
        resourceProductId: "resource-1",
        resourceVersion: "pack-1",
        semanticHash: "a".repeat(64),
        freshness: "fresh",
        evidence: [], unknowns: [], conflicts: [], outputSchemaValid: true,
      },
      payment: { priceUsdc: 0, state: "free", receiptId: null },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    findButton(render(), "Run agent →")?.props?.onClick?.();
    await tick();

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/agents/resource-agent/run", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ input: { tier: "paid" }, dryRun: true }),
    }));
    const rendered = textContent(render());
    expect(rendered).toContain("Example");
    expect(rendered).not.toContain("PRIVATE_PACK_CANARY");
  });
});
