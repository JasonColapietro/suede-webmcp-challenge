import { UnauthenticatedOwnerError, resolveReadOnlyOwnerId } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { methodNotAllowed } from "@/lib/flow/subflow-api-route";
import { validateAndCompileTestRunRequest } from "@/lib/flow/test-run-contract";
import {
  createTestRouteAdmission,
  validateTestRouteHeaders,
} from "@/lib/flow/test-route-admission";
import { runEphemeralScopedTest } from "@/lib/flow/test-runner";
import {
  invalidRequestResponse,
  notFoundResponse,
  parsedJsonWithinBudget,
  privateJson,
  readCappedJsonRequest,
} from "@/lib/projects/api-response";
import { getProjectRepo, ProjectStoreUnavailableError } from "@/lib/projects/provider";
import { ipFromRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEST_DEADLINE_MS = 10_000;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const admission = createTestRouteAdmission();

type RouteContext = { readonly params: Promise<{ readonly flowId: string }> };

function boundedFlowId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.trim() === value && Buffer.byteLength(value, "utf8") <= 512 && !CONTROL.test(value);
}

function shallowEnvironmentId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "environmentId");
  } catch {
    return null;
  }
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return null;
  return boundedFlowId(descriptor.value) ? descriptor.value : null;
}

function combinedSignal(first: AbortSignal, second: AbortSignal): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  if (first.aborted) return { signal: first, dispose: () => undefined };
  if (second.aborted) return { signal: second, dispose: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort();
  first.addEventListener("abort", abort, { once: true });
  second.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      first.removeEventListener("abort", abort);
      second.removeEventListener("abort", abort);
    },
  };
}

class TestRouteDeadlineError extends Error {}
class TestRouteCancelledError extends Error {}

function routeAbortError(requestSignal: AbortSignal, deadlineWon: () => boolean): Error {
  return deadlineWon() ? new TestRouteDeadlineError() :
    requestSignal.aborted ? new TestRouteCancelledError() : new TestRouteDeadlineError();
}

function awaitWithinRouteDeadline<Value>(
  pending: Promise<Value>,
  signal: AbortSignal,
  requestSignal: AbortSignal,
  deadlineWon: () => boolean,
): Promise<Value> {
  if (signal.aborted) return Promise.reject(routeAbortError(requestSignal, deadlineWon));
  return new Promise<Value>((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(routeAbortError(requestSignal, deadlineWon));
    };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  let release: (() => void) | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let disposeSignal: (() => void) | undefined;
  let deadlineWon = false;
  try {
    const headerResult = validateTestRouteHeaders(request);
    if (!headerResult.ok) {
      return headerResult.status === 403
        ? privateJson({ error: "forbidden" }, 403)
        : privateJson({ error: "unsupported media type" }, 415);
    }

    const deadline = new AbortController();
    deadlineTimer = setTimeout(() => {
      deadlineWon = true;
      deadline.abort();
    }, TEST_DEADLINE_MS);
    const combined = combinedSignal(request.signal, deadline.signal);
    const signal = combined.signal;
    disposeSignal = combined.dispose;
    const withinDeadline = <Value,>(pending: Promise<Value>) =>
      awaitWithinRouteDeadline(pending, signal, request.signal, () => deadlineWon);

    if (signal.aborted) throw routeAbortError(request.signal, () => deadlineWon);
    const ownerId = await withinDeadline(resolveReadOnlyOwnerId());
    const acquired = admission.tryAcquire({ ownerId, ip: ipFromRequest(request) });
    if (!acquired.ok) {
      return privateJson(
        { error: "too many test runs" },
        429,
        { "Retry-After": String(acquired.retryAfterSec) },
      );
    }
    release = acquired.release;

    const { flowId } = await withinDeadline(context.params);
    if (!boundedFlowId(flowId)) return invalidRequestResponse();
    const repo = await withinDeadline(getRepo());
    const flow = await withinDeadline(repo.getOwnedFlow(flowId, ownerId));
    if (!flow) return notFoundResponse();

    const read = await withinDeadline(readCappedJsonRequest(request, { signal }));
    if (deadlineWon) throw new TestRouteDeadlineError();
    if (request.signal.aborted) throw new TestRouteCancelledError();
    if (!read.ok) return invalidRequestResponse();
    const environmentId = shallowEnvironmentId(read.data);
    if (!environmentId) return invalidRequestResponse();

    const projectRepo = await withinDeadline(getProjectRepo());
    const flowContext = await withinDeadline(projectRepo.getFlowContext(flowId, ownerId));
    if (!flowContext || flowContext.binding.flowId !== flowId ||
        flowContext.binding.projectId !== flowContext.project.id) {
      return notFoundResponse();
    }
    const environment = flowContext.environments.find((candidate) => candidate.id === environmentId);
    if (!environment || environment.projectId !== flowContext.project.id || environment.kind !== "test") {
      return notFoundResponse();
    }

    if (!parsedJsonWithinBudget(read.data)) return invalidRequestResponse();
    const compiled = validateAndCompileTestRunRequest(read.data);
    if (deadlineWon) throw new TestRouteDeadlineError();
    if (request.signal.aborted) throw new TestRouteCancelledError();
    if (!compiled.ok) return invalidRequestResponse();
    try {
      const result = await withinDeadline(runEphemeralScopedTest(read.data, { signal }));
      if (deadlineWon) return privateJson({ error: "test timed out" }, 504);
      if (request.signal.aborted) return privateJson({ error: "request cancelled" }, 408);
      return privateJson({ result });
    } catch (error) {
      if (deadlineWon) return privateJson({ error: "test timed out" }, 504);
      if (request.signal.aborted) return privateJson({ error: "request cancelled" }, 408);
      throw error;
    }
  } catch (error) {
    if (error instanceof TestRouteDeadlineError) {
      return privateJson({ error: "test timed out" }, 504);
    }
    if (error instanceof TestRouteCancelledError) {
      return privateJson({ error: "request cancelled" }, 408);
    }
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: "Authentication required" }, 401);
    }
    if (error instanceof ProjectStoreUnavailableError) {
      return privateJson({ error: "project store unavailable" }, 503);
    }
    return privateJson({ error: "internal server error" }, 500);
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    disposeSignal?.();
    release?.();
  }
}

export const GET = () => methodNotAllowed("POST");
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
