import { describe, expect, it } from "vitest";
import {
  CONNECTION_CRYPTO_ERROR,
  canonicalConnectionPublicConfig,
  decryptConnectionSecret,
  encryptConnectionSecret,
  parseConnectionEncryptionKey,
  type ConnectionCipherEnvelope,
  type ConnectionCryptoIdentity,
} from "@/lib/connections/crypto";

const KEY_HEX = "01".repeat(32);
const OTHER_KEY_HEX = "02".repeat(32);

function identity(overrides: Partial<ConnectionCryptoIdentity> = {}): ConnectionCryptoIdentity {
  return {
    key: parseConnectionEncryptionKey(KEY_HEX),
    ownerId: "owner_1",
    connectionId: "conn_1",
    kind: "bearer",
    environment: "live",
    schemaVersion: 1,
    secretVersion: 3,
    publicConfigSha256: canonicalConnectionPublicConfig("bearer", {}).sha256,
    ...overrides,
  };
}

function copyEnvelope(envelope: ConnectionCipherEnvelope): ConnectionCipherEnvelope {
  return {
    keyVersion: envelope.keyVersion,
    nonce: Buffer.from(envelope.nonce),
    ciphertext: Buffer.from(envelope.ciphertext),
    authTag: Buffer.from(envelope.authTag),
  };
}

function expectFixedFailure(run: () => unknown, canary = "protected-canary"): void {
  try {
    run();
    throw new Error("expected crypto failure");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(CONNECTION_CRYPTO_ERROR);
    expect((error as Error).message).not.toContain(canary);
  }
}

describe("connection encryption key parsing", () => {
  it("accepts exactly 32 nonzero bytes encoded as lowercase hex", () => {
    const key = parseConnectionEncryptionKey(KEY_HEX);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key).toHaveLength(32);
    expect(key.toString("hex")).toBe(KEY_HEX);
  });

  it("rejects missing, uppercase, wrong-length, non-hex, and all-zero material", () => {
    for (const candidate of [
      undefined,
      "AB".repeat(32),
      "01".repeat(31),
      "01".repeat(33),
      `${"01".repeat(31)}0g`,
      "00".repeat(32),
      `${KEY_HEX}\n`,
    ]) {
      expectFixedFailure(() => parseConnectionEncryptionKey(candidate));
    }
  });
});

describe("canonical public connection configuration", () => {
  it("preserves the creation spelling while making case-only variants distinct", () => {
    const original = canonicalConnectionPublicConfig("api_key", { headerName: "X-Api-Key" });
    const variant = canonicalConnectionPublicConfig("api_key", { headerName: "x-api-key" });

    expect(original.value).toEqual({ headerName: "X-Api-Key" });
    expect(original.bytes.toString("utf8")).toBe('{"headerName":"X-Api-Key"}');
    expect(original.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(variant.sha256).not.toBe(original.sha256);
  });

  it("sorts custom names by lowercase form with deterministic object and list order", () => {
    const first = canonicalConnectionPublicConfig("custom_headers", {
      headerNames: ["X-Zeta", "x-Alpha", "X-Middle"],
    });
    const second = canonicalConnectionPublicConfig("custom_headers", {
      headerNames: ["X-Middle", "X-Zeta", "x-Alpha"],
    });

    expect(Object.keys(first.value)).toEqual(["headerNames"]);
    expect(first.value).toEqual({ headerNames: ["x-Alpha", "X-Middle", "X-Zeta"] });
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(Object.isFrozen(first.value)).toBe(true);
    expect(Object.isFrozen(first.value.headerNames)).toBe(true);
  });

  it("uses exact empty objects for bearer/basic and rejects unsafe or duplicate configs", () => {
    for (const kind of ["bearer", "basic"] as const) {
      const canonical = canonicalConnectionPublicConfig(kind, {});
      expect(Object.keys(canonical.value)).toEqual([]);
      expect(canonical.bytes.toString("utf8")).toBe("{}");
    }
    expectFixedFailure(() => canonicalConnectionPublicConfig("api_key", { headerName: "Host" }));
    expectFixedFailure(() => canonicalConnectionPublicConfig("custom_headers", {
      headerNames: ["X-Key", "x-key"],
    }));
  });
});

describe("environment-bound AES-256-GCM envelopes", () => {
  it("round-trips only under the exact identity and uses a fresh nonce", () => {
    const firstPlaintext = Buffer.from('{"token":"protected-canary"}', "utf8");
    const secondPlaintext = Buffer.from('{"token":"protected-canary"}', "utf8");
    const first = encryptConnectionSecret({ ...identity(), plaintext: firstPlaintext });
    const second = encryptConnectionSecret({ ...identity(), plaintext: secondPlaintext });

    expect(first).toMatchObject({ keyVersion: 1 });
    expect(first.nonce).toHaveLength(12);
    expect(first.authTag).toHaveLength(16);
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(firstPlaintext.every((byte) => byte === 0)).toBe(true);
    expect(secondPlaintext.every((byte) => byte === 0)).toBe(true);

    const decrypted = decryptConnectionSecret({ ...identity(), envelope: first });
    try {
      expect(decrypted.toString("utf8")).toBe('{"token":"protected-canary"}');
    } finally {
      decrypted.fill(0);
    }
  });

  it("fails with one fixed error for every identity or key mismatch", () => {
    const envelope = encryptConnectionSecret({
      ...identity(),
      plaintext: Buffer.from("protected-canary", "utf8"),
    });
    const mismatches: readonly Partial<ConnectionCryptoIdentity>[] = [
      { key: parseConnectionEncryptionKey(OTHER_KEY_HEX) },
      { ownerId: "owner_2" },
      { connectionId: "conn_2" },
      { kind: "api_key" },
      { environment: "test" },
      { schemaVersion: 2 as 1 },
      { secretVersion: 4 },
      { publicConfigSha256: "03".repeat(32) },
    ];

    for (const mismatch of mismatches) {
      expectFixedFailure(() => decryptConnectionSecret({
        ...identity(mismatch),
        envelope,
      }));
    }
  });

  it("fails closed for nonce, ciphertext, tag, and key-version tampering", () => {
    const envelope = encryptConnectionSecret({
      ...identity(),
      plaintext: Buffer.from("protected-canary", "utf8"),
    });
    const tampered = [
      (() => { const value = copyEnvelope(envelope); value.nonce[0] ^= 1; return value; })(),
      (() => { const value = copyEnvelope(envelope); value.ciphertext[0] ^= 1; return value; })(),
      (() => { const value = copyEnvelope(envelope); value.authTag[0] ^= 1; return value; })(),
      { ...copyEnvelope(envelope), keyVersion: 2 as 1 },
      { ...copyEnvelope(envelope), nonce: Buffer.alloc(11) },
      { ...copyEnvelope(envelope), authTag: Buffer.alloc(15) },
    ];

    for (const candidate of tampered) {
      expectFixedFailure(() => decryptConnectionSecret({ ...identity(), envelope: candidate }));
    }
  });

  it("wipes caller-owned plaintext buffers even when encryption validation fails", () => {
    const plaintext = Buffer.from("protected-canary", "utf8");
    expectFixedFailure(() => encryptConnectionSecret({
      ...identity({ ownerId: "" }),
      plaintext,
    }));
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it("never serializes plaintext into an envelope or echoes it in failures", () => {
    const canary = "protected-canary";
    const envelope = encryptConnectionSecret({
      ...identity(),
      plaintext: Buffer.from(canary, "utf8"),
    });
    expect(JSON.stringify(envelope)).not.toContain(canary);
    const broken = copyEnvelope(envelope);
    broken.authTag[0] ^= 1;
    expectFixedFailure(() => decryptConnectionSecret({ ...identity(), envelope: broken }), canary);
  });
});
