import { isAbsolute } from "node:path";
import { register } from "node:module";

const databasePath = process.env.SQLITE_PATH;
const hashKey = process.env.RUNTIME_IDEMPOTENCY_HMAC_KEY;
if (!databasePath || !isAbsolute(databasePath)) throw new Error("SQLITE_PATH must be an explicit absolute path");
if (!hashKey || Buffer.byteLength(hashKey, "utf8") < 32 || new Set(Buffer.from(hashKey, "utf8")).size < 8) {
  throw new Error("RUNTIME_IDEMPOTENCY_HMAC_KEY must be strong and at least 32 bytes");
}
register("./runtime-ts-loader.mjs", import.meta.url);
const { startRuntimeWorker } = await import("../src/lib/runtime/worker-entry.ts");
await startRuntimeWorker({ databasePath, hashKey });
