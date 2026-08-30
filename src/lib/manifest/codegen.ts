import { afterHandle, afterNodeId } from "./schema";
import type {
  AgentManifest,
  AgentManifestV2,
  ManifestStep,
  ManifestTrigger,
} from "./schema";
import {
  ApiOperationV1UnsupportedError,
  graphContainsApiOperation,
} from "@/lib/flow/api-operation-contract";

/**
 * The branch node's fixed, exhaustive output contract (src/lib/flow/nodes/branch.ts):
 * every real execution resolves to exactly one of these two handles, never
 * both and never neither. Codegen relies on that guarantee below.
 */
const BRANCH_HANDLES = ["true", "false"] as const;

/**
 * Direct handle-routed children of every branch step, grouped by handle.
 *
 * A step only qualifies here when it has exactly one `after` entry, that
 * entry names a handle, and the entry's upstream step is a "branch". That
 * is the shape produced by from-flow.ts for a plain branch --true/false-->
 * step edge. Anything else (a step with more than one incoming edge, or a
 * handle-tagged entry whose upstream step is not a branch, e.g. a loop's
 * "errors" output) is left out of this plan on purpose and keeps rendering
 * as a flat, unconditional step exactly like before -- see the NOTE this
 * function's caller emits for that case.
 */
function buildBranchGuardPlan(manifest: AgentManifest): Map<string, Map<string, ManifestStep[]>> {
  const stepById = new Map(manifest.steps.map((s) => [s.id, s]));
  const plan = new Map<string, Map<string, ManifestStep[]>>();
  for (const step of manifest.steps) {
    if (step.after.length !== 1) continue;
    const entry = step.after[0]!;
    const handle = afterHandle(entry);
    if (!handle) continue;
    const parent = stepById.get(afterNodeId(entry));
    if (!parent || parent.type !== "branch") continue;
    let byHandle = plan.get(parent.id);
    if (!byHandle) {
      byHandle = new Map();
      plan.set(parent.id, byHandle);
    }
    const list = byHandle.get(handle) ?? [];
    list.push(step);
    byHandle.set(handle, list);
  }
  return plan;
}

/** Every step id that will be rendered nested inside some branch's guard, not flat. */
function collectGuardedStepIds(plan: Map<string, Map<string, ManifestStep[]>>): Set<string> {
  const ids = new Set<string>();
  for (const byHandle of plan.values()) {
    for (const steps of byHandle.values()) {
      for (const s of steps) ids.add(s.id);
    }
  }
  return ids;
}

function safeVarName(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_$]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

function renderStepLine(step: ManifestStep, indent: string, resultVar?: string): string {
  const configJson = JSON.stringify(step.config, null, 2);
  const assignment = resultVar ? `const ${resultVar} = ` : "";
  return `${indent}// step: ${step.id} (${step.type})\n${indent}${assignment}await suede.run(${JSON.stringify(step.type)}, ${configJson});`;
}

/**
 * Render one step. If it's a branch with handle-routed children, its result
 * is captured and the children are nested in an if/else keyed on which
 * handle the branch actually resolved to at runtime -- so the generated
 * code only runs the steps for the branch that was actually taken, instead
 * of running both unconditionally (the pre-existing bug this fixes).
 * Recurses, so a branch nested inside another branch's arm is handled too.
 */
function renderStepAndGuard(
  step: ManifestStep,
  indent: string,
  plan: Map<string, Map<string, ManifestStep[]>>,
): string[] {
  const byHandle = step.type === "branch" ? plan.get(step.id) : undefined;
  if (!byHandle) {
    return [renderStepLine(step, indent)];
  }

  // The gateway's /api/gateway/run route returns this step's raw node
  // outputs unchanged as `output` (src/lib/gateway/run-handler.ts), and the
  // branch executor's outputs are always a single-key object -- { true: value }
  // or { false: value } (src/lib/flow/nodes/branch.ts) -- so the one key
  // present tells us which handle fired.
  const resultVar = `${safeVarName(step.id)}Result`;
  const handleVar = `${safeVarName(step.id)}Handle`;
  const lines: string[] = [renderStepLine(step, indent, resultVar)];
  lines.push(
    `${indent}const ${handleVar} = ${resultVar}.output && typeof ${resultVar}.output === "object" ` +
      `? Object.keys(${resultVar}.output)[0] : undefined;`,
  );

  BRANCH_HANDLES.forEach((handle, i) => {
    lines.push(`${indent}${i === 0 ? "if" : "} else if"} (${handleVar} === ${JSON.stringify(handle)}) {`);
    const children = byHandle.get(handle) ?? [];
    if (children.length === 0) {
      lines.push(`${indent}  // no step is wired to the "${handle}" handle in this flow`);
    } else {
      for (const child of children) {
        lines.push(...renderStepAndGuard(child, `${indent}  `, plan));
      }
    }
  });
  lines.push(`${indent}}`);
  return lines;
}

/**
 * Emit a TypeScript source string for the given manifest.
 * Targets the frozen @suedeai/agents SDK public API (Phase 6):
 *   defineAgent, schedule, paidCall, suede
 * Deterministic: same manifest → byte-identical output.
 * Does NOT typecheck against the package (which doesn't exist yet in Phase 2);
 * snapshot-test the emitted source string instead.
 *
 * Branch routing: a branch step's true/false targets (recorded via
 * step.after's handle field, see schema.ts) are emitted as a runtime
 * if/else keyed on which handle the branch resolved to -- see
 * renderStepAndGuard. Anything codegen can't express that way (a
 * handle-routed step reachable from more than one edge, or a handle-tagged
 * edge whose source isn't a branch, e.g. a loop's "errors" output) is left
 * as a flat, unconditional step, matching prior behavior for that step; it
 * is not silently mis-routed, it simply isn't gated.
 */
export function codegen(manifest: AgentManifest | AgentManifestV2): string {
  if (manifest.manifestVersion === 2) {
    if (graphContainsApiOperation(manifest.graph)) {
      throw new ApiOperationV1UnsupportedError();
    }
    throw new TypeError("Manifest v2 code generation is unsupported without an exact portable SDK surface");
  }
  if (manifest.steps.some((step) => step.type === "api.operation")) {
    throw new ApiOperationV1UnsupportedError();
  }
  const triggerExprs = manifest.triggers.map(triggerExpr).join(",\n    ");
  const versionConstant = renderVersionConstant(manifest);

  const plan = buildBranchGuardPlan(manifest);
  const guarded = collectGuardedStepIds(plan);
  const stepLines = manifest.steps
    .filter((step) => !guarded.has(step.id))
    .flatMap((step) => renderStepAndGuard(step, "    ", plan))
    .join("\n");

  return [
    `import { defineAgent, schedule, paidCall, suede } from "@suedeai/agents";`,
    ``,
    ...(versionConstant === null ? [] : [versionConstant, ``]),
    `export default defineAgent({`,
    `  name: ${JSON.stringify(manifest.name)},`,
    `  description: ${JSON.stringify(manifest.description)},`,
    `  triggers: [`,
    `    ${triggerExprs},`,
    `  ],`,
    `  async run({ input, memory, trigger }) {`,
    stepLines,
    `  },`,
    `});`,
    ``,
  ].join("\n");
}

function renderVersionConstant(manifest: AgentManifest): string | null {
  if (
    manifest.schemaVersion === undefined &&
    manifest.resourceVersion === undefined &&
    manifest.dependencies === undefined
  ) {
    return null;
  }
  const metadata = {
    ...(manifest.schemaVersion === undefined ? {} : { schemaVersion: manifest.schemaVersion }),
    ...(manifest.resourceVersion === undefined
      ? {}
      : { resourceVersion: manifest.resourceVersion }),
    ...(manifest.dependencies === undefined
      ? {}
      : {
          dependencies: [...manifest.dependencies].sort((left, right) => {
            const leftKey = JSON.stringify([
              left.kind,
              left.resourceId,
              left.version,
              left.contentHash ?? null,
            ]);
            const rightKey = JSON.stringify([
              right.kind,
              right.resourceId,
              right.version,
              right.contentHash ?? null,
            ]);
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
          }),
        }),
  };
  return `export const suedeVersion = ${JSON.stringify(canonicalVersionValue(metadata), null, 2)} as const;`;
}

function canonicalVersionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalVersionValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalVersionValue(item)]),
    );
  }
  return value;
}

function triggerExpr(trigger: ManifestTrigger): string {
  switch (trigger.kind) {
    case "schedule":
      return `schedule(${JSON.stringify(trigger.cron)})`;
    case "paidCall":
      return `paidCall(${trigger.priceUsdc})`;
    case "manual":
      return `{ kind: "manual" }`;
    case "webhook":
      return `{ kind: "webhook" }`;
  }
}
