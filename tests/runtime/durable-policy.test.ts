import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_DEFS } from "@/lib/flow/registry";
import { DURABLE_NODE_ADMISSION } from "@/lib/runtime/admission";
import {
  DURABLE_RUNTIME_POLICY_VERSION,
  DURABLE_RUNTIME_SOURCE_MANIFEST,
  durableRuntimePolicyFingerprint,
} from "@/lib/runtime/durable-policy";

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function normalizePolicySource(source: string): string {
  const normalized = source.replace(
    /aggregateSha256: "[a-f0-9]{64}"/u,
    'aggregateSha256: "<normalized-self-hash>"',
  );
  if (normalized === source) throw new Error("durable policy self-hash literal not found");
  return normalized;
}

function reviewedBytes(path: string): Buffer {
  const bytes = readFileSync(path);
  if (!path.endsWith("/src/lib/runtime/durable-policy.ts")) return bytes;
  return Buffer.from(normalizePolicySource(bytes.toString("utf8")), "utf8");
}

describe("durable runtime source and policy manifest", () => {
  it("matches every transitive flow TypeScript source plus the durable execution boundary", () => {
    const paths = [...filesUnder(join(process.cwd(), "src/lib/flow")),
      join(process.cwd(), "src/lib/runtime/admission.ts"),
      join(process.cwd(), "src/lib/runtime/durable-graph-audit.ts"),
      join(process.cwd(), "src/lib/runtime/execute-attempt.ts"),
      join(process.cwd(), "src/lib/runtime/worker.ts"),
      join(process.cwd(), "src/lib/runtime/invocation.ts"),
      join(process.cwd(), "src/lib/runtime/event-schema.ts"),
      join(process.cwd(), "src/lib/runtime/projection.ts"),
      join(process.cwd(), "src/lib/runtime/sqlite-runtime-repo.ts"),
      join(process.cwd(), "src/lib/runtime/retry-policy.ts"),
      join(process.cwd(), "src/lib/runtime/repository.ts"),
      join(process.cwd(), "src/lib/runtime/enqueue.ts"),
      join(process.cwd(), "src/lib/runtime/types.ts"),
      join(process.cwd(), "src/lib/runtime/durable-policy.ts"),
      join(process.cwd(), "src/lib/projects/hash.ts"),
      join(process.cwd(), "src/lib/log.ts"),
      join(process.cwd(), "src/lib/db/migrations/sqlite.ts")]
      .map((path) => relative(process.cwd(), path)).sort();
    const lines = paths.map((path) => `${createHash("sha256").update(reviewedBytes(join(process.cwd(), path))).digest("hex")}  ${path}\n`).join("");
    expect(createHash("sha256").update(lines).digest("hex")).toBe(DURABLE_RUNTIME_SOURCE_MANIFEST.aggregateSha256);
  });

  it("enumerates every canonical node and fails closed for executor identity drift", () => {
    expect(Object.keys(DURABLE_NODE_ADMISSION).sort()).toEqual(NODE_DEFS.map((entry) => entry.type).sort());
    expect(durableRuntimePolicyFingerprint()).toMatch(/^[a-f0-9]{64}$/);
    const input = NODE_DEFS.find((entry) => entry.type === "input")!;
    const original = input.executor;
    input.executor = async () => ({ ok: true, outputs: {}, costUsdc: 0 });
    try { expect(() => durableRuntimePolicyFingerprint()).toThrow(/executor identity drift/i); }
    finally { input.executor = original; }
  });

  it("binds policy implementation bytes without recursively binding its aggregate literal", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/runtime/durable-policy.ts"), "utf8");
    const digest = (value: string) => createHash("sha256").update(normalizePolicySource(value)).digest("hex");
    expect(DURABLE_RUNTIME_POLICY_VERSION).toBe(9);
    expect(source).toContain("version: DURABLE_RUNTIME_POLICY_VERSION");
    expect(digest(source.replace(/aggregateSha256: "[a-f0-9]{64}"/u, `aggregateSha256: "${"f".repeat(64)}"`))).toBe(digest(source));
    expect(digest(source.replace("DURABLE_RUNTIME_POLICY_VERSION = 9", "DURABLE_RUNTIME_POLICY_VERSION = 10"))).not.toBe(digest(source));
    expect(digest(source.replace("reviewed.executor !== runtime.executor", "false"))).not.toBe(digest(source));
  });
});
