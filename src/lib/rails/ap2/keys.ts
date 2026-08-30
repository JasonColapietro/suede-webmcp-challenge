import { createPrivateKey, createPublicKey } from "node:crypto";

import {
  importJWK,
  importPKCS8,
  type JWK,
  type KeyLike,
} from "jose";

import { Ap2ProtocolError, type Ap2MerchantSigningConfig } from "./types";

const retiredPublicJwks = new WeakMap<Ap2MerchantSigningConfig, readonly JWK[]>();

function fail(): never {
  throw new Ap2ProtocolError("ap2_not_ready");
}

function publicJwkFromPrivateJwk(privateJwk: JWK): JWK {
  const publicJwk = { ...privateJwk } as Record<string, unknown>;
  for (const privateField of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
    delete publicJwk[privateField];
  }
  return publicJwk as unknown as JWK;
}

function validatePublicP256Jwk(jwk: JWK, keyId: string): JWK {
  if (
    jwk.kty !== "EC"
    || jwk.crv !== "P-256"
    || typeof jwk.x !== "string"
    || typeof jwk.y !== "string"
    || !jwk.x
    || !jwk.y
  ) fail();
  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    alg: "ES256",
    kid: keyId,
    use: "sig",
  };
}

function validateSigningConfig(config: Ap2MerchantSigningConfig): void {
  if (!config.issuer || config.issuer.length > 512 || !config.keyId || config.keyId.length > 128) {
    fail();
  }
  if ((config.privateKeyPem ? 1 : 0) + (config.privateJwk ? 1 : 0) !== 1) fail();
}

export async function merchantPrivateKey(
  config: Ap2MerchantSigningConfig,
): Promise<KeyLike | Uint8Array> {
  validateSigningConfig(config);
  try {
    if (config.privateKeyPem) return await importPKCS8(config.privateKeyPem, "ES256");
    if (
      !config.privateJwk
      || config.privateJwk.kty !== "EC"
      || config.privateJwk.crv !== "P-256"
      || typeof config.privateJwk.d !== "string"
      || config.privateJwk.alg !== undefined && config.privateJwk.alg !== "ES256"
      || config.privateJwk.kid !== undefined && config.privateJwk.kid !== config.keyId
    ) fail();
    return await importJWK({ ...config.privateJwk, alg: "ES256" }, "ES256");
  } catch (error) {
    if (error instanceof Ap2ProtocolError) throw error;
    return fail();
  }
}

export async function merchantPublicJwk(
  config: Ap2MerchantSigningConfig,
): Promise<JWK> {
  validateSigningConfig(config);
  try {
    if (config.privateKeyPem) {
      const privateKey = createPrivateKey(config.privateKeyPem);
      const publicKey = createPublicKey(privateKey);
      const exported = publicKey.export({ format: "jwk" });
      return validatePublicP256Jwk(exported as unknown as JWK, config.keyId);
    }
    if (!config.privateJwk) fail();
    await merchantPrivateKey(config);
    return validatePublicP256Jwk(publicJwkFromPrivateJwk(config.privateJwk), config.keyId);
  } catch (error) {
    if (error instanceof Ap2ProtocolError) throw error;
    return fail();
  }
}

export async function attachMerchantRetiredPublicJwks(
  config: Ap2MerchantSigningConfig,
  retired: readonly JWK[],
): Promise<Ap2MerchantSigningConfig> {
  if (retired.length > 8) fail();
  const active = await merchantPublicJwk(config);
  const keyIds = new Set([active.kid]);
  const verified: JWK[] = [];
  for (const candidate of retired) {
    if (
      typeof candidate.kid !== "string"
      || !candidate.kid
      || keyIds.has(candidate.kid)
      || candidate.kty !== "EC"
      || candidate.crv !== "P-256"
      || candidate.alg !== "ES256"
      || candidate.use !== undefined && candidate.use !== "sig"
      || candidate.key_ops !== undefined
        && (candidate.key_ops.length !== 1 || candidate.key_ops[0] !== "verify")
      || typeof candidate.x !== "string"
      || typeof candidate.y !== "string"
      || !candidate.x
      || !candidate.y
      || "d" in candidate
      || "p" in candidate
      || "q" in candidate
      || "dp" in candidate
      || "dq" in candidate
      || "qi" in candidate
      || "oth" in candidate
      || "k" in candidate
      || "jku" in candidate
      || "x5u" in candidate
      || "x5c" in candidate
    ) fail();
    const publicJwk = validatePublicP256Jwk(candidate, candidate.kid);
    try {
      await importJWK(publicJwk, "ES256");
    } catch {
      return fail();
    }
    keyIds.add(candidate.kid);
    verified.push(Object.freeze(publicJwk));
  }
  retiredPublicJwks.set(config, Object.freeze(verified));
  return config;
}

export function merchantRetiredPublicJwks(
  config: Ap2MerchantSigningConfig,
): readonly JWK[] {
  return retiredPublicJwks.get(config) ?? [];
}
