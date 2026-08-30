import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  parseConnectionCreateInput,
  type ConnectionEnvironment,
  type ConnectionKind,
} from "./types";

export const CONNECTION_CRYPTO_ERROR = "Connection secret unavailable";

type CanonicalPublicConfigValue<Kind extends ConnectionKind> =
  Kind extends "api_key" ? Readonly<{ headerName: string }>
    : Kind extends "custom_headers" ? Readonly<{ headerNames: readonly string[] }>
      : Readonly<Record<string, never>>;

export interface CanonicalConnectionPublicConfig<Kind extends ConnectionKind = ConnectionKind> {
  readonly value: CanonicalPublicConfigValue<Kind>;
  readonly bytes: Buffer;
  readonly sha256: string;
}

export interface ConnectionCryptoIdentity {
  readonly key: Buffer;
  readonly ownerId: string;
  readonly connectionId: string;
  readonly kind: ConnectionKind;
  readonly environment: ConnectionEnvironment;
  readonly schemaVersion: 1;
  readonly secretVersion: number;
  readonly publicConfigSha256: string;
}

export interface ConnectionCipherEnvelope {
  readonly keyVersion: 1;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

function unavailable(): never {
  throw new Error(CONNECTION_CRYPTO_ERROR);
}

export function parseConnectionEncryptionKey(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value) ||
    /^0{64}$/u.test(value)
  ) {
    return unavailable();
  }
  return Buffer.from(value, "hex");
}

function compareHeaderNames(left: string, right: string): number {
  const leftFolded = left.toLowerCase();
  const rightFolded = right.toLowerCase();
  return leftFolded < rightFolded ? -1 : leftFolded > rightFolded ? 1 : 0;
}

export function canonicalConnectionPublicConfig<Kind extends ConnectionKind>(
  kind: Kind,
  input: unknown,
): CanonicalConnectionPublicConfig<Kind> {
  try {
    const parsed = parseConnectionCreateInput({
      name: "Canonical connection",
      kind,
      publicConfig: input,
    });
    let value: Readonly<Record<string, string | readonly string[]>>;
    if (parsed.kind === "api_key") {
      value = Object.freeze({ headerName: parsed.publicConfig.headerName });
    } else if (parsed.kind === "custom_headers") {
      value = Object.freeze({
        headerNames: Object.freeze([...parsed.publicConfig.headerNames].sort(compareHeaderNames)),
      });
    } else {
      value = Object.freeze(Object.create(null) as Record<string, never>);
    }
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    return Object.freeze({
      value: value as CanonicalPublicConfigValue<Kind>,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } catch {
    return unavailable();
  }
}

function validKey(key: unknown): key is Buffer {
  return Buffer.isBuffer(key) && key.length === 32 && key.some((byte) => byte !== 0);
}

function validIdentity(identity: ConnectionCryptoIdentity): boolean {
  return validKey(identity.key) &&
    typeof identity.ownerId === "string" && identity.ownerId.length > 0 &&
    typeof identity.connectionId === "string" && identity.connectionId.length > 0 &&
    ["api_key", "bearer", "basic", "custom_headers"].includes(identity.kind) &&
    (identity.environment === "test" || identity.environment === "live") &&
    identity.schemaVersion === 1 &&
    Number.isSafeInteger(identity.secretVersion) && identity.secretVersion > 0 &&
    /^[0-9a-f]{64}$/u.test(identity.publicConfigSha256);
}

function lengthPrefixedUtf8(fields: readonly string[]): Buffer {
  const encoded = fields.map((field) => Buffer.from(field, "utf8"));
  if (encoded.some((field) => field.length > 0xffff_ffff)) return unavailable();
  const output = Buffer.alloc(encoded.reduce((total, field) => total + 4 + field.length, 0));
  let offset = 0;
  for (const field of encoded) {
    output.writeUInt32BE(field.length, offset);
    offset += 4;
    field.copy(output, offset);
    offset += field.length;
  }
  return output;
}

function associatedData(identity: ConnectionCryptoIdentity): Buffer {
  if (!validIdentity(identity)) return unavailable();
  return lengthPrefixedUtf8([
    identity.ownerId,
    identity.connectionId,
    identity.kind,
    identity.environment,
    String(identity.schemaVersion),
    String(identity.secretVersion),
    identity.publicConfigSha256,
  ]);
}

export function encryptConnectionSecret(
  input: ConnectionCryptoIdentity & { readonly plaintext: Buffer },
): ConnectionCipherEnvelope {
  const plaintext = input.plaintext;
  try {
    if (!Buffer.isBuffer(plaintext)) return unavailable();
    const aad = associatedData(input);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", input.key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Object.freeze({
      keyVersion: 1,
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag(),
    });
  } catch {
    return unavailable();
  } finally {
    if (Buffer.isBuffer(plaintext)) plaintext.fill(0);
  }
}

export function decryptConnectionSecret(
  input: ConnectionCryptoIdentity & { readonly envelope: ConnectionCipherEnvelope },
): Buffer {
  const plaintextChunks: Buffer[] = [];
  try {
    const aad = associatedData(input);
    const envelope = input.envelope;
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      envelope.keyVersion !== 1 ||
      !Buffer.isBuffer(envelope.nonce) || envelope.nonce.length !== 12 ||
      !Buffer.isBuffer(envelope.ciphertext) ||
      !Buffer.isBuffer(envelope.authTag) || envelope.authTag.length !== 16
    ) {
      return unavailable();
    }
    const decipher = createDecipheriv("aes-256-gcm", input.key, envelope.nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(envelope.authTag);
    plaintextChunks.push(decipher.update(envelope.ciphertext));
    plaintextChunks.push(decipher.final());
    return Buffer.concat(plaintextChunks);
  } catch {
    return unavailable();
  } finally {
    for (const chunk of plaintextChunks) chunk.fill(0);
  }
}
