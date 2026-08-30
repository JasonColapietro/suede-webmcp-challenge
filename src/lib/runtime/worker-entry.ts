import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { SqliteDurableRuntimeRepository } from "./sqlite-runtime-repo";
import { runWorkerLoop } from "./worker";

export async function startRuntimeWorker(input: Readonly<{ databasePath: string; hashKey: string }>): Promise<void> {
  if (!isAbsolute(input.databasePath)) throw new TypeError("An absolute durable SQLite path is required");
  const controller = new AbortController();
  const stop = (): void => controller.abort(new Error("Durable worker stopping"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const repository = new SqliteDurableRuntimeRepository(input.databasePath, { idempotencyHashKey: input.hashKey });
  try {
    await runWorkerLoop({ repository, workerId: `local-${process.pid}-${randomUUID()}`, signal: controller.signal });
  } finally {
    repository.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
