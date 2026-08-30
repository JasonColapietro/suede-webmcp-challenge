import { randomUUID } from "node:crypto";
import { resolveReadOnlyOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { createAuditCorrelation } from "@/lib/audit/repository";
import { CONNECTOR_LAB_ENABLED } from "@/lib/connectors/flags";
import { getConnectorRepository } from "@/lib/connectors/provider";
import { SIMULATION_INVALID_REQUEST, parseApiOperationSimulationJson, type ApiOperationSimulationFailureCode } from "@/lib/connectors/simulation-contract";
import { ApiOperationSimulationService } from "@/lib/connectors/simulation-service";
import { getRepo } from "@/lib/db/repo";
import { methodNotAllowed } from "@/lib/flow/subflow-api-route";
import { createTestRouteAdmission, validateTestRouteHeaders } from "@/lib/flow/test-route-admission";
import { privateJson } from "@/lib/projects/api-response";
import { getProjectRepo, ProjectStoreUnavailableError } from "@/lib/projects/provider";
import type { ProjectRepo } from "@/lib/projects/repo";
import { ipFromRequest } from "@/lib/rate-limit";
import type { FlowRepo } from "@/lib/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEST_DEADLINE_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const admission = createTestRouteAdmission();
let deadlineGeneration = 0;
type RouteContext = { readonly params: Promise<{ readonly flowId: string }> };

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && Buffer.byteLength(value, "utf8") <= 512 && !CONTROL.test(value);
}

function declaredBodyWithinLimit(request: Request): boolean {
  const value = request.headers.get("content-length");
  if (value === null) return true;
  return /^(?:0|[1-9][0-9]*)$/u.test(value) && value.length <= 16 && Number(value) <= MAX_BODY_BYTES;
}

function status(code: ApiOperationSimulationFailureCode): number {
  if (code === "SIMULATION_INVALID_REQUEST") return 400;
  if (code === "UNSUPPORTED_FIXTURE_INPUT" || code === "SIMULATION_INPUT_REFUSED" || code === "SIMULATION_REFUSED") return 422;
  if (code === "SIMULATION_NOT_FOUND") return 404;
  if (code === "SIMULATION_POLICY_REFUSED" || code === "SIMULATION_DRIFT_REFUSED") return 409;
  if (code === "SIMULATION_CANCELLED") return 408;
  if (code === "SIMULATION_TIMEOUT") return 504;
  return 503;
}

function errorResponse(code: ApiOperationSimulationFailureCode, correlationId?: string): Response {
  return privateJson({ error: code, ...(correlationId ? { correlationId } : {}) }, status(code));
}

function nextDeadlineGeneration(): number {
  deadlineGeneration = deadlineGeneration >= Number.MAX_SAFE_INTEGER ? 1 : deadlineGeneration + 1;
  return deadlineGeneration;
}

function combinedSignal(first: AbortSignal, second: AbortSignal): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const cancel = () => { if (!controller.signal.aborted) controller.abort("SIMULATION_CANCELLED"); };
  const timeout = () => { if (!controller.signal.aborted) controller.abort("SIMULATION_TIMEOUT"); };
  first.addEventListener("abort", cancel, { once: true });
  second.addEventListener("abort", timeout, { once: true });
  if (first.aborted) cancel();
  else if (second.aborted) timeout();
  return { signal: controller.signal, dispose: () => { first.removeEventListener("abort", cancel); second.removeEventListener("abort", timeout); } };
}

function readWithinSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array> | null> {
  if (signal.aborted) return Promise.resolve(null);
  const pending = reader.read();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ReadableStreamReadResult<Uint8Array> | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = (): void => {
      void reader.cancel().catch(() => undefined);
      finish(null);
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then((value) => finish(value), () => finish(null));
    if (signal.aborted) abort();
  });
}

function awaitWithinSignal<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Value | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = (): void => finish(null);
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => finish(value), () => finish(null));
    if (signal.aborted) abort();
  });
}

async function readCappedBody(request: Request, signal: AbortSignal): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) return null;
      const next = await readWithinSignal(reader, signal);
      if (!next) return null;
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    try { reader.releaseLock(); } catch { /* terminal */ }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!CONNECTOR_LAB_ENABLED) return privateJson({ error: "not found" }, 404);
  let release: (() => void) | undefined;
  let repository: Awaited<ReturnType<typeof getConnectorRepository>> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dispose: (() => void) | undefined;
  let correlationCreated = false;
  try {
    const headers = validateTestRouteHeaders(request);
    if (!headers.ok) return privateJson({ error: headers.status === 403 ? "forbidden" : "unsupported media type" }, headers.status);
    if (!declaredBodyWithinLimit(request)) return errorResponse(SIMULATION_INVALID_REQUEST);
    const deadline = new AbortController();
    const deadlineAtMs = performance.now() + TEST_DEADLINE_MS;
    const generation = nextDeadlineGeneration();
    timer = setTimeout(() => { deadline.abort("SIMULATION_TIMEOUT"); }, TEST_DEADLINE_MS);
    const combined = combinedSignal(request.signal, deadline.signal);
    dispose = combined.dispose;
    const signal = combined.signal;
    if (signal.aborted) return errorResponse(signal.reason === "SIMULATION_TIMEOUT" ? "SIMULATION_TIMEOUT" : "SIMULATION_CANCELLED");
    const ownerId = await awaitWithinSignal(resolveReadOnlyOwnerId(), signal);
    if (signal.aborted) return errorResponse(signal.reason === "SIMULATION_TIMEOUT" ? "SIMULATION_TIMEOUT" : "SIMULATION_CANCELLED");
    if (!boundedId(ownerId)) return privateJson({ error: "authentication required" }, 401);
    const acquired = admission.tryAcquire({ ownerId, ip: ipFromRequest(request) });
    if (!acquired.ok) return privateJson({ error: "too many test runs" }, 429, { "Retry-After": String(acquired.retryAfterSec) });
    release = acquired.release;
    const routeParams = await awaitWithinSignal(context.params, signal);
    if (!routeParams || signal.aborted) return errorResponse(signal.reason === "SIMULATION_TIMEOUT" ? "SIMULATION_TIMEOUT" : "SIMULATION_CANCELLED");
    const { flowId } = routeParams;
    if (!boundedId(flowId)) return errorResponse(SIMULATION_INVALID_REQUEST);
    const correlation = createAuditCorrelation(ownerId, ownerId);
    correlationCreated = true;
    const simulationId = randomUUID();
    const common = {
      ownerId,
      actorId: ownerId,
      flowId,
      correlation,
      simulationId,
      signal,
      deadlineGeneration: generation,
      deadlineAtMs,
    } as const;
    const repositoryPromise = getConnectorRepository();
    try { repository = await awaitWithinSignal(repositoryPromise, signal); } catch { return errorResponse("AUDIT_UNAVAILABLE"); }
    if (!repository) {
      void repositoryPromise.then(
        (late) => { try { late.close(); } catch { /* terminal */ } },
        () => undefined,
      );
      return errorResponse("AUDIT_UNAVAILABLE");
    }
    const raw = await readCappedBody(request, signal);
    const parsed = raw ? parseApiOperationSimulationJson(raw, signal) : null;
    const refusalOnly = new ApiOperationSimulationService({
      flowRepo: { getOwnedFlow: async () => null } as Pick<FlowRepo, "getOwnedFlow">,
      projectRepo: { getFlowContext: async () => null } as Pick<ProjectRepo, "getFlowContext">,
      connectorRepository: repository,
    });
    if (signal.aborted) {
      const result = refusalOnly.recordRefusal(common, signal.reason === "SIMULATION_TIMEOUT" ? "SIMULATION_TIMEOUT" : "SIMULATION_CANCELLED");
      return errorResponse(result.ok ? "SIMULATION_REFUSED" : result.code, result.ok ? undefined : result.correlationId);
    }
    if (!parsed) {
      const result = refusalOnly.recordRefusal(common, SIMULATION_INVALID_REQUEST);
      return errorResponse(result.ok ? "SIMULATION_REFUSED" : result.code, result.ok ? undefined : result.correlationId);
    }
    if (!parsed.ok) {
      const result = refusalOnly.recordRefusal(common, parsed.code);
      return errorResponse(result.ok ? "SIMULATION_REFUSED" : result.code, result.ok ? undefined : result.correlationId);
    }
    let flowRepo: Pick<FlowRepo, "getOwnedFlow">;
    let projectRepo: Pick<ProjectRepo, "getFlowContext">;
    try {
      const stores = await awaitWithinSignal(Promise.all([getRepo(), getProjectRepo()]), signal);
      if (!stores) throw new Error("deadline");
      [flowRepo, projectRepo] = stores;
    } catch {
      const code = signal.aborted
        ? signal.reason === "SIMULATION_TIMEOUT" ? "SIMULATION_TIMEOUT" : "SIMULATION_CANCELLED"
        : "SIMULATION_UNAVAILABLE";
      const result = refusalOnly.recordRefusal(common, code);
      return errorResponse(result.ok ? "SIMULATION_REFUSED" : result.code, result.ok ? undefined : result.correlationId);
    }
    const service = new ApiOperationSimulationService({ flowRepo, projectRepo, connectorRepository: repository });
    const result = await service.simulate({ ...common, request: parsed.value });
    return result.ok ? privateJson({ simulation: result.receipt }) : errorResponse(result.code, result.correlationId);
  } catch (error) {
    if (error instanceof UnauthenticatedOwnerError) return privateJson({ error: "authentication required" }, 401);
    if (error instanceof ProjectStoreUnavailableError) return errorResponse("SIMULATION_UNAVAILABLE");
    return errorResponse(correlationCreated ? "AUDIT_UNAVAILABLE" : "SIMULATION_UNAVAILABLE");
  } finally {
    if (timer) clearTimeout(timer);
    dispose?.();
    release?.();
    try { repository?.close(); } catch { /* terminal */ }
  }
}

export const GET = () => methodNotAllowed("POST");
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
