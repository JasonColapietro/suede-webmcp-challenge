import { isFlowGraphV2 } from "./graph-schema";
import { getNodeConnectionSpec, nodeAllowsSecretBinding } from "./node-definitions";
import type {
  FlowNode,
  FlowNodeV2,
  JsonValue,
  SupportedFlowGraph,
  ValueBinding,
} from "./types";

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_STATIC_HTTP_HEADERS = new Set([
  "accept",
  "content-type",
  "user-agent",
  "x-request-id",
]);
const CREDENTIAL_QUERY_KEYS = new Set([
  "subscriptionkey",
  "apikey",
  "token",
  "auth",
  "key",
  "secret",
  "signature",
  "password",
  "credential",
]);

export const HTTP_PUBLICATION_CREDENTIAL_ERROR =
  "HTTP credentials must use an opaque Connection binding before publication.";
export const HTTP_PUBLICATION_CREDENTIAL_CODE = "HTTP_PUBLICATION_CREDENTIAL_REFUSED";

export class HttpPublicationCredentialError extends Error {
  readonly code = HTTP_PUBLICATION_CREDENTIAL_CODE;

  constructor() {
    super(HTTP_PUBLICATION_CREDENTIAL_ERROR);
    this.name = "HttpPublicationCredentialError";
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedCredentialKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function credentialKey(key: string): boolean {
  const normalized = normalizedCredentialKey(key);
  return normalized === "auth" || normalized === "authorization" ||
    normalized.endsWith("authorization") || normalized.includes("credential") ||
    normalized.includes("cookie") || normalized === "password" ||
    normalized.endsWith("password") || normalized.endsWith("passwd") ||
    normalized.includes("passphrase") || normalized.includes("apikey") ||
    normalized === "token" || normalized.endsWith("token") ||
    normalized === "secret" || normalized.endsWith("secret") ||
    normalized.endsWith("accesskey") || normalized.endsWith("clientkey") ||
    normalized.includes("clientsecret") || normalized.includes("privatekey") ||
    normalized.includes("servicerole") || normalized.includes("signingkey");
}

function credentialQueryKey(name: string): boolean {
  if (credentialKey(name) || CREDENTIAL_QUERY_KEYS.has(normalizedCredentialKey(name))) return true;
  return name.toLowerCase().split(/[^a-z0-9]+/u)
    .some((segment) => CREDENTIAL_QUERY_KEYS.has(segment));
}

function credentialString(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]+-----/iu.test(value) ||
    /\b(?:bearer|basic|digest)[\t ]+\S+/iu.test(value) ||
    /(?:service.?role|signing.?(?:secret|key))\s*[:=]\s*\S{4,}/iu.test(value) ||
    /\b(?:sk-|sk_|rk_)[A-Za-z0-9_-]{8,}/u.test(value) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(value) ||
    /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/u.test(value) ||
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(value);
}

function credentialBodyString(value: string): boolean {
  if (credentialString(value)) return true;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (containsCredentialMaterial(parsed)) return true;
  } catch {
    // A non-JSON body may still be form encoded.
  }
  if (value.includes("=")) {
    for (const [name] of new URLSearchParams(value)) {
      if (credentialQueryKey(name)) return true;
    }
  }
  return false;
}

function containsCredentialMaterial(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") return credentialString(value);
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.some((item) => containsCredentialMaterial(item, seen));
    if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) return true;
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key) || credentialKey(key) || containsCredentialMaterial(item, seen)) return true;
    }
    return false;
  } finally {
    seen.delete(value);
  }
}

function headerMapSafe(value: unknown): boolean {
  if (!plainRecord(value)) return false;
  for (const [name, headerValue] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(name) || !SAFE_STATIC_HTTP_HEADERS.has(name.toLowerCase()) ||
        typeof headerValue !== "string" ||
        credentialString(headerValue)) return false;
  }
  return true;
}

function opaqueSecretBinding(binding: ValueBinding): boolean {
  return binding.kind === "secret" && (
    !credentialString(binding.connectionId) &&
    !credentialString(binding.field)
  );
}

function httpBindingSafe(nodeType: string, key: string, binding: ValueBinding): boolean {
  const connection = getNodeConnectionSpec(nodeType as FlowNode["type"], key);
  if (!connection) return binding.kind !== "secret";
  if (binding.kind !== "secret") return false;
  return opaqueSecretBinding(binding) &&
    nodeAllowsSecretBinding(nodeType as FlowNode["type"], key, binding.field);
}

function projectCredentialQueryParams(value: unknown): {
  readonly value: string | null;
  readonly changed: boolean;
} {
  if (typeof value !== "string") return { value: null, changed: true };
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex < 0) return { value, changed: false };

  const base = beforeHash.slice(0, queryIndex);
  const query = beforeHash.slice(queryIndex + 1);
  const safe = new URLSearchParams();
  let changed = false;
  for (const [name, item] of new URLSearchParams(query)) {
    if (credentialQueryKey(name)) {
      changed = true;
      continue;
    }
    safe.append(name, item);
  }
  if (!changed) return { value, changed: false };
  const projected = safe.toString();
  return { value: `${base}${projected ? `?${projected}` : ""}${hash}`, changed: true };
}

function httpParamsSafe(params: Readonly<Record<string, unknown>>): boolean {
  for (const [key, value] of Object.entries(params)) {
    if (UNSAFE_KEYS.has(key) || credentialKey(key)) return false;
    if (key === "headers") {
      if (!headerMapSafe(value)) return false;
      continue;
    }
    if (key === "url" && projectCredentialQueryParams(value).changed) return false;
    if (key === "body" && typeof value === "string" && credentialBodyString(value)) return false;
    if (containsCredentialMaterial(value)) return false;
  }
  return true;
}

/** Publication permits secrets only through an exact node-declared opaque Connection binding. */
export function graphHasSafeHttpPublicationCredentials(graph: SupportedFlowGraph): boolean {
  if (isFlowGraphV2(graph)) {
    for (const edge of graph.edges) {
      if (edge.condition?.kind === "secret") return false;
    }
    for (const node of graph.nodes) {
      for (const [key, binding] of Object.entries(node.bindings)) {
        if (!httpBindingSafe(node.type, key, binding)) return false;
      }
      if (node.type === "http" && !httpParamsSafe(node.params)) return false;
    }
    return true;
  }
  return graph.nodes.every((node) => node.type !== "http" || httpParamsSafe(node.params));
}

export function assertGraphHasSafeHttpPublicationCredentials(graph: SupportedFlowGraph): void {
  if (!graphHasSafeHttpPublicationCredentials(graph)) throw new HttpPublicationCredentialError();
}

function redactHeaders(value: unknown): { readonly value: Readonly<Record<string, string>>; readonly changed: boolean } {
  if (!plainRecord(value)) return { value: Object.freeze({}), changed: true };
  let changed = false;
  const safe: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(name) || !SAFE_STATIC_HTTP_HEADERS.has(name.toLowerCase()) ||
        typeof headerValue !== "string" ||
        credentialString(headerValue)) {
      changed = true;
      continue;
    }
    safe[name] = headerValue;
  }
  return { value: changed ? Object.freeze(safe) : value as Record<string, string>, changed };
}

function redactHttpParams(
  params: Readonly<Record<string, unknown>>,
): { readonly value: Readonly<Record<string, unknown>>; readonly changed: boolean } {
  let changed = false;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (UNSAFE_KEYS.has(key) || credentialKey(key)) {
      changed = true;
      continue;
    }
    if (key === "headers") {
      const redacted = redactHeaders(value);
      safe[key] = redacted.value;
      changed ||= redacted.changed;
      continue;
    }
    if (key === "url") {
      const projected = projectCredentialQueryParams(value);
      if (projected.value !== null) safe[key] = projected.value;
      changed ||= projected.changed;
      continue;
    }
    if (key === "body" && typeof value === "string" && credentialBodyString(value)) {
      changed = true;
      continue;
    }
    if (containsCredentialMaterial(value)) {
      changed = true;
      continue;
    }
    safe[key] = value;
  }
  return { value: changed ? safe : params, changed };
}

function redactBindings(
  node: FlowNodeV2,
): { readonly value: FlowNodeV2["bindings"]; readonly changed: boolean } {
  let changed = false;
  const safe: Record<string, ValueBinding> = {};
  for (const [key, binding] of Object.entries(node.bindings)) {
    if (!httpBindingSafe(node.type, key, binding)) {
      changed = true;
      continue;
    }
    safe[key] = binding;
  }
  return { value: changed ? safe : node.bindings, changed };
}

function projectNode(node: FlowNode | FlowNodeV2): { readonly node: FlowNode | FlowNodeV2; readonly changed: boolean } {
  const params = node.type === "http"
    ? redactHttpParams(node.params)
    : { value: node.params, changed: false };
  if (!("bindings" in node)) {
    return params.changed ? { node: { ...node, params: params.value }, changed: true } : { node, changed: false };
  }
  const bindings = redactBindings(node);
  if (!params.changed && !bindings.changed) return { node, changed: false };
  return {
    node: {
      ...node,
      params: params.value as Readonly<Record<string, JsonValue>>,
      bindings: bindings.value,
    },
    changed: true,
  };
}

/** Return a detached public graph only when redaction is needed; never mutate stored version truth. */
export function projectPublicHttpCredentials(graph: SupportedFlowGraph): SupportedFlowGraph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const projected = projectNode(node);
    changed ||= projected.changed;
    return projected.node;
  });
  let variables = "variables" in graph ? graph.variables : undefined;
  if (isFlowGraphV2(graph)) {
    const redactedVariableIds = new Set(
      graph.nodes.flatMap((node) => {
        const binding = node.type === "http" ? node.bindings.headers : undefined;
        return binding?.kind === "variable" ? [binding.variableId] : [];
      }),
    );
    if (redactedVariableIds.size > 0) {
      variables = graph.variables.map((variable) => {
        if (!redactedVariableIds.has(variable.id) || !Object.hasOwn(variable, "default")) return variable;
        const { default: _default, ...withoutDefault } = variable;
        changed = true;
        return { ...withoutDefault, sensitive: true };
      });
    }
  }
  if (!changed) return graph;
  return { ...graph, nodes, ...(variables ? { variables } : {}) } as SupportedFlowGraph;
}
