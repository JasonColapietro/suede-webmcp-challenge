import { executeDurableAttempt, InjectedWorkerCrash, type CrashSeam } from "./execute-attempt";
import type { DurableRuntimeRepository, LeaseIdentity } from "./repository";

export type WorkerTickResult = Readonly<{
  status: "idle" | "completed" | "failed" | "retry-scheduled" | "cancelled" | "paused" | "dead-lettered" | "lost" | "crashed" | "stopped" | "refused";
  executionId?: string;
}>;

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;

export async function runWorkerTick(input: {
  readonly repository: DurableRuntimeRepository;
  readonly workerId: string;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly crashAt?: CrashSeam;
  readonly recoveryLimit?: number;
  readonly now?: () => number;
}): Promise<WorkerTickResult> {
  if (input.signal?.aborted) return { status: "stopped" };
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_MS;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > 3_600_000 ||
      !Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1 || heartbeatIntervalMs >= leaseDurationMs) return { status: "refused" };
  const recovery = await input.repository.recoverExpiredLeases({ limit: input.recoveryLimit ?? 10 });
  if (recovery.status === "refused") return { status: "refused" };
  const claimed = await input.repository.claimNextJob({ workerId: input.workerId, leaseDurationMs });
  if (claimed.status === "no-job") return { status: "idle" };
  if (claimed.status !== "claimed") return { status: "refused" };

  const claim = claimed.claim;
  const identity: LeaseIdentity = claim;
  const controller = new AbortController();
  let control: "running" | "paused" | "cancelled" | "lost" | "deadline" | "stopped" = "running";
  let heartbeatInFlight = Promise.resolve();
  const observe = (): Promise<void> => {
    heartbeatInFlight = heartbeatInFlight.then(async () => {
      if (control !== "running") return;
      const heartbeat = await input.repository.heartbeat({ ...identity, leaseDurationMs });
      if (heartbeat.status === "lost" || heartbeat.status === "refused") {
        control = "lost"; controller.abort(new Error("Durable lease lost")); return;
      }
      if (heartbeat.status !== "extended" && heartbeat.status !== "retained") {
        control = "lost"; controller.abort(new Error("Durable lease lost")); return;
      }
      if (heartbeat.desiredState === "paused") {
        control = "paused"; controller.abort(new Error("Durable execution paused")); return;
      }
      if (heartbeat.desiredState === "cancelled") {
        control = "cancelled"; controller.abort(new Error("Durable execution cancelled"));
      }
    });
    return heartbeatInFlight;
  };

  await observe();
  const interval = setInterval(() => { void observe(); }, heartbeatIntervalMs);
  const now = input.now ?? Date.now;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const scheduleDeadline = (): void => {
    if (claim.deadlineAt === null || control !== "running") return;
    const remaining = claim.deadlineAt - now();
    if (remaining <= 0) { control = "deadline"; controller.abort(new DOMException("Durable deadline exceeded", "TimeoutError")); return; }
    deadline = setTimeout(scheduleDeadline, Math.min(2_147_483_647, remaining));
  };
  scheduleDeadline();
  const onStop = (): void => {
    if (control === "running") { control = "stopped"; controller.abort(input.signal?.reason); }
  };
  input.signal?.addEventListener("abort", onStop, { once: true });
  const currentControl = (): typeof control => control;
  try {
    if (control !== "running") throw controller.signal.reason;
    const result = await executeDurableAttempt({ repository: input.repository, claim, signal: controller.signal, crashAt: input.crashAt });
    if (result.status === "lost") {
      await observe();
      if (currentControl() !== "running") throw controller.signal.reason;
    }
    return { status: result.status, executionId: claim.executionId };
  } catch (error) {
    if (error instanceof InjectedWorkerCrash) throw error;
    await heartbeatInFlight;
    if (currentControl() === "paused") {
      const result = await input.repository.pauseAttempt(identity);
      return { status: result.status === "appended" ? "paused" : "lost", executionId: claim.executionId };
    }
    if (currentControl() === "cancelled") {
      const result = await input.repository.failAttempt({ ...identity, classification: "cancelled", error: "cancelled by control request" });
      return { status: result.status === "cancelled" ? "cancelled" : "lost", executionId: claim.executionId };
    }
    if (currentControl() === "deadline") {
      const result = await input.repository.failAttempt({ ...identity, classification: "timeout", error: "durable execution deadline exceeded" });
      return { status: result.status === "retry-scheduled" ? "retry-scheduled" : result.status === "dead-lettered" ? "dead-lettered" : result.status === "failed" ? "failed" : "lost", executionId: claim.executionId };
    }
    if (currentControl() === "stopped") return { status: "stopped", executionId: claim.executionId };
    return { status: "lost", executionId: claim.executionId };
  } finally {
    clearInterval(interval);
    if (deadline !== null) clearTimeout(deadline);
    input.signal?.removeEventListener("abort", onStop);
    await heartbeatInFlight;
  }
}

export async function runWorkerLoop(input: {
  readonly repository: DurableRuntimeRepository;
  readonly workerId: string;
  readonly signal: AbortSignal;
  readonly idleBackoffMs?: number;
}): Promise<void> {
  const idleBackoffMs = input.idleBackoffMs ?? 500;
  if (!Number.isSafeInteger(idleBackoffMs) || idleBackoffMs < 10 || idleBackoffMs > 30_000) throw new TypeError("Invalid durable worker idle backoff");
  while (!input.signal.aborted) {
    const result = await runWorkerTick(input);
    if (result.status !== "idle" && result.status !== "refused") continue;
    await new Promise<void>((resolve) => {
      const finish = (): void => { clearTimeout(timer); input.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, idleBackoffMs);
      input.signal.addEventListener("abort", finish, { once: true });
    });
  }
}
