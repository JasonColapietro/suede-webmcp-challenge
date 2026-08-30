import type { FlowGraphV2, FlowNodeV2, ValueBinding } from "./types";
import { nodeAllowsSecretBinding } from "./node-definitions";

export interface SecretReference {
  readonly connectionId: string;
  readonly field: string;
}

export type SecretReferenceResolver = (
  reference: SecretReference,
) => unknown | Promise<unknown>;

export interface ValueBindingContext {
  readonly graph: FlowGraphV2;
  readonly outputs: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly runVariables: Readonly<Record<string, unknown>>;
  readonly resolveSecretReference: SecretReferenceResolver;
}

export interface ResolvedNodeBindings {
  readonly values: Readonly<Record<string, unknown>>;
  readonly secretBindingValues: Readonly<Record<string, unknown>>;
}

export type BindingResolution =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

const UNSAFE_POINTER_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function failure(error: string): BindingResolution {
  return { ok: false, error };
}

/** Clone a runtime value or return a label-only failure that cannot expose it. */
export function cloneRuntimeValue(value: unknown, label: string): BindingResolution {
  try {
    return { ok: true, value: structuredClone(value) };
  } catch {
    return failure(`${label} is not safely cloneable`);
  }
}

function cloneResolution(resolution: BindingResolution, label: string): BindingResolution {
  return resolution.ok ? cloneRuntimeValue(resolution.value, label) : resolution;
}

function decodePointerSegment(segment: string): string | null {
  if (UNSAFE_POINTER_SEGMENTS.has(segment) || /~(?![01])/u.test(segment)) return null;
  const decoded = segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
  return UNSAFE_POINTER_SEGMENTS.has(decoded) ? null : decoded;
}

function resolveJsonPointer(value: unknown, pointer: string): BindingResolution {
  if (pointer === "") return { ok: true, value };
  if (!pointer.startsWith("/")) return failure("Binding path must be an RFC 6901 JSON Pointer");

  let current = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (segment === null) return failure("Binding path contains an unsafe or malformed segment");

    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) {
        return failure(`Binding path segment "${segment}" is not a valid array index`);
      }
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        return failure(`Binding path array index "${segment}" does not exist`);
      }
      current = current[index];
      continue;
    }

    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return failure(`Binding path segment "${segment}" does not exist`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { ok: true, value: current };
}

function withPath(value: unknown, path: string | undefined): BindingResolution {
  return path === undefined ? { ok: true, value } : resolveJsonPointer(value, path);
}

export async function resolveValueBinding(
  binding: ValueBinding,
  context: ValueBindingContext,
): Promise<BindingResolution> {
  switch (binding.kind) {
    case "literal":
      return cloneRuntimeValue(binding.value, "Literal binding value");
    case "port": {
      if (!context.graph.nodes.some((node) => node.id === binding.nodeId)) {
        return failure(`Binding source node "${binding.nodeId}" does not exist`);
      }
      const nodeOutputs = context.outputs.get(binding.nodeId);
      if (!nodeOutputs || !Object.hasOwn(nodeOutputs, binding.portId)) {
        return failure(`Binding source "${binding.nodeId}" has no resolved port "${binding.portId}"`);
      }
      return cloneResolution(
        withPath(nodeOutputs[binding.portId], binding.path),
        `Port binding "${binding.nodeId}.${binding.portId}" value`,
      );
    }
    case "variable": {
      const variable = context.graph.variables.find((candidate) => candidate.id === binding.variableId);
      if (!variable) return failure(`Binding variable "${binding.variableId}" does not exist`);

      if (Object.hasOwn(context.runVariables, binding.variableId)) {
        const override = context.runVariables[binding.variableId];
        if (override === undefined) {
          return failure(`Binding variable "${binding.variableId}" has no run value`);
        }
        return cloneResolution(
          withPath(override, binding.path),
          `Run variable "${binding.variableId}" value`,
        );
      }
      if (variable.sensitive === true) {
        return failure(`Sensitive variable "${binding.variableId}" requires a run value`);
      }
      if (!Object.hasOwn(variable, "default")) {
        return failure(`Binding variable "${binding.variableId}" has no run value or workflow default`);
      }
      return cloneResolution(
        withPath(variable.default, binding.path),
        `Workflow variable "${binding.variableId}" default`,
      );
    }
    case "secret": {
      const reference = { connectionId: binding.connectionId, field: binding.field };
      try {
        const value = await context.resolveSecretReference(reference);
        const cloned = cloneRuntimeValue(value, "Secret reference value");
        return cloned.ok
          ? cloned
          : failure(
            `Secret reference "${binding.connectionId}" field "${binding.field}" could not be safely resolved`,
          );
      } catch {
        return failure(
          `Secret reference "${binding.connectionId}" field "${binding.field}" could not be resolved`,
        );
      }
    }
  }
}

export async function resolveNodeBindings(
  node: FlowNodeV2,
  context: ValueBindingContext,
): Promise<ResolvedNodeBindings> {
  const values: Record<string, unknown> = Object.create(null);
  const secretBindingValues: Record<string, unknown> = Object.create(null);
  for (const [key, binding] of Object.entries(node.bindings)) {
    if (binding.kind === "secret" && !nodeAllowsSecretBinding(node.type, key, binding.field)) {
      throw new Error("Secret binding is not declared for this node field");
    }
    const result = await resolveValueBinding(binding, context);
    if (!result.ok) throw new Error(`Binding "${key}" failed: ${result.error}`);
    if (binding.kind === "secret") {
      secretBindingValues[key] = result.value;
    } else {
      values[key] = result.value;
    }
  }
  return {
    values: Object.freeze(values),
    secretBindingValues: Object.freeze(secretBindingValues),
  };
}
