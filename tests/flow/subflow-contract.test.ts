import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  FlowCallableInterfaceSchema,
  SubflowReferenceSchema,
  assertCallableOutputLineageSafe,
  assertSubflowReferenceReceipt,
  hashCallableInterface,
  materializeCallableInputs,
  normalizeSubflowReference,
  projectCallableOutputs,
  readJsonPointer,
  sha256Utf8,
  subflowRecursionIdentity,
} from "@/lib/flow/subflow-reference";
import { loopParamsSchema } from "@/lib/flow/nodes/loop";
import { subflowParamsSchema } from "@/lib/flow/nodes/subflow";
import type { FlowCallableInterface, FlowGraphV2, SubflowReference } from "@/lib/flow/types";

const callable: FlowCallableInterface = {
  inputs: [
    {
      id: "prompt",
      label: "Prompt",
      schema: { type: "string" },
      required: true,
      cardinality: "one",
      target: { kind: "trigger", path: "/request/prompt" },
    },
    {
      id: "tags",
      label: "Tags",
      schema: { type: "array", items: { type: "string" } },
      required: false,
      cardinality: "many",
      target: { kind: "trigger", path: "/request/tags" },
    },
  ],
  outputs: [
    {
      id: "answer",
      label: "Answer",
      schema: { type: "string" },
      required: true,
      cardinality: "one",
      source: { nodeId: "output", portId: "result", path: "/answer" },
    },
  ],
};

function v2Graph(overrides: Partial<FlowGraphV2> = {}): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "child-graph",
    name: "Child",
    nodes: [
      { id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
      { id: "output", type: "output", params: {}, bindings: {}, position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: "edge", source: "input", sourceHandle: "result", target: "output", targetHandle: "in" },
    ],
    variables: [],
    groups: [],
    annotations: [],
    callableInterface: callable,
    ...overrides,
  };
}

function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

describe("strict callable interface contract", () => {
  it("accepts stable unique port ids and refuses duplicates or unsafe ids", () => {
    expect(FlowCallableInterfaceSchema.parse(callable)).toEqual(callable);
    expect(() => FlowCallableInterfaceSchema.parse({
      ...callable,
      outputs: [callable.outputs[0], { ...callable.outputs[0], label: "Duplicate" }],
    })).toThrow(/unique/i);
    expect(() => FlowCallableInterfaceSchema.parse({
      ...callable,
      inputs: [{ ...callable.inputs[0], id: "not stable" }],
    })).toThrow(/id/i);
    expect(() => FlowCallableInterfaceSchema.parse({
      ...callable,
      inputs: [{ ...callable.inputs[0], id: "__proto__" }],
    })).toThrow(/unsafe|prototype/i);
  });

  it.each(["request", "/bad~2escape", "/items/-", "/__proto__/value", "/constructor/value"])(
    "refuses non-canonical or unsafe JSON Pointer %j",
    (path) => {
      expect(() => FlowCallableInterfaceSchema.parse({
        ...callable,
        inputs: [{ ...callable.inputs[0], target: { kind: "trigger", path } }],
      })).toThrow(/pointer|path|unsafe/i);
    },
  );

  it("reads own properties only and enforces canonical array indexes", () => {
    const inherited = Object.create({ secret: "leak" }) as Record<string, unknown>;
    expect(readJsonPointer({ safe: [{ value: "ok" }] }, "/safe/0/value")).toBe("ok");
    expect(() => readJsonPointer(inherited, "/secret")).toThrow(/missing|plain/i);
    expect(() => readJsonPointer({ safe: [{ value: "ok" }] }, "/safe/00/value")).toThrow(/canonical/i);
  });

  it("refuses pointer accessors without invoking them", () => {
    let getterCalls = 0;
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "unsafe", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "leak";
      },
    });
    expect(() => readJsonPointer(value, "/unsafe")).toThrow(/accessor/i);
    const inputValues = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(inputValues, "prompt", Object.getOwnPropertyDescriptor(value, "unsafe")!);
    expect(() => materializeCallableInputs(callable, inputValues)).toThrow(/accessor/i);
    const nodeOutputs = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nodeOutputs, "output", Object.getOwnPropertyDescriptor(value, "unsafe")!);
    expect(() => projectCallableOutputs(callable, nodeOutputs)).toThrow(/accessor/i);
    expect(getterCalls).toBe(0);
  });

  it("materializes cloned inputs into null-prototype objects", () => {
    const tags = ["one", "two"];
    const result = materializeCallableInputs(callable, { prompt: "hello", tags });
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.getPrototypeOf((result as Record<string, unknown>).request as object)).toBeNull();
    expect(result).toEqual({ request: { prompt: "hello", tags } });
    tags.push("mutated");
    expect(result).toEqual({ request: { prompt: "hello", tags: ["one", "two"] } });
  });

  it("strictly clones JSON without invoking behavior or coercing unsupported values", () => {
    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "leak";
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const withSymbolKey = { safe: true } as Record<PropertyKey, unknown>;
    withSymbolKey[Symbol("hidden")] = "no";
    const invalid = [
      accessor,
      { toJSON: () => "coerced" },
      new Date(0),
      new Map([["key", "value"]]),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      cyclic,
      withSymbolKey,
      { value: Symbol("value") },
      { value: undefined },
      [undefined],
    ];

    for (const value of invalid) {
      expect(() => materializeCallableInputs(callable, { prompt: value })).toThrow(/json|accessor|symbol|finite|cycle|plain|undefined|tojson/i);
    }
    expect(getterCalls).toBe(0);

    const nested = materializeCallableInputs(callable, { prompt: { deep: { value: "safe" } } }) as Record<string, unknown>;
    const prompt = ((nested.request as Record<string, unknown>).prompt as Record<string, unknown>);
    expect(Object.getPrototypeOf(prompt)).toBeNull();
    expect(Object.getPrototypeOf(prompt.deep as object)).toBeNull();
  });

  it("refuses target collisions, missing required inputs, and cardinality mismatches", () => {
    expect(() => materializeCallableInputs(callable, {})).toThrow(/required.*prompt/i);
    expect(() => materializeCallableInputs(callable, { prompt: "hello", tags: "not-array" })).toThrow(/cardinality|array/i);
    expect(() => materializeCallableInputs({
      ...callable,
      inputs: [
        callable.inputs[0],
        { ...callable.inputs[1], target: { kind: "trigger", path: "/request" } },
      ],
    }, { prompt: "hello", tags: ["one"] })).toThrow(/collision/i);
  });

  it("projects declared outputs and enforces required/cardinality semantics", () => {
    const outputs = Object.assign(Object.create(null), {
      output: Object.assign(Object.create(null), { result: { answer: "done", hidden: "no" } }),
    });
    expect(projectCallableOutputs(callable, outputs)).toEqual({ answer: "done" });
    expect(Object.getPrototypeOf(projectCallableOutputs(callable, outputs))).toBeNull();
    expect(() => projectCallableOutputs(callable, {})).toThrow(/required.*answer/i);
    expect(() => projectCallableOutputs({
      ...callable,
      outputs: [{ ...callable.outputs[0], cardinality: "many" }],
    }, outputs)).toThrow(/cardinality|array/i);
  });

  it("hashes only canonical interface content with deterministic key ordering", () => {
    const reordered = {
      outputs: callable.outputs.map((port) => ({
        source: { portId: port.source.portId, path: port.source.path, nodeId: port.source.nodeId },
        cardinality: port.cardinality,
        required: port.required,
        schema: { type: "string" },
        label: port.label,
        id: port.id,
      })),
      inputs: callable.inputs.map((port) => ({
        target: { path: port.target.path, kind: "trigger" as const },
        cardinality: port.cardinality,
        required: port.required,
        schema: port.schema,
        label: port.label,
        id: port.id,
      })),
    } satisfies FlowCallableInterface;
    expect(hashCallableInterface(reordered)).toBe(hashCallableInterface(callable));
    expect(hashCallableInterface({ ...callable, outputs: [{ ...callable.outputs[0], label: "Changed" }] })).not.toBe(hashCallableInterface(callable));
    expect(hashCallableInterface(callable)).toMatch(/^[a-f0-9]{64}$/);
    const canonicalBytes = canonicalJson(callable);
    expect(hashCallableInterface(callable)).toBe(createHash("sha256").update(canonicalBytes).digest("hex"));
  });

  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["é", "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c"],
    ["e\u0301", "bf12767b0f2a56b2190075bae8169f656e3ce8d6357d4aff184bc6c7ea48f9f6"],
    ["😀", "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9"],
  ])("matches the fixed UTF-8 SHA-256 vector for %j", (text, digest) => {
    expect(sha256Utf8(text)).toBe(digest);
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "refuses the adversarial schema key %s instead of silently erasing it",
    (key) => {
      const schema = Object.create(null) as Record<string, unknown>;
      schema[key] = { type: "string" };
      expect(() => FlowCallableInterfaceSchema.parse({
        ...callable,
        inputs: [{ ...callable.inputs[0], schema }],
      })).toThrow(/unsafe|prototype|constructor/i);
    },
  );
});

describe("strict subflow references", () => {
  const interfaceHash = hashCallableInterface(callable);
  const draft: SubflowReference = { kind: "draft", flowId: "flow:opaque/@id", interface: callable, interfaceHash };
  const pinned: SubflowReference = {
    kind: "pinned",
    flowId: "flow:opaque/@id",
    versionId: "version:opaque/@id",
    interface: callable,
    interfaceHash,
    contentHash: "b".repeat(64),
  };

  it("accepts strict draft and pinned receipts with authoritative flow identity", () => {
    expect(SubflowReferenceSchema.parse(draft)).toEqual(draft);
    expect(SubflowReferenceSchema.parse(pinned)).toEqual(pinned);
    expect(subflowRecursionIdentity(draft)).toBe(draft.flowId);
    expect(subflowRecursionIdentity(pinned)).toBe(draft.flowId);
  });

  it("refuses malformed hashes and unknown receipt fields", () => {
    expect(() => SubflowReferenceSchema.parse({ ...draft, interfaceHash: "nope" })).toThrow(/hash/i);
    expect(() => SubflowReferenceSchema.parse({ ...pinned, extra: true })).toThrow();
  });

  it("fails closed when resolved interface or pinned content receipts drift", () => {
    expect(() => assertSubflowReferenceReceipt(draft, {
      interfaceHash: "c".repeat(64),
    })).toThrow(/interface.*hash/i);
    expect(() => assertSubflowReferenceReceipt(pinned, {
      interfaceHash,
      contentHash: "c".repeat(64),
    })).toThrow(/content.*hash/i);
    expect(() => assertSubflowReferenceReceipt(pinned, { interfaceHash, contentHash: pinned.contentHash })).not.toThrow();
  });

  it("normalizes typed or legacy params without mutation and refuses mixed envelopes", () => {
    const legacy = { flowId: "legacy-child", keep: { unknown: true } };
    const typed = { reference: pinned, keep: { unknown: true } };
    expect(normalizeSubflowReference(legacy)).toEqual({ kind: "legacy", flowId: "legacy-child" });
    expect(normalizeSubflowReference(typed)).toEqual({ kind: "typed", reference: pinned });
    expect(legacy).toEqual({ flowId: "legacy-child", keep: { unknown: true } });
    expect(typed).toEqual({ reference: pinned, keep: { unknown: true } });
    expect(() => normalizeSubflowReference({ flowId: "legacy-child", reference: draft })).toThrow(/mixed|both/i);
    expect(() => normalizeSubflowReference({})).toThrow(/flowId|reference/i);
  });

  it("keeps legacy node params accepted unchanged", () => {
    expect(subflowParamsSchema.parse({ flowId: "legacy-child" })).toMatchObject({ flowId: "legacy-child" });
    expect(loopParamsSchema.parse({ flowId: "legacy-child", concurrency: 2 })).toMatchObject({ flowId: "legacy-child", concurrency: 2 });
    expect(subflowParamsSchema.parse({ flowId: "legacy-child", oldUnknown: "preserved-at-rest" })).toEqual({ flowId: "legacy-child" });
    expect(loopParamsSchema.parse({ flowId: "legacy-child", oldUnknown: "preserved-at-rest" })).toEqual({ flowId: "legacy-child" });
    expect(subflowParamsSchema.safeParse({ reference: draft, extra: true }).success).toBe(false);
    expect(loopParamsSchema.safeParse({ reference: draft, itemsPath: "legacy.path" }).success).toBe(false);
  });
});

describe("callable output lineage", () => {
  it("refuses direct and transitive secret or sensitive-variable lineage", () => {
    const directSecret = v2Graph({
      nodes: v2Graph().nodes.map((node) => node.id === "output"
        ? { ...node, bindings: { token: { kind: "secret", connectionId: "connection", field: "token" } } }
        : node),
    });
    expect(() => assertCallableOutputLineageSafe(directSecret, callable)).toThrow(/secret/i);

    const sensitive = v2Graph({
      variables: [{ id: "sensitive", name: "Sensitive", scope: "run", schema: {}, sensitive: true }],
      nodes: v2Graph().nodes.map((node) => node.id === "input"
        ? { ...node, bindings: { value: { kind: "variable", variableId: "sensitive" } } }
        : node),
    });
    expect(() => assertCallableOutputLineageSafe(sensitive, callable)).toThrow(/sensitive/i);
    expect(() => assertCallableOutputLineageSafe(v2Graph(), callable)).not.toThrow();
  });
});
