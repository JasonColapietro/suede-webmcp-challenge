import type { DurableRuntimeRepository } from "./repository";
import { isAbsolute } from "node:path";

export class DurableRuntimeUnavailableError extends Error {
  constructor() { super("Durable runtime unavailable"); this.name = "DurableRuntimeUnavailableError"; }
}

type Cache = Readonly<{ path: string; key: string; promise: Promise<DurableRuntimeRepository> }>;
let cache: Cache | null = null;

export async function getDurableRuntimeRepository(): Promise<DurableRuntimeRepository> {
  if (process.env.DB_DRIVER !== "sqlite") throw new DurableRuntimeUnavailableError();
  const path = process.env.SQLITE_PATH;
  const key = process.env.RUNTIME_IDEMPOTENCY_HMAC_KEY;
  if (!path || !isAbsolute(path) || !key) throw new DurableRuntimeUnavailableError();
  if (cache) {
    if (cache.path !== path || cache.key !== key) throw new DurableRuntimeUnavailableError();
    return cache.promise;
  }
  const initialization = (async (): Promise<DurableRuntimeRepository> => {
    const { SqliteDurableRuntimeRepository } = await import("./sqlite-runtime-repo");
    return new SqliteDurableRuntimeRepository(path, { idempotencyHashKey: key });
  })();
  const guarded = initialization.catch(() => {
    if (cache?.promise === guarded) cache = null;
    throw new DurableRuntimeUnavailableError();
  });
  cache = Object.freeze({ path, key, promise: guarded });
  return guarded;
}
