import { createHash } from "node:crypto";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import type { DurableExecutionPackage, DurableExecutionGraphIdentity } from "./admission";
import type { DurableJsonValue } from "./types";

export const MAX_INVOCATION_BYTES = 1_572_864;
const MAX_VALUE_DEPTH = 32;
const MAX_ENVELOPE_DEPTH = 36;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_ENTRIES = 25_000;
const MAX_STRING_BYTES = 64 * 1024;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface DurableInvocationV1 {
  readonly schemaVersion: 1;
  readonly execution: Readonly<{ ownerId: string; flowId: string; flowVersionId: string }>;
  readonly policyFingerprint: string;
  readonly rootKey: string;
  readonly triggerInput: Readonly<Record<string, DurableJsonValue>>;
  readonly runVariables: Readonly<Record<string, DurableJsonValue>>;
  readonly graphs: readonly Readonly<{ key: string; identity: DurableExecutionGraphIdentity; contentHash: string; graph: SupportedFlowGraph }>[];
}

type ScanState = { entries: number };

function invalid(): never { throw new Error("Invalid durable invocation"); }

function strictClone(value: unknown, depth: number, ancestors: Set<object>, state: ScanState, maximumDepth: number, maximumStringBytes: number): DurableJsonValue {
  if (depth > maximumDepth) invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : invalid();
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > maximumStringBytes) invalid();
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(value).length !== length + 1) invalid();
      state.entries += length;
      if (state.entries > MAX_ENTRIES) invalid();
      const output: DurableJsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
        output.push(strictClone(descriptor.value, depth + 1, ancestors, state, maximumDepth, maximumStringBytes));
      }
      return Object.freeze(output);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || UNSAFE_KEYS.has(key))) invalid();
    state.entries += keys.length;
    if (state.entries > MAX_ENTRIES) invalid();
    const output: Record<string, DurableJsonValue> = {};
    for (const key of (keys as string[]).sort()) {
      if (Buffer.byteLength(key, "utf8") > MAX_STRING_BYTES) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
      output[key] = strictClone(descriptor.value, depth + 1, ancestors, state, maximumDepth, maximumStringBytes);
    }
    return Object.freeze(output);
  } finally { ancestors.delete(value); }
}

function exactObject(value: DurableJsonValue, keys: readonly string[]): Readonly<Record<string, DurableJsonValue>> {
  if (value === null || Array.isArray(value) || typeof value !== "object") invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
  return value as Readonly<Record<string, DurableJsonValue>>;
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && value.trim() === value && !UNSAFE_KEYS.has(value);
}

function validIdentityId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) && !UNSAFE_KEYS.has(value);
}

function parseIdentity(value: DurableJsonValue): DurableExecutionGraphIdentity {
  if (value === null || Array.isArray(value) || typeof value !== "object") invalid();
  const kind = (value as Record<string, DurableJsonValue>).kind;
  const hash = (candidate: unknown): candidate is string => typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate);
  if (kind === "root") {
    const raw = exactObject(value, ["graphId", "kind"]);
    if (!validIdentityId(raw.graphId)) invalid();
    return Object.freeze({ kind, graphId: raw.graphId });
  }
  if (kind === "legacy") {
    const raw = exactObject(value, ["flowId", "kind"]);
    if (!validIdentityId(raw.flowId)) invalid();
    return Object.freeze({ kind, flowId: raw.flowId });
  }
  if (kind === "draft") {
    const raw = exactObject(value, ["flowId", "interfaceHash", "kind"]);
    if (!validIdentityId(raw.flowId) || !hash(raw.interfaceHash)) invalid();
    return Object.freeze({ kind, flowId: raw.flowId, interfaceHash: raw.interfaceHash });
  }
  if (kind === "pinned") {
    const raw = exactObject(value, ["flowId", "interfaceHash", "kind", "pinnedContentHash", "versionId"]);
    if (!validIdentityId(raw.flowId) || !validIdentityId(raw.versionId) || !hash(raw.interfaceHash) || !hash(raw.pinnedContentHash)) invalid();
    return Object.freeze({ kind, flowId: raw.flowId, versionId: raw.versionId, interfaceHash: raw.interfaceHash, pinnedContentHash: raw.pinnedContentHash });
  }
  invalid();
}

function identityKey(identity: DurableExecutionGraphIdentity): string {
  if (identity.kind === "root") return JSON.stringify(["root", identity.graphId]);
  if (identity.kind === "legacy") return JSON.stringify(["legacy", identity.flowId]);
  if (identity.kind === "draft") return JSON.stringify(["draft", identity.flowId, identity.interfaceHash]);
  return JSON.stringify(["pinned", identity.flowId, identity.versionId, identity.interfaceHash, identity.pinnedContentHash]);
}

export function canonicalDurableJson(value: unknown, maximumBytes = MAX_INVOCATION_BYTES, maximumDepth = MAX_VALUE_DEPTH, maximumStringBytes = MAX_STRING_BYTES): { readonly value: DurableJsonValue; readonly json: string } {
  const cloned = strictClone(value, 0, new Set(), { entries: 0 }, maximumDepth, maximumStringBytes);
  const json = JSON.stringify(cloned);
  if (Buffer.byteLength(json, "utf8") > maximumBytes) invalid();
  return Object.freeze({ value: cloned, json });
}

export function createDurableInvocation(input: {
  readonly executionPackage: DurableExecutionPackage;
  readonly execution: Readonly<{ ownerId: string; flowId: string; flowVersionId: string }>;
  readonly policyFingerprint: string;
  readonly triggerInput?: Readonly<Record<string, unknown>>;
  readonly runVariables?: Readonly<Record<string, unknown>>;
}): { readonly invocation: DurableInvocationV1; readonly json: string; readonly hash: string } {
  const triggerInput = canonicalDurableJson(input.triggerInput ?? {}, MAX_INPUT_BYTES).value;
  const runVariables = canonicalDurableJson(input.runVariables ?? {}, MAX_INPUT_BYTES).value;
  if (input.executionPackage.schemaVersion !== 1 || !validKey(input.executionPackage.rootKey) || input.executionPackage.graphs.length < 1) invalid();
  if (!validIdentityId(input.execution.ownerId) || !validIdentityId(input.execution.flowId) || !validIdentityId(input.execution.flowVersionId) || !/^[a-f0-9]{64}$/u.test(input.policyFingerprint)) invalid();
  const graphs = [...input.executionPackage.graphs]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((entry) => {
      if (entry.canonicalJson !== JSON.stringify(entry.graph) || createHash("sha256").update(entry.canonicalJson, "utf8").digest("hex") !== entry.contentHash) invalid();
      if (identityKey(entry.identity) !== entry.key) invalid();
      return { key: entry.key, identity: entry.identity, contentHash: entry.contentHash, graph: entry.graph };
    });
  if (!graphs.some((entry) => entry.key === input.executionPackage.rootKey && entry.identity.kind === "root")) invalid();
  const canonical = canonicalDurableJson({
    schemaVersion: 1,
    execution: input.execution,
    policyFingerprint: input.policyFingerprint,
    rootKey: input.executionPackage.rootKey,
    triggerInput,
    runVariables,
    graphs,
  }, MAX_INVOCATION_BYTES, MAX_ENVELOPE_DEPTH, 256 * 1024);
  const invocation = parseDurableInvocationJson(canonical.json);
  return Object.freeze({ invocation, json: canonical.json, hash: createHash("sha256").update(canonical.json, "utf8").digest("hex") });
}

export function parseDurableInvocationJson(json: string, expectedHash?: string): DurableInvocationV1 {
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_INVOCATION_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { invalid(); }
  const canonical = canonicalDurableJson(parsed, MAX_INVOCATION_BYTES, MAX_ENVELOPE_DEPTH, 256 * 1024);
  if (canonical.json !== json) invalid();
  if (expectedHash !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(expectedHash) || createHash("sha256").update(json, "utf8").digest("hex") !== expectedHash) invalid();
  }
  const envelope = exactObject(canonical.value, ["execution", "graphs", "policyFingerprint", "rootKey", "runVariables", "schemaVersion", "triggerInput"]);
  if (envelope.schemaVersion !== 1) invalid();
  const execution = exactObject(envelope.execution!, ["flowId", "flowVersionId", "ownerId"]);
  if (!validIdentityId(execution.ownerId) || !validIdentityId(execution.flowId) || !validIdentityId(execution.flowVersionId)) invalid();
  if (typeof envelope.policyFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(envelope.policyFingerprint)) invalid();
  if (!validKey(envelope.rootKey)) invalid();
  const triggerInput = exactObject(envelope.triggerInput!, Object.keys(envelope.triggerInput as object));
  const runVariables = exactObject(envelope.runVariables!, Object.keys(envelope.runVariables as object));
  if (Buffer.byteLength(JSON.stringify(triggerInput), "utf8") > MAX_INPUT_BYTES || Buffer.byteLength(JSON.stringify(runVariables), "utf8") > MAX_INPUT_BYTES) invalid();
  if (!Array.isArray(envelope.graphs) || envelope.graphs.length < 1) invalid();
  const graphValues = envelope.graphs;
  const seen = new Set<string>();
  let rootCount = 0;
  const graphs = graphValues.map((raw, index) => {
    const entry = exactObject(raw, ["contentHash", "graph", "identity", "key"]);
    if (!validKey(entry.key) || seen.has(entry.key)) invalid();
    seen.add(entry.key);
    if (typeof entry.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(entry.contentHash)) invalid();
    if (entry.graph === null || typeof entry.graph !== "object" || Array.isArray(entry.graph)) invalid();
    const identity = parseIdentity(entry.identity!);
    if (identityKey(identity) !== entry.key) invalid();
    if (index > 0 && graphValues[index - 1] !== undefined) {
      const previous = exactObject(graphValues[index - 1]!, ["contentHash", "graph", "identity", "key"]);
      if (typeof previous.key !== "string" || previous.key.localeCompare(entry.key) >= 0) invalid();
    }
    if (identity.kind === "root") rootCount += 1;
    const graphJson = JSON.stringify(entry.graph);
    if (createHash("sha256").update(graphJson, "utf8").digest("hex") !== entry.contentHash) invalid();
    const graphId = (entry.graph as Record<string, DurableJsonValue>).id;
    if (identity.kind === "root" && graphId !== identity.graphId) invalid();
    return Object.freeze({ key: entry.key, identity, contentHash: entry.contentHash, graph: entry.graph as unknown as SupportedFlowGraph });
  });
  if (rootCount !== 1 || !graphs.some((entry) => entry.key === envelope.rootKey && entry.identity.kind === "root")) invalid();
  return Object.freeze({ schemaVersion: 1, execution: Object.freeze({ ownerId: execution.ownerId, flowId: execution.flowId, flowVersionId: execution.flowVersionId }), policyFingerprint: envelope.policyFingerprint, rootKey: envelope.rootKey, triggerInput, runVariables, graphs: Object.freeze(graphs) });
}
