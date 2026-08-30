import { z } from "zod";
import type { FlowProjectContext } from "./repo";
import type {
  FlowWorkbookContext,
  WorkbookFlowTab,
} from "./types";
import { ENVIRONMENT_KINDS } from "./types";

const OpaqueIdSchema = z.string().trim().min(1).max(512);
const TimestampSchema = z.number().int().safe();

const ProjectSchema = z
  .object({
    id: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    name: z.string(),
    slug: z.string(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

const WorkbookSchema = z
  .object({
    id: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
    name: z.string(),
    slug: z.string(),
    position: z.number().int().safe().nonnegative(),
    createdAt: TimestampSchema,
  })
  .strict();

const EnvironmentSchema = z
  .object({
    id: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
    name: z.string(),
    slug: z.string(),
    kind: z.enum(ENVIRONMENT_KINDS),
    createdAt: TimestampSchema,
  })
  .strict();

const FlowWorkbookContextSchema = z
  .object({
    project: ProjectSchema,
    workbook: WorkbookSchema,
    environments: z.array(EnvironmentSchema),
  })
  .strict();

const WorkbookFlowTabSchema = z
  .object({
    id: OpaqueIdSchema,
    workbookId: OpaqueIdSchema,
    flowId: OpaqueIdSchema,
    title: z.string().trim().min(1).max(200),
    position: z.number().int().safe().nonnegative(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

const WorkbookTabsEnvelopeSchema = z
  .object({
    tabs: z.array(WorkbookFlowTabSchema),
  })
  .strict();

const WorkbookTabEnvelopeSchema = z
  .object({
    tab: WorkbookFlowTabSchema,
  })
  .strict();

const FlowWorkbookEnvelopeSchema = z
  .object({
    context: FlowWorkbookContextSchema,
    tabs: z.array(WorkbookFlowTabSchema),
  })
  .strict();

export interface FlowWorkbookEnvelope {
  readonly context: FlowWorkbookContext;
  readonly tabs: WorkbookFlowTab[];
}

function validOrderedTabSet(
  tabs: readonly WorkbookFlowTab[],
  workbookId?: string,
): boolean {
  const ids = new Set<string>();
  const flowIds = new Set<string>();
  const commonWorkbookId = workbookId ?? tabs[0]?.workbookId;
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    if (
      tab.position !== index ||
      ids.has(tab.id) ||
      flowIds.has(tab.flowId) ||
      tab.workbookId !== commonWorkbookId
    ) {
      return false;
    }
    ids.add(tab.id);
    flowIds.add(tab.flowId);
  }
  return true;
}

export function publicFlowWorkbookContext(
  value: FlowProjectContext,
): FlowWorkbookContext {
  return {
    project: {
      id: value.project.id,
      workspaceId: value.project.workspaceId,
      name: value.project.name,
      slug: value.project.slug,
      createdAt: value.project.createdAt,
      updatedAt: value.project.updatedAt,
    },
    workbook: {
      id: value.workbook.id,
      projectId: value.workbook.projectId,
      name: value.workbook.name,
      slug: value.workbook.slug,
      position: value.workbook.position,
      createdAt: value.workbook.createdAt,
    },
    environments: value.environments.map((environment) => ({
      id: environment.id,
      projectId: environment.projectId,
      name: environment.name,
      slug: environment.slug,
      kind: environment.kind,
      createdAt: environment.createdAt,
    })),
  };
}

export function parseWorkbookTabsEnvelope(
  value: unknown,
  expectedWorkbookId?: string,
): WorkbookFlowTab[] | null {
  const parsed = WorkbookTabsEnvelopeSchema.safeParse(value);
  const expected = expectedWorkbookId === undefined
    ? undefined
    : OpaqueIdSchema.safeParse(expectedWorkbookId);
  if (
    !parsed.success ||
    (expected !== undefined && !expected.success) ||
    !validOrderedTabSet(
      parsed.data.tabs,
      expected?.success === true ? expected.data : undefined,
    )
  ) {
    return null;
  }
  return parsed.data.tabs;
}

export function parseWorkbookTabEnvelope(value: unknown): WorkbookFlowTab | null {
  const parsed = WorkbookTabEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data.tab : null;
}

export function parseFlowWorkbookEnvelope(value: unknown): FlowWorkbookEnvelope | null {
  const parsed = FlowWorkbookEnvelopeSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.context.workbook.projectId !== parsed.data.context.project.id ||
    parsed.data.context.environments.some(
      (environment) => environment.projectId !== parsed.data.context.project.id,
    ) ||
    !validOrderedTabSet(parsed.data.tabs, parsed.data.context.workbook.id)
  ) {
    return null;
  }
  return {
    context: {
      project: {
        id: parsed.data.context.project.id,
        workspaceId: parsed.data.context.project.workspaceId,
        name: parsed.data.context.project.name,
        slug: parsed.data.context.project.slug,
        createdAt: parsed.data.context.project.createdAt,
        updatedAt: parsed.data.context.project.updatedAt,
      },
      workbook: {
        id: parsed.data.context.workbook.id,
        projectId: parsed.data.context.workbook.projectId,
        name: parsed.data.context.workbook.name,
        slug: parsed.data.context.workbook.slug,
        position: parsed.data.context.workbook.position,
        createdAt: parsed.data.context.workbook.createdAt,
      },
      environments: parsed.data.context.environments.map((environment) => ({
        id: environment.id,
        projectId: environment.projectId,
        name: environment.name,
        slug: environment.slug,
        kind: environment.kind,
        createdAt: environment.createdAt,
      })),
    },
    tabs: parsed.data.tabs.map((tab) => ({
      id: tab.id,
      workbookId: tab.workbookId,
      flowId: tab.flowId,
      title: tab.title,
      position: tab.position,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
    })),
  };
}
