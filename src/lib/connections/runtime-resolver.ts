import type { SecretReference, SecretReferenceResolver } from "../flow/value-bindings";
import type { ConnectionEnvironment } from "./types";
import type { ConnectionRepository } from "./repository";

export const CONNECTION_SECRET_RESOLUTION_ERROR = "Connection headers unavailable";

export interface ConnectionSecretResolverOptions {
  readonly ownerId: string;
  readonly environment: ConnectionEnvironment;
  readonly repository: ConnectionRepository;
}

const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const FORBIDDEN_HEADERS = new Set([
  "__proto__",
  "connection",
  "constructor",
  "cookie",
  "host",
  "keep-alive",
  "prototype",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function unavailable(): never {
  throw new Error(CONNECTION_SECRET_RESOLUTION_ERROR);
}

interface CapturedResolverAuthority {
  readonly ownerId: string;
  readonly environment: ConnectionEnvironment;
  readonly resolveHeaders: ConnectionRepository["resolveHeaders"];
}

function dataMethod(
  repository: ConnectionRepository,
): ConnectionRepository["resolveHeaders"] | null {
  let current: object | null = repository;
  const seen = new Set<object>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, "resolveHeaders");
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
      return descriptor.value.bind(repository) as ConnectionRepository["resolveHeaders"];
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function captureAuthority(value: unknown): CapturedResolverAuthority | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    if (keys.length !== 3 || keys[0] !== "environment" || keys[1] !== "ownerId" || keys[2] !== "repository") {
      return null;
    }
    const owner = descriptors.ownerId;
    const environment = descriptors.environment;
    const repository = descriptors.repository;
    if (!owner || !("value" in owner) || !owner.enumerable ||
        typeof owner.value !== "string" || owner.value.length === 0 ||
        !environment || !("value" in environment) || !environment.enumerable ||
        (environment.value !== "test" && environment.value !== "live") ||
        !repository || !("value" in repository) || !repository.enumerable ||
        repository.value === null || typeof repository.value !== "object") return null;
    const resolveHeaders = dataMethod(repository.value as ConnectionRepository);
    if (!resolveHeaders) return null;
    return Object.freeze({
      ownerId: owner.value,
      environment: environment.value,
      resolveHeaders,
    });
  } catch {
    return null;
  }
}

function exactReference(value: SecretReference): SecretReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return unavailable();
  if (Object.getOwnPropertySymbols(value).length !== 0) return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  if (keys.length !== 2 || keys[0] !== "connectionId" || keys[1] !== "field") return unavailable();
  const connectionId = descriptors.connectionId;
  const field = descriptors.field;
  if (!connectionId || !("value" in connectionId) || !connectionId.enumerable ||
      typeof connectionId.value !== "string" || connectionId.value.length === 0) return unavailable();
  if (!field || !("value" in field) || !field.enumerable ||
      (field.value !== "headers" && field.value !== "webhook")) return unavailable();
  return { connectionId: connectionId.value, field: field.value };
}

function frozenHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return unavailable();
  if (Object.getOwnPropertySymbols(value).length !== 0) return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.length < 1 || names.length > 16) return unavailable();
  const seen = new Set<string>();
  const result = Object.create(null) as Record<string, string>;
  for (const name of names) {
    const descriptor = descriptors[name];
    const folded = name.toLowerCase();
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
        name.length < 1 || name.length > 64 || !HEADER_TOKEN.test(name) ||
        FORBIDDEN_HEADERS.has(folded) || seen.has(folded) ||
        typeof descriptor.value !== "string" || descriptor.value.length === 0 ||
        Buffer.byteLength(descriptor.value, "utf8") > 8_192 || CONTROL_CHARACTER.test(descriptor.value)) {
      return unavailable();
    }
    seen.add(folded);
    result[name] = descriptor.value;
  }
  return Object.freeze(result);
}

function webhookMaterial(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const endpointEntry = Object.entries(headers).find(([name]) =>
    name.toLowerCase() === "x-suede-webhook-url");
  if (!endpointEntry) return unavailable();
  let endpoint: URL;
  try {
    endpoint = new URL(endpointEntry[1]);
  } catch {
    return unavailable();
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash ||
      endpoint.hostname === "localhost" || endpoint.hostname.endsWith(".localhost")) return unavailable();
  const authorizationEntry = Object.entries(headers).find(([name]) =>
    name.toLowerCase() === "authorization");
  const material = Object.create(null) as Record<string, string>;
  material["X-Suede-Webhook-Url"] = endpointEntry[1];
  if (authorizationEntry) material.Authorization = authorizationEntry[1];
  return Object.freeze(material);
}

/** Build an owner/environment-bound semantic resolver for HTTP header bindings. */
export function createConnectionSecretResolver(
  options: ConnectionSecretResolverOptions,
): SecretReferenceResolver {
  const authority = captureAuthority(options);
  return async (reference): Promise<Readonly<Record<string, string>>> => {
    try {
      if (!authority) return unavailable();
      const parsed = exactReference(reference);
      const headers = await authority.resolveHeaders(
        authority.ownerId,
        parsed.connectionId,
        authority.environment,
        "headers",
      );
      const frozen = frozenHeaders(headers);
      return parsed.field === "webhook" ? webhookMaterial(frozen) : frozen;
    } catch {
      return unavailable();
    }
  };
}
