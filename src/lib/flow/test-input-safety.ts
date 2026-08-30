export interface TestInputSafetyLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxValues: number;
}

export const DEFAULT_TEST_INPUT_LIMITS: TestInputSafetyLimits = Object.freeze({
  maxBytes: 512 * 1024,
  maxDepth: 32,
  maxValues: 20_000,
});

export type TestInputPath = readonly (string | number)[];

export interface TestInputSafetyOptions {
  readonly limits?: Partial<TestInputSafetyLimits>;
  /** Permit an exact opaque graph secret reference only at a trusted binding path. */
  readonly allowGraphSecretReferenceAt?: (path: TestInputPath) => boolean;
}

export type TestInputSafetyResult =
  | {
      readonly ok: true;
      readonly encodedBytes: number;
      readonly valueCount: number;
      readonly maxDepth: number;
    }
  | {
      readonly ok: false;
      readonly code: "invalid-json" | "limit-exceeded" | "credential-material";
      readonly message: "Test input is invalid." | "Test input exceeds safety limits." | "Test input contains credential material.";
    };

const INVALID_JSON = Object.freeze({
  ok: false,
  code: "invalid-json",
  message: "Test input is invalid.",
} as const);
const LIMIT_EXCEEDED = Object.freeze({
  ok: false,
  code: "limit-exceeded",
  message: "Test input exceeds safety limits.",
} as const);
const CREDENTIAL_MATERIAL = Object.freeze({
  ok: false,
  code: "credential-material",
  message: "Test input contains credential material.",
} as const);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TEXT_ENCODER = new TextEncoder();

interface EnterFrame {
  readonly kind: "enter";
  readonly value: unknown;
  readonly depth: number;
  readonly path: TestInputPath;
}

interface LeaveFrame {
  readonly kind: "leave";
  readonly value: object;
}

type Frame = EnterFrame | LeaveFrame;

type SecretReferenceClassification = "not-secret" | "safe" | "malformed";

function encodedStringBytes(value: string): number {
  return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function normalizedCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return normalized === "authorization" ||
    normalized.endsWith("authorization") ||
    normalized === "cookie" ||
    normalized.endsWith("cookie") ||
    normalized === "setcookie" ||
    normalized === "password" ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("passphrase") ||
    normalized === "apikey" ||
    normalized.endsWith("apikey") ||
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized === "credential" ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized === "secret" ||
    normalized.endsWith("secret") ||
    normalized.includes("secretaccesskey") ||
    normalized.includes("privatekey") ||
    normalized.includes("servicerole") ||
    normalized.includes("signingkey") ||
    /(?:password|passwd|passphrase|apikey|token|secret|privatekey|servicerole|signingkey|credential)s?(?:value|field|text|data|input|raw|key)$/u.test(normalized) ||
    /(?:passwords|passphrases|apikeys|secretkeys|(?:client|consumer|api)secrets)$/u.test(normalized) ||
    normalized === "secrets" ||
    /^(?:access|refresh|auth|session|bearer|id|oauth|api)tokens$/u.test(normalized);
}

function likelySecretQueryValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.length >= 16 &&
    /^[A-Za-z0-9._~+/-]+={0,2}$/u.test(normalized) &&
    /[A-Za-z]/u.test(normalized) &&
    /[0-9]/u.test(normalized);
}

function sensitiveQueryValue(key: string, value: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return normalizedCredentialKey(key) ||
    normalized === "sig" ||
    normalized === "signature" ||
    normalized === "xamzsignature" ||
    (normalized === "key" && likelySecretQueryValue(value));
}

function hasCredentialAuthorization(value: string): boolean {
  const bearer = /\bbearer\s+([^\s,;]+)/giu;
  for (const match of value.matchAll(bearer)) {
    const candidate = match[1] ?? "";
    if (
      !["auth", "authentication", "authorization", "credential", "credentials", "header", "scheme", "token"].includes(candidate.toLowerCase()) &&
      candidate.length >= 4
    ) {
      return true;
    }
  }
  const basic = /\bbasic\s+([a-z0-9+/]+={0,2})/giu;
  for (const match of value.matchAll(basic)) {
    const candidate = match[1] ?? "";
    try {
      if (candidate.length >= 4 && atob(candidate).includes(":")) return true;
    } catch {
      // A malformed base64 word is prose, not a Basic credential.
    }
  }
  return false;
}

function asciiAlpha(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function urlSchemeCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return asciiAlpha(character) || (code >= 48 && code <= 57) ||
    character === "+" || character === "." || character === "-";
}

function urlCandidateStop(character: string): boolean {
  return /\s/u.test(character) || character === "<" || character === ">" ||
    character === '"' || character === "'";
}

function urlSchemeStart(value: string, separatorIndex: number): number {
  let start = separatorIndex - 1;
  while (start >= 0 && urlSchemeCharacter(value[start]!)) {
    start -= 1;
  }
  const schemeStart = start + 1;
  if (schemeStart === separatorIndex || !asciiAlpha(value[schemeStart]!)) return -1;
  return schemeStart;
}

function hasSensitiveUrl(value: string): boolean {
  let searchFrom = 0;
  let separatorCount = 0;
  while (searchFrom < value.length) {
    const separatorIndex = value.indexOf("://", searchFrom);
    if (separatorIndex < 0) return false;
    separatorCount += 1;
    if (separatorCount > 64) return true;
    const schemeStart = urlSchemeStart(value, separatorIndex);
    if (schemeStart < 0) {
      searchFrom = separatorIndex + 3;
      continue;
    }
    let candidateEnd = separatorIndex + 3;
    while (candidateEnd < value.length && !urlCandidateStop(value[candidateEnd]!)) {
      candidateEnd += 1;
    }
    const candidate = value.slice(schemeStart, candidateEnd);
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      searchFrom = separatorIndex + 3;
      continue;
    }
    if (url.username.length > 0 || url.password.length > 0) return true;
    const parameterSets = [
      url.searchParams,
      new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash),
    ];
    for (const parameters of parameterSets) {
      for (const [key, queryValue] of parameters) {
        if (queryValue.length > 0 && sensitiveQueryValue(key, queryValue)) return true;
      }
    }
    searchFrom = separatorIndex + 3;
  }
  return false;
}

function credentialString(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/iu.test(value) ||
    hasCredentialAuthorization(value) ||
    /\beyJ[a-z0-9_-]{5,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/iu.test(value) ||
    /\bAKIA[A-Z0-9]{16}\b/u.test(value) ||
    /\bASIA[A-Z0-9]{16}\b/u.test(value) ||
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u.test(value) ||
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u.test(value) ||
    /\bsk_live_[A-Za-z0-9]{16,}\b/u.test(value) ||
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u.test(value) ||
    /\bAIza[A-Za-z0-9_-]{20,}\b/u.test(value) ||
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u.test(value) ||
    /\bsk-proj-[A-Za-z0-9_-]{20,}\b/u.test(value) ||
    /\bsk-[A-Za-z0-9_-]{24,}\b/u.test(value) ||
    /\brk_live_[A-Za-z0-9]{16,}\b/u.test(value) ||
    /\bwhsec_[A-Za-z0-9]{16,}\b/u.test(value) ||
    /\bglpat-[A-Za-z0-9_-]{20,}\b/u.test(value) ||
    /\bnpm_[A-Za-z0-9]{20,}\b/u.test(value) ||
    /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{16,}\b/u.test(value) ||
    /\bSG\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/u.test(value) ||
    /(?:service.?role|signing.?(?:secret|key))\s*[:=]\s*[^\s,;]{8,}/iu.test(value) ||
    hasSensitiveUrl(value);
}

function plainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataDescriptors(value: object): Record<string, PropertyDescriptor> | null {
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    if (!("value" in descriptor) || descriptor.enumerable !== true) return null;
  }
  return descriptors;
}

function classifySecretReference(value: unknown): SecretReferenceClassification {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !plainObject(value)) {
    return "not-secret";
  }
  const descriptors = dataDescriptors(value);
  if (!descriptors || descriptors.kind?.value !== "secret") return "not-secret";
  const keys = Object.keys(descriptors);
  if (keys.length !== 3 || !keys.every((key) => ["kind", "connectionId", "field"].includes(key))) {
    return "malformed";
  }
  const connectionId = descriptors.connectionId?.value;
  const field = descriptors.field?.value;
  if (
    typeof connectionId !== "string" || connectionId.trim().length === 0 || credentialString(connectionId) ||
    typeof field !== "string" || field.trim().length === 0 || credentialString(field)
  ) {
    return "malformed";
  }
  return "safe";
}

function limitsFrom(options: TestInputSafetyOptions): TestInputSafetyLimits | null {
  const limits = { ...DEFAULT_TEST_INPUT_LIMITS, ...options.limits };
  return Object.values(limits).every((value) => Number.isSafeInteger(value) && value >= 0)
    ? limits
    : null;
}

/** Inspect untrusted test input without cloning, normalizing, logging, or echoing it. */
function inspectTestInputUnchecked(
  value: unknown,
  options: TestInputSafetyOptions = {},
): TestInputSafetyResult {
  const limits = limitsFrom(options);
  if (!limits) return LIMIT_EXCEEDED;

  const active = new WeakSet<object>();
  const stack: Frame[] = [{ kind: "enter", value, depth: 0, path: [] }];
  let encodedBytes = 0;
  let valueCount = 0;
  let observedDepth = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "leave") {
      active.delete(frame.value);
      continue;
    }

    valueCount += 1;
    observedDepth = Math.max(observedDepth, frame.depth);
    if (valueCount > limits.maxValues || frame.depth > limits.maxDepth) return LIMIT_EXCEEDED;

    if (frame.value === null) {
      encodedBytes += 4;
    } else if (typeof frame.value === "boolean") {
      encodedBytes += frame.value ? 4 : 5;
    } else if (typeof frame.value === "number") {
      if (!Number.isFinite(frame.value)) return INVALID_JSON;
      encodedBytes += String(frame.value).length;
    } else if (typeof frame.value === "string") {
      if (frame.value.length + 2 > limits.maxBytes - encodedBytes) return LIMIT_EXCEEDED;
      encodedBytes += encodedStringBytes(frame.value);
      if (encodedBytes > limits.maxBytes) return LIMIT_EXCEEDED;
      if (credentialString(frame.value)) return CREDENTIAL_MATERIAL;
    } else if (typeof frame.value !== "object") {
      return INVALID_JSON;
    } else {
      const object = frame.value;
      if (active.has(object)) return INVALID_JSON;
      const array = Array.isArray(object);
      if (array ? Object.getPrototypeOf(object) !== Array.prototype : !plainObject(object)) {
        return INVALID_JSON;
      }
      const descriptors = dataDescriptors(object);
      if (!descriptors) return INVALID_JSON;
      const secretReference = classifySecretReference(object);
      if (secretReference !== "not-secret") {
        if (
          secretReference === "malformed" ||
          options.allowGraphSecretReferenceAt?.(frame.path) !== true
        ) {
          return CREDENTIAL_MATERIAL;
        }
      }

      active.add(object);
      stack.push({ kind: "leave", value: object });
      encodedBytes += 2;
      if (encodedBytes > limits.maxBytes) return LIMIT_EXCEEDED;

      if (array) {
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || length < 0) return INVALID_JSON;
        if (length > limits.maxValues) return LIMIT_EXCEEDED;
        const ownNames = Object.keys(descriptors).filter((key) => key !== "length");
        if (ownNames.length !== length) return INVALID_JSON;
        encodedBytes += Math.max(0, length - 1);
        if (encodedBytes > limits.maxBytes) return LIMIT_EXCEEDED;
        for (let index = length - 1; index >= 0; index -= 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor)) return INVALID_JSON;
          stack.push({
            kind: "enter",
            value: descriptor.value,
            depth: frame.depth + 1,
            path: [...frame.path, index],
          });
        }
      } else {
        const entries = Object.entries(descriptors);
        encodedBytes += Math.max(0, entries.length - 1);
        if (encodedBytes > limits.maxBytes) return LIMIT_EXCEEDED;
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const [key, descriptor] = entries[index]!;
          if (UNSAFE_KEYS.has(key)) return INVALID_JSON;
          const childPath = [...frame.path, key];
          if (key.length + 3 > limits.maxBytes - encodedBytes) return LIMIT_EXCEEDED;
          encodedBytes += encodedStringBytes(key) + 1;
          if (encodedBytes > limits.maxBytes) return LIMIT_EXCEEDED;
          if (normalizedCredentialKey(key)) {
            const childSecret = classifySecretReference(descriptor.value);
            if (
              childSecret !== "safe" ||
              options.allowGraphSecretReferenceAt?.(childPath) !== true
            ) {
              return CREDENTIAL_MATERIAL;
            }
          }
          stack.push({
            kind: "enter",
            value: descriptor.value,
            depth: frame.depth + 1,
            path: childPath,
          });
        }
      }
    }

    if (encodedBytes > limits.maxBytes) return LIMIT_EXCEEDED;
  }

  return { ok: true, encodedBytes, valueCount, maxDepth: observedDepth };
}

export function inspectTestInput(
  value: unknown,
  options: TestInputSafetyOptions = {},
): TestInputSafetyResult {
  try {
    return inspectTestInputUnchecked(value, options);
  } catch {
    return INVALID_JSON;
  }
}
