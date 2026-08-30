import { describe, expect, it } from "vitest";
import {
  NODE_DEFINITION_BY_TYPE,
  NODE_DEFINITIONS,
  NODE_GROUP_ORDER,
  NODE_TYPE_SET,
  getNodeDefinition,
} from "../../src/lib/flow/node-definitions";
import { NODE_META } from "../../src/lib/flow/node-meta";
import { LLM_MODEL_TIERS } from "../../src/lib/billing";

const FORBIDDEN_PROPERTY_NAME = /secret|private.?key|service.?role/i;
const FORBIDDEN_STRING_VALUE =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|bearer\s+[a-z0-9._~+/=-]{8,}|(?:service.?role|signing.?secret)\s*[:=]\s*[a-z0-9._~+/=-]{8,}/i;

function expectClientSafe(value: unknown, path = "definition"): void {
  if (typeof value === "string") {
    expect(value, path).not.toMatch(FORBIDDEN_STRING_VALUE);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => expectClientSafe(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      expect(key, `${path}.${key}`).not.toMatch(FORBIDDEN_PROPERTY_NAME);
      expectClientSafe(child, `${path}.${key}`);
    }
  }
}

describe("canonical node definitions", () => {
  it("registers exactly one native Resource Query operation", () => {
    const matches = NODE_DEFINITIONS.filter((definition) => definition.type === "resource.query");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      effects: ["read"],
      testMode: "native",
      retry: "safe",
      cost: { kind: "free" },
    });
  });

  it("enumerates every node type exactly once and remains JSON-safe", () => {
    expect(NODE_DEFINITIONS).toHaveLength(43);
    expect(new Set(NODE_DEFINITIONS.map((item) => item.type)).size).toBe(43);
    expect(Object.keys(NODE_DEFINITION_BY_TYPE).sort()).toEqual(
      NODE_DEFINITIONS.map((item) => item.type).sort(),
    );
    expect(JSON.parse(JSON.stringify(NODE_DEFINITIONS))).toEqual(
      NODE_DEFINITIONS,
    );
    expect(NODE_TYPE_SET).toEqual(
      new Set(NODE_DEFINITIONS.map((item) => item.type)),
    );
    expect(NODE_GROUP_ORDER).toEqual([
      "Triggers",
      "I/O",
      "AI",
      "Logic",
      "Docs & Data",
      "Comms & CRM",
      "Finance & Ops",
      "Dev & Infra",
      "Music & IP",
      "Rails",
    ]);
  });

  it("provides complete, internally consistent client-safe descriptors", () => {
    for (const definition of NODE_DEFINITIONS) {
      expect(definition.definitionVersion, definition.type).toBe(1);
      expect(definition.label.trim(), definition.type).not.toBe("");
      expect(definition.description.trim(), definition.type).not.toBe("");
      expect(definition.ui.icon.trim(), definition.type).not.toBe("");
      expect(
        definition.ui.searchableTerms.length,
        definition.type,
      ).toBeGreaterThan(0);
      expect(
        definition.ui.searchableTerms.every((term) => term.trim().length > 0),
      ).toBe(true);

      expect(new Set(definition.inputPorts.map((port) => port.id)).size).toBe(
        definition.inputPorts.length,
      );
      expect(new Set(definition.outputPorts.map((port) => port.id)).size).toBe(
        definition.outputPorts.length,
      );
      expect(
        new Set(definition.permissions.map((permission) => permission.id)).size,
      ).toBe(definition.permissions.length);
      expect(new Set(definition.effects).size).toBe(definition.effects.length);

      const properties = definition.configSchema.properties;
      expect(
        properties &&
          typeof properties === "object" &&
          !Array.isArray(properties),
      ).toBe(true);
      const propertyKeys = Object.keys(
        properties as Record<string, unknown>,
      ).sort();
      const fieldKeys = definition.ui.fields.map((field) => field.key);
      expect(new Set(fieldKeys).size, `${definition.type} field keys`).toBe(
        fieldKeys.length,
      );
      expect(
        fieldKeys.slice().sort(),
        `${definition.type} config/ui drift`,
      ).toEqual(propertyKeys);
      for (const field of definition.ui.fields) {
        expect(field.key).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
        expect(field.label.trim()).not.toBe("");
        expect(field.hint.trim()).not.toBe("");
      }

      if (definition.cost.amount !== undefined) {
        expect(Number.isFinite(definition.cost.amount), definition.type).toBe(
          true,
        );
        expect(definition.cost.amount, definition.type).toBeGreaterThanOrEqual(
          0,
        );
      }
      expectClientSafe(definition, definition.type);
      expect(getNodeDefinition(definition.type)).toBe(definition);
    }
  });

  it("rejects credential material while allowing benign documentation prose", () => {
    expect(() =>
      expectClientSafe({
        note: "A signing secret is generated for you when you launch this agent.",
      }),
    ).not.toThrow();

    for (const unsafe of [
      { secret: "reference-only" },
      { privateKey: "reference-only" },
      { serviceRole: "reference-only" },
      { note: "-----BEGIN PRIVATE KEY-----" },
      { note: "Authorization: Bearer abcdefghijklmnop" },
      { note: "service-role=eyJhbGciOiJIUzI1NiJ9.payload.signature" },
      { note: "signing-secret=super-sensitive-value" },
    ]) {
      expect(() => expectClientSafe(unsafe)).toThrow();
    }
  });

  it("declares exact connection requirements for external business actions", () => {
    expect(getNodeDefinition("comms.slackMessage").connections).toEqual([{
      key: "connection",
      label: "Slack webhook",
      hint: expect.stringContaining("webhook"),
      field: "webhook",
      required: true,
      allowedKinds: ["custom_headers"],
      requiredHeaderNames: ["x-suede-webhook-url"],
    }]);
    expect(getNodeDefinition("comms.crmWebhook").connections).toEqual([{
      key: "connection",
      label: "CRM webhook",
      hint: expect.stringContaining("webhook"),
      field: "webhook",
      required: true,
      allowedKinds: ["custom_headers"],
      requiredHeaderNames: ["x-suede-webhook-url"],
    }]);
    for (const type of ["devops.githubIssue", "devops.githubWorkflowDispatch"] as const) {
      expect(getNodeDefinition(type).connections).toEqual([{
        key: "connection",
        label: "GitHub token",
        hint: expect.stringContaining("GitHub"),
        field: "headers",
        required: true,
        allowedKinds: ["bearer"],
        requiredHeaderNames: ["authorization"],
      }]);
    }
  });

  it("preserves the current palette contract in its stable order", () => {
    expect(
      NODE_DEFINITIONS.map((definition) => ({
        type: definition.type,
        label: definition.label,
        group: definition.category,
        ...(definition.cost.kind === "estimated"
          ? { priceUsdc: definition.cost.amount }
          : {}),
        inputs: definition.inputPorts.map((port) => port.id),
        outputs: definition.outputPorts.map((port) => port.id),
        fields: definition.ui.fields,
        ...(definition.prototype ? { prototype: definition.prototype } : {}),
      })),
    ).toEqual(
      NODE_META.map((meta) => {
        const { priceUsdc: _priceUsdc, ...rest } = meta;
        const definition = NODE_DEFINITION_BY_TYPE[meta.type];
        return {
          ...rest,
          ...(definition.cost.kind === "estimated"
            ? { priceUsdc: meta.priceUsdc }
            : {}),
          fields: meta.fields,
        };
      }),
    );
  });

  it("offers a cost/speed tier picker for the LLM node's model field", () => {
    const modelField = getNodeDefinition("llm").ui.fields.find(
      (field) => field.key === "model",
    );

    expect(modelField?.kind).toBe("select");

    const options = (modelField?.options ?? []) as readonly {
      value: string;
      label: string;
    }[];
    expect(options[0]).toEqual({ value: "", label: "Use platform default" });
    expect(options.slice(1)).toEqual(
      LLM_MODEL_TIERS.map((tier) => ({
        value: tier.modelId,
        label: `${tier.label} — ~$${tier.blendedPer1MUsdc}/1M tokens`,
      })),
    );
    // Every non-default tier must resolve to a distinct, non-empty model id.
    const tierValues = options.slice(1).map((option) => option.value);
    expect(new Set(tierValues).size).toBe(tierValues.length);
    expect(tierValues.every((value) => value.trim().length > 0)).toBe(true);
  });
});
