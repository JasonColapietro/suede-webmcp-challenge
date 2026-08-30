import { z } from "zod";

const MAX_TRAIL = 32;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const OpaqueId = z.string().min(1).max(512).refine((value) => utf8Bytes(value) <= 512);
const PublicName = z.string().min(1).max(200).refine((value) => utf8Bytes(value) <= 200);
const ContentHash = z.string().regex(HASH);

export const SubflowBreadcrumbTrailItemSchema = z.object({
  flowId: OpaqueId,
  versionId: OpaqueId.optional(),
  contentHash: ContentHash.optional(),
}).strict().superRefine((item, context) => {
  if ((item.versionId === undefined) !== (item.contentHash === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "partial pin" });
  }
});

export const SubflowBreadcrumbRequestSchema = z.object({
  currentFlowId: OpaqueId,
  trail: z.array(SubflowBreadcrumbTrailItemSchema).max(MAX_TRAIL),
}).strict().superRefine((request, context) => {
  if (request.trail.length === 0) return;
  if (request.trail[0]?.versionId !== undefined || request.trail[0]?.contentHash !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "root pin has no provenance", path: ["trail", 0] });
  }
  if (request.trail.at(-1)?.flowId !== request.currentFlowId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "current flow mismatch", path: ["trail"] });
  }
  const seen = new Set<string>();
  for (let index = 0; index < request.trail.length; index += 1) {
    const flowId = request.trail[index]!.flowId;
    if (seen.has(flowId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate flow", path: ["trail", index] });
      return;
    }
    seen.add(flowId);
  }
});

export type SubflowBreadcrumbRequest = z.infer<typeof SubflowBreadcrumbRequestSchema>;
export type SubflowBreadcrumbTrailItem = z.infer<typeof SubflowBreadcrumbTrailItemSchema>;

export const SubflowBreadcrumbSchema = z.object({
  flowId: OpaqueId,
  name: PublicName,
  versionId: OpaqueId.optional(),
  versionNumber: z.number().int().safe().positive().optional(),
  contentHash: ContentHash.optional(),
}).strict().superRefine((crumb, context) => {
  const pins = [crumb.versionId, crumb.versionNumber, crumb.contentHash];
  if (pins.some((value) => value !== undefined) && pins.some((value) => value === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "partial projected pin" });
  }
});

export const SubflowBreadcrumbResponseSchema = z.object({
  crumbs: z.array(SubflowBreadcrumbSchema).max(MAX_TRAIL),
}).strict();

export type SubflowBreadcrumb = z.infer<typeof SubflowBreadcrumbSchema>;

export interface SubflowBreadcrumbRepository {
  readSubflowBreadcrumbs(input: {
    readonly ownerId: string;
    readonly currentFlowId: string;
    readonly trail: readonly SubflowBreadcrumbTrailItem[];
  }): Promise<{ readonly crumbs: readonly SubflowBreadcrumb[] } | null>;
}

export class SubflowBreadcrumbStoreUnavailableError extends Error {
  constructor() {
    super("Subflow breadcrumb store unavailable");
    this.name = "SubflowBreadcrumbStoreUnavailableError";
  }
}

export function subflowBreadcrumbRequestWithinBudget(value: unknown): boolean {
  try {
    return utf8Bytes(JSON.stringify(value)) <= MAX_REQUEST_BYTES;
  } catch {
    return false;
  }
}

export class SubflowBreadcrumbService {
  constructor(private readonly repository: Partial<SubflowBreadcrumbRepository>) {}

  async read(input: { readonly ownerId: string } & SubflowBreadcrumbRequest): Promise<{
    readonly crumbs: readonly SubflowBreadcrumb[];
  } | null> {
    if (!this.repository.readSubflowBreadcrumbs) throw new SubflowBreadcrumbStoreUnavailableError();
    const result = await this.repository.readSubflowBreadcrumbs(input);
    if (result === null) return null;
    const parsed = SubflowBreadcrumbResponseSchema.safeParse(result);
    if (!parsed.success || utf8Bytes(JSON.stringify(parsed.data)) > MAX_RESPONSE_BYTES) return null;
    return parsed.data;
  }
}
