import { z } from "zod";
import type { FlowRepo } from "@/lib/db/repo";
import {
  FlowCallableInterfaceSchema,
  hashCallableInterface,
} from "./subflow-reference";
import type { FlowCallableInterface, SubflowReference } from "./types";

export interface SubflowCandidate {
  readonly flowId: string;
  readonly name: string;
  readonly workbookName: string | null;
  readonly draft: null | {
    readonly interface: FlowCallableInterface;
    readonly interfaceHash: string;
    readonly semanticHash: string;
  };
  readonly latestTypedVersion?: {
    readonly versionId: string;
    readonly versionNumber: number;
    readonly createdAt: number;
    readonly interfaceHash: string;
    readonly contentHash: string;
  };
}

export interface SubflowVersionProjection {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly createdAt: number;
  readonly interface: FlowCallableInterface;
  readonly interfaceHash: string;
  readonly contentHash: string;
}

export interface SubflowDependentProjection {
  readonly flowId: string;
  readonly name: string;
  readonly nodeIds: readonly string[];
}

export interface SubflowResolveProjection {
  readonly reference: SubflowReference;
  readonly interface: FlowCallableInterface;
  readonly interfaceHash: string;
  readonly contentHash?: string;
  readonly dependency?: {
    readonly kind: "flow";
    readonly resourceId: string;
    readonly version: string;
    readonly contentHash: string;
  };
  readonly issues: readonly ("interface-drift" | "content-drift")[];
}

export interface SubflowCandidatePage {
  readonly flows: readonly SubflowCandidate[];
  readonly nextCursor?: string;
  readonly truncated: boolean;
}

export interface SubflowVersionPage {
  readonly versions: readonly SubflowVersionProjection[];
  readonly nextCursor?: string;
  readonly truncated: boolean;
}

export interface SubflowDependentPage {
  readonly dependents: readonly SubflowDependentProjection[];
  readonly nextCursor?: string;
  readonly truncated: boolean;
}

export interface SubflowApiRepository {
  ownsSubflowApiFlow(input: { readonly ownerId: string; readonly flowId: string }): Promise<boolean>;
  listSubflowCandidates(input: {
    readonly ownerId: string;
    readonly parentFlowId: string;
    readonly query: string;
    readonly cursor?: readonly [string, string];
    readonly limit: number;
  }): Promise<{ readonly page: SubflowCandidatePage; readonly last?: readonly [string, string] } | null>;
  listSubflowVersions(input: {
    readonly ownerId: string;
    readonly parentFlowId: string;
    readonly childFlowId: string;
    readonly cursor?: readonly [number, string];
    readonly limit: number;
  }): Promise<{ readonly page: SubflowVersionPage; readonly last?: readonly [number, string] } | null>;
  resolveSubflowReference(input: {
    readonly ownerId: string;
    readonly parentFlowId: string;
    readonly nodeId: string;
    readonly reference: SubflowReference;
  }): Promise<SubflowResolveProjection | null>;
  listSubflowDependents(input: {
    readonly ownerId: string;
    readonly flowId: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{ readonly page: SubflowDependentPage; readonly last?: string } | null>;
}

export class SubflowApiStoreUnavailableError extends Error {
  constructor() {
    super("Subflow API store unavailable");
    this.name = "SubflowApiStoreUnavailableError";
  }
}

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const OpaqueId = z.string().min(1).max(512).refine((value) => utf8Bytes(value) <= 512);
const NodeId = z.string().min(1).max(128).refine((value) => utf8Bytes(value) <= 128);
const PublicName = z.string().min(1).max(200).refine((value) => utf8Bytes(value) <= 200);

function jsonBytesWithin(value: unknown, maximum: number): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") {
      try {
        const encoded = JSON.stringify(current);
        if (encoded === undefined) return false;
        bytes += utf8Bytes(encoded);
      } catch {
        return false;
      }
    } else {
      if (seen.has(current)) return false;
      seen.add(current);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Array.isArray(current)) {
        bytes += 2 + Math.max(0, current.length - 1);
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
          pending.push(descriptor.value);
        }
      } else {
        const entries = Object.entries(descriptors);
        bytes += 2 + Math.max(0, entries.length - 1);
        for (const [key, descriptor] of entries) {
          if (!("value" in descriptor) || !descriptor.enumerable) return false;
          bytes += utf8Bytes(JSON.stringify(key)) + 1;
          pending.push(descriptor.value);
        }
      }
    }
    if (bytes > maximum) return false;
  }
  return bytes <= maximum;
}

function boundedUnknownInterface(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  let root: PropertyDescriptorMap;
  try {
    root = Object.getOwnPropertyDescriptors(value);
  } catch {
    return false;
  }
  const inputs = root.inputs && "value" in root.inputs ? root.inputs.value : undefined;
  const outputs = root.outputs && "value" in root.outputs ? root.outputs.value : undefined;
  if (!Array.isArray(inputs) || !Array.isArray(outputs) || inputs.length > 64 || outputs.length > 64) return false;

  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 4_096 || current.depth > 28) return false;
    if (current.value === null || typeof current.value !== "object") {
      if (typeof current.value === "string") bytes += utf8Bytes(current.value) + 2;
      else bytes += 24;
      if (bytes > 64 * 1024) return false;
      continue;
    }
    if (Object.getOwnPropertySymbols(current.value).length > 0) return false;
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current.value);
    } catch {
      return false;
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(current.value) && key === "length") continue;
      if (!("value" in descriptor) || !descriptor.enumerable) return false;
      bytes += utf8Bytes(key) + 4;
      if (bytes > 64 * 1024) return false;
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }

  const schemaPending: Array<{ value: unknown; depth: number }> = [];
  for (const port of [...inputs, ...outputs]) {
    if (port === null || typeof port !== "object" || Array.isArray(port)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(port, "schema");
    if (!descriptor || !("value" in descriptor)) return false;
    schemaPending.push({ value: descriptor.value, depth: 0 });
  }
  let schemaNodes = 0;
  while (schemaPending.length > 0) {
    const current = schemaPending.pop()!;
    schemaNodes += 1;
    if (schemaNodes > 2_048 || current.depth > 24) return false;
    if (current.value !== null && typeof current.value === "object") {
      const descriptors = Object.getOwnPropertyDescriptors(current.value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(current.value) && key === "length") continue;
        if (!("value" in descriptor) || !descriptor.enumerable) return false;
        schemaPending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

export const BoundedFlowCallableInterfaceSchema = z.unknown().superRefine((value, context) => {
  if (!boundedUnknownInterface(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "interface outside public bounds" });
  }
}).pipe(FlowCallableInterfaceSchema);

export const ApiSubflowReferenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("draft"), flowId: OpaqueId,
    interface: BoundedFlowCallableInterfaceSchema, interfaceHash: Hash,
  }).strict(),
  z.object({
    kind: z.literal("pinned"), flowId: OpaqueId, versionId: OpaqueId,
    interface: BoundedFlowCallableInterfaceSchema, interfaceHash: Hash, contentHash: Hash,
  }).strict(),
]).superRefine((reference, context) => {
  if (hashCallableInterface(reference.interface) !== reference.interfaceHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "interface hash mismatch", path: ["interfaceHash"] });
  }
});

function publicInterfaceWithinBounds(value: FlowCallableInterface): boolean {
  if (value.inputs.length > 64 || value.outputs.length > 64) return false;
  if (!jsonBytesWithin(value, 64 * 1024)) return false;
  const pending: Array<{ value: unknown; depth: number }> = [
    ...value.inputs.map((port) => ({ value: port.schema, depth: 0 })),
    ...value.outputs.map((port) => ({ value: port.schema, depth: 0 })),
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 2_048 || current.depth > 24) return false;
    if (current.value !== null && typeof current.value === "object") {
      for (const nested of Object.values(current.value)) {
        pending.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

function checkInterfaceReceipt(
  value: { readonly interface: FlowCallableInterface; readonly interfaceHash: string },
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (!publicInterfaceWithinBounds(value.interface) ||
      hashCallableInterface(value.interface) !== value.interfaceHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid interface receipt", path });
  }
}
const InterfaceReceipt = z.object({
  interface: BoundedFlowCallableInterfaceSchema,
  interfaceHash: Hash,
  semanticHash: Hash,
}).strict();
const LatestVersion = z.object({
  versionId: OpaqueId, versionNumber: z.number().int().safe().positive(),
  createdAt: z.number().int().safe().nonnegative(),
  interfaceHash: Hash, contentHash: Hash,
}).strict();

export const SubflowCandidatePageSchema = z.object({
  flows: z.array(z.object({
    flowId: OpaqueId, name: PublicName, workbookName: PublicName.nullable(),
    draft: InterfaceReceipt.nullable(), latestTypedVersion: LatestVersion.optional(),
  }).strict()).max(50),
  nextCursor: z.string().min(1).max(2048).optional(),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.nextCursor !== undefined && !value.truncated) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "cursor requires truncation" });
  }
  value.flows.forEach((flow, index) => {
    if (flow.draft) checkInterfaceReceipt(flow.draft, context, ["flows", index, "draft"]);
  });
  if (!jsonBytesWithin(value, 256 * 1024)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "page too large" });
  }
});

export const SubflowVersionPageSchema = z.object({
  versions: z.array(z.object({
    versionId: OpaqueId, versionNumber: z.number().int().safe().positive(),
    createdAt: z.number().int().safe().nonnegative(),
    interface: BoundedFlowCallableInterfaceSchema, interfaceHash: Hash, contentHash: Hash,
  }).strict()).max(20),
  nextCursor: z.string().min(1).max(2048).optional(), truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.nextCursor !== undefined && !value.truncated) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "cursor requires truncation" });
  }
  value.versions.forEach((version, index) =>
    checkInterfaceReceipt(version, context, ["versions", index]));
  if (!jsonBytesWithin(value, 256 * 1024)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "page too large" });
  }
});

export const SubflowDependentPageSchema = z.object({
  dependents: z.array(z.object({
    flowId: OpaqueId, name: PublicName, nodeIds: z.array(NodeId).max(100),
  }).strict()).max(50),
  nextCursor: z.string().min(1).max(2048).optional(), truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.nextCursor !== undefined && !value.truncated) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "cursor requires truncation" });
  }
  if (!jsonBytesWithin(value, 256 * 1024)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "page too large" });
  }
});

export const SubflowResolveRequestSchema = z.object({
  parentFlowId: OpaqueId,
  nodeId: NodeId,
  reference: ApiSubflowReferenceSchema,
}).strict().superRefine((value, context) => {
  if (utf8Bytes(value.reference.flowId) > 512 ||
      (value.reference.kind === "pinned" && utf8Bytes(value.reference.versionId) > 512)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "opaque ID too large", path: ["reference"] });
  }
  if (!publicInterfaceWithinBounds(value.reference.interface)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "interface too large", path: ["reference", "interface"] });
  }
});

export const SubflowResolveProjectionSchema = z.object({
  reference: ApiSubflowReferenceSchema,
  interface: BoundedFlowCallableInterfaceSchema,
  interfaceHash: Hash,
  contentHash: Hash.optional(),
  dependency: z.object({
    kind: z.literal("flow"), resourceId: OpaqueId, version: OpaqueId, contentHash: Hash,
  }).strict().optional(),
  issues: z.array(z.enum(["interface-drift", "content-drift"])).max(2),
}).strict().superRefine((value, context) => {
  const reference = value.reference as SubflowReference;
  if (utf8Bytes(reference.flowId) > 512 ||
      (reference.kind === "pinned" && utf8Bytes(reference.versionId) > 512)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "opaque ID too large", path: ["reference"] });
  }
  checkInterfaceReceipt(value, context, ["interface"]);
  if (
    JSON.stringify(reference.interface) !== JSON.stringify(value.interface) ||
    reference.interfaceHash !== value.interfaceHash
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "reference receipt mismatch" });
  }
  if (reference.kind === "draft") {
    if (value.contentHash !== undefined || value.dependency !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "draft projection contains pin" });
    }
  } else if (
    value.contentHash !== reference.contentHash ||
    value.dependency?.resourceId !== reference.flowId ||
    value.dependency?.version !== reference.versionId ||
    value.dependency?.contentHash !== reference.contentHash
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "pinned projection mismatch" });
  }
  if (!jsonBytesWithin(value, 128 * 1024)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "projection too large" });
  }
});

export function normalizeSubflowQuery(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

export class SubflowApiService {
  private readonly boundary: SubflowApiRepository;

  constructor(repo: FlowRepo) {
    const candidate = repo as FlowRepo & Partial<SubflowApiRepository>;
    if (
      typeof candidate.listSubflowCandidates !== "function" ||
      typeof candidate.ownsSubflowApiFlow !== "function" ||
      typeof candidate.listSubflowVersions !== "function" ||
      typeof candidate.resolveSubflowReference !== "function" ||
      typeof candidate.listSubflowDependents !== "function"
    ) throw new SubflowApiStoreUnavailableError();
    this.boundary = candidate as FlowRepo & SubflowApiRepository;
  }

  owns(input: Parameters<SubflowApiRepository["ownsSubflowApiFlow"]>[0]) {
    return this.boundary.ownsSubflowApiFlow(input);
  }

  candidates(input: Parameters<SubflowApiRepository["listSubflowCandidates"]>[0]) {
    return this.boundary.listSubflowCandidates(input);
  }
  versions(input: Parameters<SubflowApiRepository["listSubflowVersions"]>[0]) {
    return this.boundary.listSubflowVersions(input);
  }
  resolve(input: Parameters<SubflowApiRepository["resolveSubflowReference"]>[0]) {
    return this.boundary.resolveSubflowReference(input);
  }
  dependents(input: Parameters<SubflowApiRepository["listSubflowDependents"]>[0]) {
    return this.boundary.listSubflowDependents(input);
  }
}
