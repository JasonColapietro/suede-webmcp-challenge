import { z } from "zod";
import { parseCron } from "@/lib/cron";
import { DEPENDENCY_KINDS, FLOW_SCHEMA_VERSION } from "@/lib/projects/types";
import { compareDependencyContent } from "@/lib/projects/version-input";
import { FlowGraphV2Schema } from "@/lib/flow/graph-schema";
import type { FlowGraphV2 } from "@/lib/flow/types";
import { assertPortableSubflowDependencies } from "@/lib/projects/subflow-dependencies";
import { assertPortableResourceDependencies } from "@/lib/projects/resource-dependency-contract";
import {
  assertPortableConnectorDependencyReferences,
  MAX_CONNECTOR_BUNDLES,
  type ConnectorDependencyBundleV1,
} from "./connector-bundle-contract";

export const TriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({
    kind: z.literal("schedule"),
    cron: z.string().refine((v) => parseCron(v) !== null, {
      message: "Invalid cron expression — must be a valid five-field UTC cron",
    }),
  }),
  z.object({ kind: z.literal("paidCall"), priceUsdc: z.number().nonnegative() }),
  z.object({ kind: z.literal("webhook") }),
]);

const TriggerV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z
    .object({
      kind: z.literal("schedule"),
      cron: z.string().refine((value) => parseCron(value) !== null, {
        message: "Invalid cron expression — must be a valid five-field UTC cron",
      }),
    })
    .strict(),
  z
    .object({ kind: z.literal("paidCall"), priceUsdc: z.number().nonnegative() })
    .strict(),
  z.object({ kind: z.literal("webhook") }).strict(),
]);

/**
 * An entry in `StepSchema.after`: which upstream step this step depends on,
 * and (optionally) which of that step's output handles it depends on.
 *
 * Shape: `string | { node: string; handle?: string }`. The bare-string form
 * is the original, pre-handle representation (still the default -- a step
 * whose sole output is a single implicit handle, e.g. "result", is written
 * as a plain string with no handle field at all). The object form is only
 * used when the edge left a named, non-default output handle -- e.g. a
 * `branch` node's "true"/"false" outputs or a `loop` node's "errors" output.
 *
 * This keeps the format backward compatible: every manifest persisted
 * before this change has `after: string[]`, which is still exactly
 * `AfterEntry[]` (the union's string arm), so it parses and round-trips
 * identically. Only new manifests with handle-routed edges gain the object
 * form, and only for the specific entries that need it.
 */
export const AfterEntrySchema = z.union([
  z.string().min(1),
  z.object({ node: z.string().min(1), handle: z.string().min(1).optional() }),
]);

export const StepSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().optional(),
  config: z.record(z.unknown()).default({}),
  after: z.array(AfterEntrySchema).default([]),
});

const LowercaseSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const ResourceVersionSchema = z
  .object({
    resourceId: z.string().trim().min(1),
    versionId: z.string().trim().min(1),
    versionNumber: z.number().int().positive(),
    semanticHash: LowercaseSha256Schema,
    fullHash: LowercaseSha256Schema,
  })
  .strict();

export const ManifestDependencyPinSchema = z
  .object({
    kind: z.enum(DEPENDENCY_KINDS),
    resourceId: z.string().trim().min(1),
    version: z.string().trim().min(1),
    contentHash: z.string().trim().min(1).optional(),
  })
  .strict();

const ManifestDependenciesSchema = z
  .array(ManifestDependencyPinSchema)
  .superRefine((dependencies, context) => {
    const seen = new Set<string>();
    for (const dependency of dependencies) {
      const key = JSON.stringify([dependency.kind, dependency.resourceId]);
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate dependency pin: ${dependency.kind}/${dependency.resourceId}`,
        });
      }
      seen.add(key);
    }
  })
  .transform((dependencies) => [...dependencies].sort(compareDependencyContent));

export const ManifestVersionMetadataSchema = z
  .object({
    schemaVersion: z.literal(FLOW_SCHEMA_VERSION).optional(),
    resourceVersion: ResourceVersionSchema.optional(),
    dependencies: ManifestDependenciesSchema.optional(),
  })
  .strict();

export const AgentManifestV1Schema = z
  .object({
    manifestVersion: z.literal(1),
    ...ManifestVersionMetadataSchema.shape,
    name: z.string().min(1),
    description: z.string().default(""),
    triggers: z.array(TriggerSchema).min(1),
    steps: z.array(StepSchema).min(1),
    payoutAddress: z.string().optional(),
    meta: z
      .object({
        template: z.string().optional(),
        createdBy: z.enum(["guided", "studio", "code"]).optional(),
      })
      .partial()
      .default({}),
  })
  .strict();

const ExactFlowGraphV2Schema: z.ZodType<FlowGraphV2, z.ZodTypeDef, unknown> = z
  .unknown()
  .transform((value, context) => {
    const result = FlowGraphV2Schema.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) context.addIssue(issue);
      return z.NEVER;
    }
    return value as FlowGraphV2;
  });

const ManifestV2DependenciesSchema = z
  .array(ManifestDependencyPinSchema)
  .superRefine((dependencies, context) => {
    const seen = new Set<string>();
    for (const dependency of dependencies) {
      const key = JSON.stringify([dependency.kind, dependency.resourceId]);
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate dependency pin: ${dependency.kind}/${dependency.resourceId}`,
        });
      }
      seen.add(key);
    }
  });

const ConnectorBundlesSchema: z.ZodType<
  readonly ConnectorDependencyBundleV1[],
  z.ZodTypeDef,
  unknown
> = z.array(z.unknown()).max(MAX_CONNECTOR_BUNDLES) as z.ZodType<
  readonly ConnectorDependencyBundleV1[], z.ZodTypeDef, unknown
>;

const agentManifestV2ValidationSchema = z
  .object({
    manifestVersion: z.literal(2),
    schemaVersion: z.literal(2),
    resourceVersion: ResourceVersionSchema.optional(),
    dependencies: ManifestV2DependenciesSchema.optional(),
    connectorBundles: ConnectorBundlesSchema.optional(),
    name: z.string().min(1),
    description: z.string(),
    triggers: z.array(TriggerV2Schema).min(1),
    graph: ExactFlowGraphV2Schema,
    payoutAddress: z.string().optional(),
    meta: z
      .object({
        template: z.string().optional(),
        createdBy: z.enum(["guided", "studio", "code"]).optional(),
      })
      .strict()
      .partial(),
  })
  .strict()
  .superRefine((manifest, context) => {
    try {
      assertPortableSubflowDependencies(manifest.graph, manifest.dependencies ?? []);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dependencies"],
        message: error instanceof Error ? error.message : "Invalid portable subflow dependencies",
      });
    }
    try {
      assertPortableResourceDependencies(manifest.graph, manifest.dependencies ?? []);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dependencies"],
        message: error instanceof Error ? error.message : "Invalid portable Resource Pack dependencies",
      });
    }
    try {
      assertPortableConnectorDependencyReferences(manifest.graph, manifest.connectorBundles);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connectorBundles"],
        message: error instanceof Error ? error.message : "Invalid portable connector dependencies",
      });
    }
  });

/** Browser-safe validation for already JSON-decoded transport. Hash authority is server-only. */
export const AgentManifestV2EnvelopeSchema: z.ZodType<
  z.infer<typeof agentManifestV2ValidationSchema>,
  z.ZodTypeDef,
  unknown
> = z.unknown().transform((value, context) => {
  const result = agentManifestV2ValidationSchema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue(issue);
    return z.NEVER;
  }
  return value as z.infer<typeof agentManifestV2ValidationSchema>;
});

/** @deprecated Use AgentManifestV2EnvelopeSchema in clients or PortableAgentManifestV2Schema on servers. */
export const AgentManifestV2Schema = AgentManifestV2EnvelopeSchema;

export type AgentManifestV1 = z.infer<typeof AgentManifestV1Schema>;
export type AgentManifestV2 = z.infer<typeof AgentManifestV2Schema>;
export type SupportedAgentManifest = AgentManifestV1 | AgentManifestV2;

/** Compatibility aliases deliberately remain v1-only. */
export const AgentManifestSchema = AgentManifestV1Schema;
export type AgentManifest = AgentManifestV1;

function manifestVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>).manifestVersion;
}

export function parseSupportedAgentManifest(value: unknown): SupportedAgentManifest {
  const version = manifestVersion(value);
  if (version === 1) return AgentManifestV1Schema.parse(value);
  if (version === 2) return AgentManifestV2Schema.parse(value);
  throw new Error(`Unsupported agent manifestVersion: ${String(version)}`);
}

export const SupportedAgentManifestSchema: z.ZodType<
  SupportedAgentManifest,
  z.ZodTypeDef,
  unknown
> = z.unknown().transform((value, context) => {
  try {
    return parseSupportedAgentManifest(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) context.addIssue(issue);
    } else {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Invalid agent manifest",
      });
    }
    return z.NEVER;
  }
});
export type ManifestTrigger = z.infer<typeof TriggerSchema>;
export type ManifestStep = z.infer<typeof StepSchema>;
export type AfterEntry = z.infer<typeof AfterEntrySchema>;

/** The upstream step id an `after` entry names, regardless of its shape. */
export function afterNodeId(entry: AfterEntry): string {
  return typeof entry === "string" ? entry : entry.node;
}

/**
 * The source handle an `after` entry names, or undefined when it refers to
 * the upstream step's default (single, implicit) output.
 */
export function afterHandle(entry: AfterEntry): string | undefined {
  return typeof entry === "string" ? undefined : entry.handle;
}
export type ManifestResourceVersion = z.infer<typeof ResourceVersionSchema>;
export type ManifestDependencyPin = z.infer<typeof ManifestDependencyPinSchema>;
export type ManifestVersionMetadata = z.infer<typeof ManifestVersionMetadataSchema>;
