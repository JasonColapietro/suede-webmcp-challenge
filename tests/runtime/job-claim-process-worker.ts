import { SqliteDurableRuntimeRepository } from "@/lib/runtime/sqlite-runtime-repo";
import { TEST_KEY } from "./task3-fixture";
import { existsSync, writeFileSync } from "node:fs";

const path = process.env.DURABLE_CLAIM_DB;
const workerId = process.env.DURABLE_WORKER_ID;
const readyPath = process.env.DURABLE_READY_PATH;
const releasePath = process.env.DURABLE_RELEASE_PATH;
if (!path || !workerId || !readyPath || !releasePath) throw new Error("Missing isolated claim worker input");
const repo = new SqliteDurableRuntimeRepository(path, { idempotencyHashKey: TEST_KEY, clock: () => 10 });
writeFileSync(readyPath, workerId, "utf8");
const wait = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(releasePath)) Atomics.wait(wait, 0, 0, 10);
const result = await repo.claimNextJob({ workerId, leaseDurationMs: 100 });
repo.close();
process.stdout.write(JSON.stringify(result));
