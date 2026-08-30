import { z } from "zod";
import type { FlowRepo } from "@/lib/db/repo";
import { SupportedFlowGraphSchema } from "./graph-schema";
import { FlowMutationService } from "./flow-mutation-service";
import { validateRunnableGraph } from "./request-schema";

export const FLOW_BACKUP_FORMAT = "suede-agent-studio-flow-backup";
export const FLOW_BACKUP_VERSION = 1;
export const MAX_FLOW_BACKUP_BYTES = 2 * 1024 * 1024;
export const MAX_FLOW_BACKUP_FLOWS = 100;

const FlowNameSchema = z.string().refine(
  (value) => value.length > 0 && value.trim() === value &&
    new TextEncoder().encode(value).length <= 200,
  "Invalid flow name",
);

const FlowBackupEntrySchema = z.object({
  id: z.string().min(1).max(512),
  name: FlowNameSchema,
  graph: SupportedFlowGraphSchema,
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const FlowBackupArchiveSchema = z.object({
  format: z.literal(FLOW_BACKUP_FORMAT),
  version: z.literal(FLOW_BACKUP_VERSION),
  createdAt: z.string().datetime({ offset: true }),
  flows: z.array(FlowBackupEntrySchema).max(MAX_FLOW_BACKUP_FLOWS),
}).strict().superRefine((archive, context) => {
  const ids = new Set<string>();
  archive.flows.forEach((flow, index) => {
    if (ids.has(flow.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Backup flow ids must be unique",
        path: ["flows", index, "id"],
      });
    }
    ids.add(flow.id);
    if (validateRunnableGraph(flow.graph) !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Backup contains an invalid flow graph",
        path: ["flows", index, "graph"],
      });
    }
  });
});

export type FlowBackupArchive = z.infer<typeof FlowBackupArchiveSchema>;

export interface FlowBackupRestoreResult {
  readonly restored: number;
  readonly skipped: number;
  readonly flowIds: readonly string[];
}

export class FlowBackupInvalidError extends Error {
  constructor() {
    super("Invalid flow backup");
    this.name = "FlowBackupInvalidError";
  }
}

export class FlowBackupTooLargeError extends Error {
  constructor() {
    super("Flow backup is too large");
    this.name = "FlowBackupTooLargeError";
  }
}

export class FlowBackupRestoreConflictError extends Error {
  constructor() {
    super("Flow backup could not be restored safely");
    this.name = "FlowBackupRestoreConflictError";
  }
}

function requireOwnerId(ownerId: string): void {
  if (ownerId.length < 1 || ownerId.length > 512) throw new FlowBackupInvalidError();
}

function archiveBytes(archive: FlowBackupArchive): number {
  return new TextEncoder().encode(JSON.stringify(archive)).length;
}

export function parseFlowBackupArchive(value: unknown): FlowBackupArchive {
  const parsed = FlowBackupArchiveSchema.safeParse(value);
  if (!parsed.success || archiveBytes(parsed.data) > MAX_FLOW_BACKUP_BYTES) {
    throw new FlowBackupInvalidError();
  }
  return parsed.data;
}

export async function createFlowBackup(
  ownerId: string,
  repo: Pick<FlowRepo, "listFlows">,
  now = Date.now(),
): Promise<FlowBackupArchive> {
  requireOwnerId(ownerId);
  const flows = await repo.listFlows(ownerId);
  if (flows.length > MAX_FLOW_BACKUP_FLOWS) throw new FlowBackupTooLargeError();
  const archive = FlowBackupArchiveSchema.parse({
    format: FLOW_BACKUP_FORMAT,
    version: FLOW_BACKUP_VERSION,
    createdAt: new Date(now).toISOString(),
    flows: [...flows]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .map((flow) => ({
      id: flow.id,
      name: flow.name,
      graph: flow.graph,
      updatedAt: flow.updatedAt,
      })),
  });
  if (archiveBytes(archive) > MAX_FLOW_BACKUP_BYTES) throw new FlowBackupTooLargeError();
  return archive;
}

async function rollbackRestoredFlows(
  repo: Pick<FlowRepo, "deleteFlow">,
  ownerId: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of [...ids].reverse()) {
    try {
      await repo.deleteFlow(id, ownerId);
    } catch {
      // The caller still receives a fixed failure. Never expose storage details.
    }
  }
}

export async function restoreFlowBackup(
  ownerId: string,
  value: unknown,
  repo: FlowRepo,
): Promise<FlowBackupRestoreResult> {
  requireOwnerId(ownerId);
  const archive = parseFlowBackupArchive(value);
  const existing = await Promise.all(
    archive.flows.map((flow) => repo.getOwnedFlow(flow.id, ownerId)),
  );
  let pending = archive.flows.filter((_flow, index) => existing[index] === null);
  const skipped = archive.flows.length - pending.length;
  const restoredIds: string[] = [];
  const service = new FlowMutationService(repo, { enabled: true });

  try {
    while (pending.length > 0) {
      const deferred: typeof pending = [];
      let progress = false;
      for (const flow of pending) {
        const result = await service.save({
          id: flow.id,
          createOnly: true,
          ownerId,
          name: flow.name,
          graph: flow.graph,
        });
        if (result.status === "saved") {
          restoredIds.push(result.flow.id);
          progress = true;
        } else if (result.status === "invalid-reference" || result.status === "not-found") {
          deferred.push(flow);
        } else {
          throw new FlowBackupRestoreConflictError();
        }
      }
      if (deferred.length > 0 && !progress) throw new FlowBackupRestoreConflictError();
      pending = deferred;
    }
  } catch (error: unknown) {
    await rollbackRestoredFlows(repo, ownerId, restoredIds);
    if (error instanceof FlowBackupRestoreConflictError) throw error;
    throw new FlowBackupRestoreConflictError();
  }

  return { restored: restoredIds.length, skipped, flowIds: restoredIds };
}
