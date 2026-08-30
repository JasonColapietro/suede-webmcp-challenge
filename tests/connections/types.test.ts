import { describe, expect, it } from "vitest";
import {
  CONNECTION_INPUT_ERROR,
  normalizeConnectionSecret,
  parseConnectionCreateInput,
  parseConnectionSecretInput,
  parseConnectionView,
} from "@/lib/connections/types";

const expectInvalid = (value: unknown, parse: (input: unknown) => unknown): void => {
  expect(() => parse(value)).toThrowError(CONNECTION_INPUT_ERROR);
};

describe("static connection contracts", () => {
  it("parses and freezes secret-free creation metadata for every kind", () => {
    const apiKey = parseConnectionCreateInput({
      name: "Production API",
      kind: "api_key",
      publicConfig: { headerName: "X-Api-Key" },
    });
    const bearer = parseConnectionCreateInput({ name: "Bearer", kind: "bearer", publicConfig: {} });
    const basic = parseConnectionCreateInput({ name: "Basic", kind: "basic", publicConfig: {} });
    const custom = parseConnectionCreateInput({
      name: "Custom",
      kind: "custom_headers",
      publicConfig: { headerNames: ["X-Tenant", "X-Signature"] },
    });

    expect(apiKey.publicConfig).toEqual({ headerName: "X-Api-Key" });
    expect(bearer.publicConfig).toEqual({});
    expect(basic.publicConfig).toEqual({});
    if (custom.kind !== "custom_headers") throw new Error("expected custom headers");
    expect(custom.publicConfig).toEqual({ headerNames: ["X-Tenant", "X-Signature"] });
    expect(Object.isFrozen(custom)).toBe(true);
    expect(Object.isFrozen(custom.publicConfig)).toBe(true);
    expect(Object.isFrozen(custom.publicConfig.headerNames)).toBe(true);
  });

  it("normalizes all four authentication kinds to exact frozen headers", () => {
    expect(normalizeConnectionSecret(
      { name: "API", kind: "api_key", publicConfig: { headerName: "X-Key" } },
      { kind: "api_key", apiKey: "a{{literal}}b" },
    )).toEqual({ "X-Key": "a{{literal}}b" });
    expect(normalizeConnectionSecret(
      { name: "Bearer", kind: "bearer", publicConfig: {} },
      { kind: "bearer", token: "tok" },
    )).toEqual({ Authorization: "Bearer tok" });
    expect(normalizeConnectionSecret(
      { name: "Basic", kind: "basic", publicConfig: {} },
      { kind: "basic", username: "aladdin", password: "open sesame" },
    )).toEqual({ Authorization: `Basic ${Buffer.from("aladdin:open sesame").toString("base64")}` });
    const custom = normalizeConnectionSecret(
      { name: "Custom", kind: "custom_headers", publicConfig: { headerNames: ["X-One", "X-Two"] } },
      { kind: "custom_headers", values: { "X-Two": "2", "X-One": "1" } },
    );
    expect(custom).toEqual({ "X-One": "1", "X-Two": "2" });
    expect(Object.isFrozen(custom)).toBe(true);
  });

  it("preserves action-specific webhook material in the existing custom-header envelope", () => {
    const create = parseConnectionCreateInput({
      name: "CRM webhook",
      kind: "custom_headers",
      publicConfig: { headerNames: ["Authorization", "X-Suede-Webhook-Url"] },
    });
    const secret = parseConnectionSecretInput({
      kind: "custom_headers",
      values: {
        Authorization: "Bearer crm-token",
        "X-Suede-Webhook-Url": "https://hooks.example.com/incoming/opaque-path?tenant=1",
      },
    });

    expect(normalizeConnectionSecret(create, secret)).toEqual({
      Authorization: "Bearer crm-token",
      "X-Suede-Webhook-Url": "https://hooks.example.com/incoming/opaque-path?tenant=1",
    });
  });

  it("requires exact own data properties and safe prototypes", () => {
    expectInvalid({ name: "x", kind: "bearer", publicConfig: {}, extra: true }, parseConnectionCreateInput);
    expectInvalid({ kind: "bearer", token: "x", extra: true }, parseConnectionSecretInput);
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "kind", { enumerable: true, get: () => "bearer" });
    Object.defineProperty(accessor, "token", { enumerable: true, value: "secret" });
    expectInvalid(accessor, parseConnectionSecretInput);
    expectInvalid(Object.assign(Object.create({ inherited: true }), { kind: "bearer", token: "x" }), parseConnectionSecretInput);
    const symbol = { kind: "bearer", token: "x" } as Record<PropertyKey, unknown>;
    symbol[Symbol("secret")] = "no";
    expectInvalid(symbol, parseConnectionSecretInput);
  });

  it("enforces name, ID, header, value, count, and aggregate byte bounds", () => {
    expect(parseConnectionCreateInput({ name: "é".repeat(60), kind: "bearer", publicConfig: {} }).name).toHaveLength(60);
    expectInvalid({ name: "é".repeat(61), kind: "bearer", publicConfig: {} }, parseConnectionCreateInput);
    expectInvalid({ name: " padded ", kind: "bearer", publicConfig: {} }, parseConnectionCreateInput);
    expectInvalid({ name: "x", kind: "api_key", publicConfig: { headerName: "x".repeat(65) } }, parseConnectionCreateInput);
    expectInvalid({ name: "x", kind: "api_key", publicConfig: { headerName: "bad header" } }, parseConnectionCreateInput);
    expectInvalid({ name: "x", kind: "custom_headers", publicConfig: { headerNames: Array.from({ length: 17 }, (_, i) => `X-${i}`) } }, parseConnectionCreateInput);
    expectInvalid({ kind: "bearer", token: "x".repeat(8_193) }, parseConnectionSecretInput);
    expectInvalid({ kind: "custom_headers", values: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`X-${i}`, "v".repeat(2_100)])) }, parseConnectionSecretInput);
  });

  it("rejects unsafe, duplicate, and forbidden caller-supplied header names", () => {
    for (const headerName of ["Host", "cookie", "Set-Cookie", "Connection", "Transfer-Encoding", "TE", "Upgrade"]) {
      expectInvalid({ name: "x", kind: "api_key", publicConfig: { headerName } }, parseConnectionCreateInput);
    }
    expectInvalid({ name: "x", kind: "custom_headers", publicConfig: { headerNames: ["X-Key", "x-key"] } }, parseConnectionCreateInput);
    expectInvalid({ kind: "custom_headers", values: Object.assign(Object.create(null), { __proto__: "x" }) }, parseConnectionSecretInput);
  });

  it("rejects empty or unsafe secret material and kind/config mismatches", () => {
    expectInvalid({ kind: "bearer", token: "" }, parseConnectionSecretInput);
    expectInvalid({ kind: "bearer", token: "line\nbreak" }, parseConnectionSecretInput);
    expectInvalid({ kind: "basic", username: "a:b", password: "p" }, parseConnectionSecretInput);
    expectInvalid({ kind: "basic", username: "", password: "p" }, parseConnectionSecretInput);
    expect(() => normalizeConnectionSecret(
      { name: "Bearer", kind: "bearer", publicConfig: {} },
      { kind: "api_key", apiKey: "x" },
    )).toThrowError(CONNECTION_INPUT_ERROR);
    expect(() => normalizeConnectionSecret(
      { name: "Custom", kind: "custom_headers", publicConfig: { headerNames: ["X-A"] } },
      { kind: "custom_headers", values: { "X-B": "x" } },
    )).toThrowError(CONNECTION_INPUT_ERROR);
    expect(() => normalizeConnectionSecret(
      { name: "Custom", kind: "custom_headers", publicConfig: { headerNames: ["X-A"] } },
      { kind: "custom_headers", values: { "x-a": "x" } },
    )).toThrowError(CONNECTION_INPUT_ERROR);
  });

  it("parses a deeply frozen secret-free connection view", () => {
    const view = parseConnectionView({
      id: "conn_123",
      name: "API",
      kind: "basic",
      publicConfig: {},
      lifecycleRevision: 2,
      slots: {
        test: { environment: "test", status: "missing", secretVersion: 0, updatedAt: null, revokedAt: null },
        live: { environment: "live", status: "configured", secretVersion: 3, updatedAt: 10, revokedAt: null },
      },
      createdAt: 1,
      updatedAt: 10,
    });
    expect(view.id).toBe("conn_123");
    expect(JSON.stringify(view)).not.toMatch(/username|password|token|apiKey/i);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.slots)).toBe(true);
    expect(Object.isFrozen(view.slots.live)).toBe(true);

    expectInvalid({ ...view, id: "x".repeat(257) }, parseConnectionView);
    expectInvalid({ ...view, slots: { ...view.slots, live: { ...view.slots.live, environment: "test" } } }, parseConnectionView);
    expectInvalid({ ...view, publicConfig: { username: "hidden" } }, parseConnectionView);
  });

  it("uses one fixed non-echoing failure for adversarial submitted values", () => {
    const canary = "do-not-echo-connection-secret";
    for (const value of [
      { kind: "bearer", token: `${canary}\n` },
      { kind: "basic", username: canary, password: "" },
      { kind: "custom_headers", values: { [`${canary}\n`]: "x" } },
    ]) {
      try {
        parseConnectionSecretInput(value);
        throw new Error("expected parse failure");
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe(CONNECTION_INPUT_ERROR);
        expect((error as Error).message).not.toContain(canary);
      }
    }

    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw new Error(canary); },
    });
    try {
      parseConnectionSecretInput(hostile);
      throw new Error("expected parse failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(CONNECTION_INPUT_ERROR);
    }
  });
});
