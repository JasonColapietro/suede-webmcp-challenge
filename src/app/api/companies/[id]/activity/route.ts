/**
 * GET /api/companies/[id]/activity — a bounded, owner-scoped audit stream
 * reconstructed from durable runs, run steps, approvals, and settlement
 * rows. No transient dashboard state contributes to this response.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import {
  getRepo,
  type CompanyActivityCursor,
  type RunStepRecord,
} from "@/lib/db/repo";
import {
  invalidRequestResponse,
  notFoundResponse,
  privateJson,
} from "@/lib/projects/api-response";

export const runtime = "nodejs";

const ActivityStatusSchema = z.enum([
  "running",
  "done",
  "error",
  "pending",
  "approved",
  "rejected",
  "consumed",
]);

const ActivityQuerySchema = z
  .object({
    employeeId: z.string().trim().min(1).max(200).optional(),
    departmentId: z.string().trim().min(1).max(200).optional(),
    status: ActivityStatusSchema.optional(),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(512).optional(),
  })
  .superRefine((value, context) => {
    if (value.month && (value.from || value.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "month cannot be combined with from/to",
      });
    }
  });

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface ActivityWindow {
  fromIso: string;
  toIso: string;
  fromMs: number;
  toMs: number;
}

interface ActivityOutcome {
  kind: "output" | "error" | "none";
  nodeId: string | null;
  preview: string | null;
}

interface ActivityEntry {
  id: string;
  kind: "run" | "approval";
  employeeId: string | null;
  departmentId: string | null;
  status: z.infer<typeof ActivityStatusSchema>;
  occurredAt: string;
  trigger: string | null;
  costUsdc: number | null;
  approvalKind: string | null;
  reason: string | null;
  outcome: ActivityOutcome;
  receipt: {
    tx: string | null;
    payer: string | null;
    grossUsdc: number;
    creatorUsdc: number;
  } | null;
}

const ActivityCursorPayloadSchema = z.object({
  v: z.literal(1),
  at: z.string().datetime({ offset: true }),
  id: z.string().min(5).max(240).regex(/^(run|approval):[A-Za-z0-9_-]+$/),
}).strict();

function decodeCursor(value: string | undefined): CompanyActivityCursor | null | undefined {
  if (value === undefined) return undefined;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.length > 384 || bytes.toString("base64url") !== value) return null;
    const parsed = ActivityCursorPayloadSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success) return null;
    return { occurredAt: parsed.data.at, id: parsed.data.id };
  } catch {
    return null;
  }
}

function encodeCursor(cursor: CompanyActivityCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, at: cursor.occurredAt, id: cursor.id }), "utf8")
    .toString("base64url");
}

function queryValue(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

function resolveWindow(query: z.infer<typeof ActivityQuerySchema>): ActivityWindow | null {
  let from: Date;
  let to: Date;
  if (query.month) {
    const [yearText, monthText] = query.month.split("-");
    const year = Number(yearText);
    const monthIndex = Number(monthText) - 1;
    from = new Date(Date.UTC(year, monthIndex, 1));
    to = new Date(Date.UTC(year, monthIndex + 1, 1));
  } else {
    from = query.from ? new Date(query.from) : new Date(0);
    to = query.to ? new Date(query.to) : new Date(Date.now() + 1);
  }
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return null;
  return { fromIso: from.toISOString(), toIso: to.toISOString(), fromMs, toMs };
}

function boundedPreview(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const normalized = text.trim();
  if (normalized === "") return null;
  return normalized.length > 500 ? `${normalized.slice(0, 497)}…` : normalized;
}

function outcomeFromSteps(steps: RunStepRecord[]): ActivityOutcome {
  const failed = [...steps].reverse().find((step) => step.error !== null);
  if (failed) {
    return { kind: "error", nodeId: failed.nodeId, preview: boundedPreview(failed.error) };
  }
  const produced = [...steps].reverse().find((step) => step.output !== null);
  if (produced) {
    return { kind: "output", nodeId: produced.nodeId, preview: boundedPreview(produced.output) };
  }
  return { kind: "none", nodeId: null, preview: null };
}

export async function GET(request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();

    const company = await repo.getCompany(id);
    if (!company || company.ownerId !== owner) return notFoundResponse();

    const { searchParams } = new URL(request.url);
    const parsed = ActivityQuerySchema.safeParse({
      employeeId: queryValue(searchParams.get("employeeId")),
      departmentId: queryValue(searchParams.get("departmentId")),
      status: queryValue(searchParams.get("status")),
      month: queryValue(searchParams.get("month")),
      from: queryValue(searchParams.get("from")),
      to: queryValue(searchParams.get("to")),
      limit: queryValue(searchParams.get("limit")),
      cursor: queryValue(searchParams.get("cursor")),
    });
    if (!parsed.success) return invalidRequestResponse();
    const window = resolveWindow(parsed.data);
    if (!window) return invalidRequestResponse();
    const cursor = decodeCursor(parsed.data.cursor);
    if (cursor === null) return invalidRequestResponse();

    const [departments, allEmployees] = await Promise.all([
      repo.listDepartments(id),
      repo.listCompanyEmployeeHistory(id),
    ]);
    const departmentIds = new Set(departments.map((department) => department.id));
    if (parsed.data.departmentId && !departmentIds.has(parsed.data.departmentId)) {
      return notFoundResponse();
    }
    const employeeById = new Map(allEmployees.map((employee) => [employee.agentId, employee]));
    if (parsed.data.employeeId && !employeeById.has(parsed.data.employeeId)) {
      return notFoundResponse();
    }

    const page = await repo.listCompanyActivity({
      companyId: id,
      ...(parsed.data.employeeId ? { employeeId: parsed.data.employeeId } : {}),
      ...(parsed.data.departmentId ? { departmentId: parsed.data.departmentId } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      fromMs: window.fromMs,
      toMs: window.toMs,
      ...(cursor ? { cursor } : {}),
      limit: parsed.data.limit,
    });
    const activities = await Promise.all(
      page.records.map(async (record): Promise<ActivityEntry> => {
        const entry: ActivityEntry = {
          id: record.id,
          kind: record.kind,
          employeeId: record.employeeId,
          departmentId: record.departmentId,
          status: record.status,
          occurredAt: new Date(record.occurredAt).toISOString(),
          trigger: record.trigger,
          costUsdc: record.costUsdc,
          approvalKind: record.approvalKind,
          reason: record.reason,
          outcome: { kind: "none", nodeId: null, preview: null },
          receipt: record.receipt
            ? {
                tx: record.receipt.tx,
                payer: record.receipt.payer,
                grossUsdc: record.receipt.grossUsdc,
                creatorUsdc: record.receipt.creatorUsdc,
              }
            : null,
        };
        if (entry.kind !== "run") return entry;
        const steps = await repo.listRunSteps(entry.id.slice("run:".length));
        return { ...entry, outcome: outcomeFromSteps(steps) };
      }),
    );
    const lastRecord = page.records.at(-1);
    const nextCursor = page.hasMore && lastRecord
      ? encodeCursor({ occurredAt: lastRecord.occurredAt, id: lastRecord.id })
      : null;

    return privateJson({
      from: window.fromIso,
      to: window.toIso,
      activities,
      hasMore: nextCursor !== null,
      nextCursor,
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}
