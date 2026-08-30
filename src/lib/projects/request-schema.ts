import { z } from "zod";
import { DEPENDENCY_KINDS } from "./types";
import { SupportedFlowGraphSchema } from "@/lib/flow/graph-schema";

const RequiredText = z.string().trim().min(1).max(512);
const TabId = z.string().trim().min(1).max(512);

const DependencyPinInputSchema = z
  .object({
    kind: z.enum(DEPENDENCY_KINDS),
    resourceId: RequiredText,
    version: RequiredText,
    contentHash: RequiredText.optional(),
  })
  .strict();

export const CreateFlowVersionRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(2_000).optional(),
    dependencies: z.array(DependencyPinInputSchema).max(1_000).optional(),
    graph: SupportedFlowGraphSchema.optional(),
    impactReceipt: z.string().min(32).max(256).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.impactReceipt !== undefined && value.graph === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["impactReceipt"],
        message: "impact receipt requires an exact checkpoint graph",
      });
    }
    const seen = new Set<string>();
    for (const dependency of value.dependencies ?? []) {
      if (dependency.kind === "flow" || dependency.kind === "connector" || dependency.kind === "resource") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dependencies"],
          message: `${dependency.kind} dependency pins are server-derived`,
        });
      }
      const key = `${dependency.kind}\u0000${dependency.resourceId}`;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dependencies"],
          message: "duplicate dependency pin",
        });
      }
      seen.add(key);
    }
  });

export const DeployFlowVersionRequestSchema = z
  .object({
    versionId: RequiredText,
    versionSemanticHash: z.string().regex(/^[0-9a-f]{64}$/),
    versionFullHash: z.string().regex(/^[0-9a-f]{64}$/),
    environmentId: RequiredText,
    environmentKind: z.enum(["test", "live"]),
    expectedActiveDeploymentId: RequiredText.nullable(),
    sourceTestDeploymentId: RequiredText.nullable(),
    confirmation: z.enum(["PROMOTE TEST", "PROMOTE LIVE"]),
  })
  .strict()
  .superRefine((value, context) => {
    const isTest = value.environmentKind === "test";
    if (value.confirmation !== (isTest ? "PROMOTE TEST" : "PROMOTE LIVE")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: "promotion confirmation does not match environment",
      });
    }
    if (isTest && value.sourceTestDeploymentId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceTestDeploymentId"],
        message: "Test promotion cannot have a Test source",
      });
    }
    if (!isTest && value.sourceTestDeploymentId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceTestDeploymentId"],
        message: "Live promotion requires a Test source",
      });
    }
  });

export const RenameWorkbookTabRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
  })
  .strict();

export const ReorderWorkbookTabsRequestSchema = z
  .object({
    tabIds: z.array(TabId).max(1_000),
  })
  .strict()
  .superRefine(({ tabIds }, context) => {
    if (new Set(tabIds).size !== tabIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tabIds"],
        message: "duplicate tab id",
      });
    }
  });

export type CreateFlowVersionRequest = z.infer<typeof CreateFlowVersionRequestSchema>;
export type DeployFlowVersionRequest = z.infer<typeof DeployFlowVersionRequestSchema>;
export type RenameWorkbookTabRequest = z.infer<typeof RenameWorkbookTabRequestSchema>;
export type ReorderWorkbookTabsRequest = z.infer<typeof ReorderWorkbookTabsRequestSchema>;

export function isOpaquePathId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
