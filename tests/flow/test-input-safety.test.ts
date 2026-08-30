import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEST_INPUT_LIMITS,
  inspectTestInput,
  type TestInputSafetyOptions,
} from "@/lib/flow/test-input-safety";

function expectFailure(
  value: unknown,
  code: "invalid-json" | "limit-exceeded" | "credential-material",
  options?: TestInputSafetyOptions,
): void {
  expect(inspectTestInput(value, options)).toMatchObject({ ok: false, code });
}

describe("test input structural safety", () => {
  it("uses strict request-safe defaults and counts exact UTF-8 JSON bytes", () => {
    expect(DEFAULT_TEST_INPUT_LIMITS).toEqual({
      maxBytes: 512 * 1024,
      maxDepth: 32,
      maxValues: 20_000,
    });
    const value = { emoji: "😀", values: [false, null, 3] };
    const result = inspectTestInput(value);
    expect(result).toEqual({
      ok: true,
      encodedBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
      valueCount: 6,
      maxDepth: 2,
    });
  });

  it("supports tighter per-pin byte, depth, and value limits with inclusive boundaries", () => {
    const value = { nested: { value: true } };
    const encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(inspectTestInput(value, {
      limits: { maxBytes: encodedBytes, maxDepth: 2, maxValues: 3 },
    }).ok).toBe(true);
    expectFailure(value, "limit-exceeded", { limits: { maxBytes: encodedBytes - 1 } });
    expectFailure(value, "limit-exceeded", { limits: { maxDepth: 1 } });
    expectFailure(value, "limit-exceeded", { limits: { maxValues: 2 } });
  });

  it("classifies a dense array over the configured value count as a limit failure", () => {
    expectFailure([1, 2, 3, 4], "limit-exceeded", { limits: { maxValues: 3 } });
  });

  it("enforces byte limits before scanning oversized credential-shaped content", () => {
    expectFailure({ value: `Bearer ${"x".repeat(100)}` }, "limit-exceeded", {
      limits: { maxBytes: 32 },
    });
    expectFailure({ authorization: "placeholder" }, "limit-exceeded", {
      limits: { maxBytes: 2 },
    });
  });

  it("fails closed for invalid configured limits", () => {
    expectFailure("safe", "limit-exceeded", { limits: { maxBytes: -1 } });
    expectFailure("safe", "limit-exceeded", { limits: { maxDepth: 1.5 } });
    expectFailure("safe", "limit-exceeded", { limits: { maxValues: Number.POSITIVE_INFINITY } });
  });

  it("rejects non-JSON primitives, non-finite numbers, cycles, and exotic prototypes", () => {
    for (const value of [undefined, 1n, Symbol("x"), () => undefined, NaN, Infinity, new Date()]) {
      expectFailure(value, "invalid-json");
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectFailure(cyclic, "invalid-json");
  });

  it("fails closed instead of throwing when hostile reflection traps run", () => {
    const hostile = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("do-not-echo-proxy-trap");
      },
    });
    expect(() => inspectTestInput(hostile)).not.toThrow();
    const result = inspectTestInput(hostile);
    expect(result).toMatchObject({ ok: false, code: "invalid-json" });
    expect(JSON.stringify(result)).not.toContain("do-not-echo-proxy-trap");
  });

  it("accepts repeated acyclic references while counting each encoded occurrence", () => {
    const shared = { safe: true };
    const value = { left: shared, right: shared };
    const result = inspectTestInput(value);
    expect(result).toMatchObject({ ok: true, valueCount: 5 });
    if (result.ok) {
      expect(result.encodedBytes).toBe(new TextEncoder().encode(JSON.stringify(value)).byteLength);
    }
  });

  it("rejects sparse or decorated arrays and accessor, hidden, symbol, or unsafe object keys", () => {
    const sparse = Array(2);
    sparse[1] = "present";
    const decorated = ["safe"] as unknown[] & { extra?: string };
    decorated.extra = "no";
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => "no" });
    const hidden = Object.defineProperty({}, "value", { enumerable: false, value: "no" });
    const symbolic = { safe: true, [Symbol("hidden")]: "no" };
    const unsafe = Object.create(null) as Record<string, unknown>;
    unsafe.__proto__ = "no";
    for (const value of [sparse, decorated, accessor, hidden, symbolic, unsafe]) {
      expectFailure(value, "invalid-json");
    }
    for (const key of ["prototype", "constructor"]) {
      const value = Object.create(null) as Record<string, unknown>;
      value[key] = "no";
      expectFailure(value, "invalid-json");
    }
  });

  it("does not mutate frozen input while inspecting it", () => {
    const value = Object.freeze({ nested: Object.freeze(["safe", 1, false]) });
    const before = JSON.stringify(value);
    expect(inspectTestInput(value).ok).toBe(true);
    expect(JSON.stringify(value)).toBe(before);
  });
});

describe("test input credential safety", () => {
  it("scans near-limit benign text and embedded sensitive URLs in bounded time", () => {
    const benign = "x".repeat(60 * 1024);
    const sensitiveUrl = "https://alice:supersecret@example.com/path?access_token=abc123#token=def456";
    const adversarial = `${"a".repeat(60 * 1024 - sensitiveUrl.length - 1)} ${sensitiveUrl}`;
    const startedAt = performance.now();

    expect(inspectTestInput(benign)).toMatchObject({ ok: true });
    expect(inspectTestInput(adversarial)).toMatchObject({
      ok: false,
      code: "credential-material",
    });

    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });

  it.each([
    "https://example.com,https://alice:supersecret@example.com/path",
    "invalid://%,https://example.com/path?access_token=abc123",
    `${"a".repeat(96)}://alice:supersecret@example.com/path`,
  ])("checks every URL marker in a token and arbitrary-length valid schemes: %s", (value) => {
    expect(inspectTestInput({ value })).toMatchObject({
      ok: false,
      code: "credential-material",
    });
  });

  it("fails closed when text contains an excessive number of URL separators", () => {
    const value = Array.from({ length: 65 }, (_, index) => `scheme${index}://example.com`).join(" ");
    expect(inspectTestInput({ value })).toMatchObject({
      ok: false,
      code: "credential-material",
    });
  });

  it.each([
    "authorization",
    "proxy-authorization",
    "set_cookie",
    "password",
    "dbPasswd",
    "wallet_passphrase",
    "api-key",
    "accessToken",
    "refresh_token",
    "client_secret",
    "clientSecretValue",
    "secretKey",
    "clientSecretKey",
    "apiSecretKey",
    "consumerSecretKey",
    "secretKeys",
    "apiKeys",
    "accessTokens",
    "refreshTokens",
    "clientSecrets",
    "consumerSecrets",
    "secrets",
    "authTokens",
    "sessionTokens",
    "bearerTokens",
    "idTokens",
    "oauthTokens",
    "apiTokens",
    "serviceCredential",
    "aws_secret_access_key",
    "privateKey",
    "service_role",
    "signing-key",
  ])("rejects normalized credential key %s", (key) => {
    expectFailure({ [key]: "placeholder" }, "credential-material");
  });

  it.each([
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    "Bearer abc123",
    "Basic YTpi",
    "Basic dXNlcjpwYXNzd29yZA==",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    "https://alice:supersecret@example.com/path",
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    ["sk", "live", "TestFixtureOnlyNotASecret1234567890"].join("_"),
    ["xoxb", "test-fixture-only-not-a-secret"].join("-"),
    "AIzaSyD-abcdefghijklmnopqrstuvwxyz12345",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "sk-abcdefghijklmnopqrstuvwxyz1234567890",
    "ASIAIOSFODNN7EXAMPLE",
    ["rk", "live", "TestFixtureOnlyNotASecret1234567890"].join("_"),
    "whsec_abcdefghijklmnopqrstuvwxyz",
    "glpat-abcdefghijklmnopqrstuvwxyz",
    "npm_abcdefghijklmnopqrstuvwxyz",
    "pypi-AgEIcHlwaS5vcmcabcdefghijklmnopqrstuvwxyz",
    "SG.abcdefghijklmnop.qrstuvwxyz123456",
    "service_role=abcdefghijklmnopqrstuvwxyz",
    "signing-secret: abcdefghijklmnopqrstuvwxyz",
  ])("rejects credential-shaped string without echoing it: %s", (credential) => {
    const result = inspectTestInput({ value: credential });
    expect(result).toMatchObject({ ok: false, code: "credential-material" });
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it.each([
    "https://example.com/callback?access_token=abc123",
    "Callback: https://example.com/callback?access_token=abc123",
    "https://example.com/callback#access_token=abc123&token_type=Bearer",
    "https://example.com/callback?api_key=abc123",
    "https://example.com/callback?client_secret=abc123",
    "https://example.com/callback?X-Amz-Signature=abc123",
    "https://example.com/callback?key=abcdefghijklmnopqrstuvwxyz123456",
  ])("rejects URLs with sensitive query names: %s", (url) => {
    expectFailure({ url }, "credential-material");
  });

  it("accepts benign hashes, UUIDs, ordinary URLs, prose, and similar non-credential keys", () => {
    const value = {
      semanticHash: "a".repeat(64),
      id: "123e4567-e89b-12d3-a456-426614174000",
      url: "https://example.com/callback?tokenCount=2&signatureVersion=4",
      sortUrl: "https://example.com/items?key=sort",
      longUrl: "https://longlabel.examplelabel.anotherlabel/path",
      note: "Use Bearer authentication or Basic authentication when configuring the provider.",
      tokenCount: 42,
      secretary: "Ada",
      secretaryKey: "filing",
      secretKeyCount: 2,
      publicKey: "documented identifier",
      designTokens: ["space-2", "color-brand"],
      controlTokens: ["pause", "resume"],
      colorTokens: ["indigo-600"],
    };
    expect(inspectTestInput(value).ok).toBe(true);
  });

  it("accepts public PEM data while continuing to reject private-key PEM", () => {
    expect(inspectTestInput({ pem: "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----" }).ok).toBe(true);
    expect(inspectTestInput({ pem: "-----BEGIN PUBLIC KEY-----\nYWJj\n-----END PUBLIC KEY-----" }).ok).toBe(true);
    expectFailure({ pem: "-----BEGIN OPENSSH PRIVATE KEY-----\nYWJj\n-----END OPENSSH PRIVATE KEY-----" }, "credential-material");
  });

  it("rejects secret-reference-shaped pinned values by default", () => {
    expectFailure({
      kind: "secret",
      connectionId: "123e4567-e89b-12d3-a456-426614174000",
      field: "token",
    }, "credential-material");
  });

  it("accepts an exact safe graph secret reference only at an explicitly exempted binding path", () => {
    const reference = {
      kind: "secret",
      connectionId: "123e4567-e89b-12d3-a456-426614174000",
      field: "token",
    };
    const value = { graph: { nodes: [{ bindings: { apiKey: reference } }] } };
    expect(inspectTestInput(value, {
      allowGraphSecretReferenceAt: (path) => path.join("/") === "graph/nodes/0/bindings/apiKey",
    }).ok).toBe(true);
    expectFailure(value, "credential-material", {
      allowGraphSecretReferenceAt: () => false,
    });
  });

  it("rejects malformed or credential-bearing references even at an exempted path", () => {
    const options: TestInputSafetyOptions = { allowGraphSecretReferenceAt: () => true };
    for (const value of [
      { kind: "secret", connectionId: "connection" },
      { kind: "secret", connectionId: "connection", field: "token", extra: true },
      { kind: "secret", connectionId: "Bearer abcdefghijklmnop", field: "token" },
    ]) {
      expectFailure(value, "credential-material", options);
    }
  });
});
