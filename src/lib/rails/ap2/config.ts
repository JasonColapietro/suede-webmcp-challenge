import { z } from "zod";
import type { JWK } from "jose";

import { attachMerchantRetiredPublicJwks, merchantPublicJwk } from "./keys";
import {
  Ap2ProtocolError,
  type Ap2AsymmetricAlgorithm,
  type Ap2MerchantSigningConfig,
  type Ap2Mode,
  type Ap2TrustedIssuer,
  type Ap2TrustedIssuerRegistry,
} from "./types";

const ASYMMETRIC_ALGORITHMS = ["ES256", "EdDSA", "RS256", "PS256"] as const;

const publicJwkSchema = z.object({
  kty: z.enum(["EC", "OKP", "RSA"]),
  kid: z.string().min(1).max(128),
  alg: z.enum(ASYMMETRIC_ALGORITHMS),
  use: z.literal("sig").optional(),
  crv: z.string().optional(),
  x: z.string().min(1).optional(),
  y: z.string().min(1).optional(),
  n: z.string().min(1).optional(),
  e: z.string().min(1).optional(),
}).strict().superRefine((key, context) => {
  const valid = key.alg === "ES256"
    ? key.kty === "EC" && key.crv === "P-256" && Boolean(key.x && key.y)
    : key.alg === "EdDSA"
      ? key.kty === "OKP" && key.crv === "Ed25519" && Boolean(key.x)
      : key.kty === "RSA" && Boolean(key.n && key.e);
  if (!valid) context.addIssue({ code: z.ZodIssueCode.custom, message: "key_algorithm_mismatch" });
});

const issuerSchema = z.object({
  issuer: z.string().min(1).max(512),
  algorithms: z.array(z.enum(ASYMMETRIC_ALGORITHMS)).min(1).max(4),
  keys: z.array(publicJwkSchema).min(1).max(32),
}).strict();

const registrySchema = z.object({
  issuers: z.array(issuerSchema).min(1).max(64),
}).strict();

const retiredMerchantJwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  kid: z.string().min(1).max(128),
  alg: z.literal("ES256"),
  use: z.literal("sig").optional(),
  key_ops: z.tuple([z.literal("verify")]).optional(),
}).strict();

const retiredMerchantJwksSchema = z.object({
  keys: z.array(retiredMerchantJwkSchema).max(8),
}).strict();

function fail(): never {
  throw new Ap2ProtocolError("ap2_not_ready");
}

export function resolveAp2Mode(value: string | undefined): Ap2Mode {
  return value === "off" || value === "optional" || value === "required"
    ? value
    : "off";
}

export function parseTrustedIssuerRegistry(raw: string): Ap2TrustedIssuerRegistry {
  if (!raw || Buffer.byteLength(raw, "utf8") > 262_144) fail();
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return fail();
  }
  const result = registrySchema.safeParse(decoded);
  if (!result.success) fail();

  const byIssuer = new Map<string, Ap2TrustedIssuer>();
  for (const entry of result.data.issuers) {
    if (byIssuer.has(entry.issuer) || new Set(entry.algorithms).size !== entry.algorithms.length) {
      fail();
    }
    const algorithms = entry.algorithms as readonly Ap2AsymmetricAlgorithm[];
    const kids = new Set<string>();
    for (const key of entry.keys) {
      if (kids.has(key.kid) || !algorithms.includes(key.alg)) fail();
      kids.add(key.kid);
    }
    byIssuer.set(entry.issuer, {
      issuer: entry.issuer,
      algorithms,
      keys: entry.keys.map((key) => Object.freeze({ ...key })),
    });
  }
  return { byIssuer };
}

export interface Ap2ReadinessInput {
  readonly modeValue: string | undefined;
  readonly merchantSigning?: Ap2MerchantSigningConfig;
  readonly trustedIssuersJson?: string;
  readonly replayStoreReady: boolean;
}

export interface Ap2Readiness {
  readonly mode: Ap2Mode;
  readonly ready: boolean;
  readonly advertise: boolean;
  readonly requireAuthorization: boolean;
  readonly reason: string | null;
  readonly reasons: readonly string[];
}

export async function resolveAp2Readiness(input: Ap2ReadinessInput): Promise<Ap2Readiness> {
  const mode = resolveAp2Mode(input.modeValue);
  if (mode === "off") {
    return {
      mode,
      ready: false,
      advertise: false,
      requireAuthorization: false,
      reason: "mode_off",
      reasons: ["mode_off"],
    };
  }
  const reasons: string[] = [];
  if (!input.merchantSigning) {
    reasons.push("merchant_signing_key_missing");
  } else {
    try {
      await merchantPublicJwk(input.merchantSigning);
    } catch {
      reasons.push("merchant_signing_key_invalid");
    }
  }
  try {
    parseTrustedIssuerRegistry(input.trustedIssuersJson ?? "");
  } catch {
    reasons.push("trusted_issuers_invalid");
  }
  if (!input.replayStoreReady) reasons.push("replay_store_unavailable");
  const ready = reasons.length === 0;
  return {
    mode,
    ready,
    advertise: ready,
    requireAuthorization: ready && mode === "required",
    reason: reasons[0] ?? null,
    reasons,
  };
}

async function parseMerchantSigningJwk(
  issuer: string | undefined,
  raw: string | undefined,
  retiredRaw: string | undefined,
): Promise<Ap2MerchantSigningConfig | undefined> {
  if (!issuer || !raw || Buffer.byteLength(raw, "utf8") > 32_768) return undefined;
  try {
    const privateJwk = JSON.parse(raw) as unknown;
    if (
      typeof privateJwk !== "object"
      || privateJwk === null
      || Array.isArray(privateJwk)
      || !("kid" in privateJwk)
      || typeof privateJwk.kid !== "string"
    ) return undefined;
    const signing = { issuer, keyId: privateJwk.kid, privateJwk: privateJwk as JWK };
    if (retiredRaw === undefined) return signing;
    if (!retiredRaw || Buffer.byteLength(retiredRaw, "utf8") > 65_536) return undefined;
    const retired = retiredMerchantJwksSchema.safeParse(JSON.parse(retiredRaw) as unknown);
    if (!retired.success) return undefined;
    return await attachMerchantRetiredPublicJwks(signing, retired.data.keys);
  } catch {
    return undefined;
  }
}

/**
 * Load only merchant receipt-verification key material. Historical receipts
 * must remain verifiable while new AP2 acceptance is off or degraded, so this
 * intentionally does not depend on issuer trust or replay-store readiness.
 */
export async function loadAp2ReceiptVerificationSigning(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Ap2MerchantSigningConfig | undefined> {
  return parseMerchantSigningJwk(
    env.AP2_MERCHANT_ISSUER,
    env.AP2_MERCHANT_SIGNING_JWK,
    env.AP2_MERCHANT_RETIRED_JWKS_JSON,
  );
}

export interface Ap2RuntimeConfig {
  readonly readiness: Ap2Readiness;
  readonly signing?: Ap2MerchantSigningConfig;
  readonly trustedIssuers?: Ap2TrustedIssuerRegistry;
}

export interface LoadAp2RuntimeConfigOptions {
  readonly replayStoreReady?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export async function loadAp2RuntimeConfig(
  options: LoadAp2RuntimeConfigOptions = {},
): Promise<Ap2RuntimeConfig> {
  const env = options.env ?? process.env;
  const signing = await parseMerchantSigningJwk(
    env.AP2_MERCHANT_ISSUER,
    env.AP2_MERCHANT_SIGNING_JWK,
    env.AP2_MERCHANT_RETIRED_JWKS_JSON,
  );
  const replayStoreReady = options.replayStoreReady
    ?? env.AP2_REPLAY_STORE_READY === "1";
  const readiness = await resolveAp2Readiness({
    modeValue: env.AP2_MODE,
    merchantSigning: signing,
    trustedIssuersJson: env.AP2_TRUSTED_ISSUERS_JSON,
    replayStoreReady,
  });

  let trustedIssuers: Ap2TrustedIssuerRegistry | undefined;
  if (readiness.ready) {
    try {
      trustedIssuers = parseTrustedIssuerRegistry(env.AP2_TRUSTED_ISSUERS_JSON ?? "");
    } catch {
      trustedIssuers = undefined;
    }
  }

  const runtime: Ap2RuntimeConfig = {
    readiness,
    ...(trustedIssuers ? { trustedIssuers } : {}),
  };
  if (readiness.ready && signing) {
    Object.defineProperty(runtime, "signing", {
      configurable: false,
      enumerable: false,
      value: signing,
      writable: false,
    });
  }
  return runtime;
}

export async function loadPublicAp2RuntimeConfig(
  options: { readonly replayStoreReady?: boolean } = {},
): Promise<Ap2RuntimeConfig> {
  if (options.replayStoreReady !== undefined) {
    return loadAp2RuntimeConfig(options);
  }
  let replayStoreReady = false;
  if (resolveAp2Mode(process.env.AP2_MODE) !== "off"
    && process.env.AP2_REPLAY_STORE_READY === "1") {
    try {
      const { getRepo } = await import("@/lib/db/repo");
      replayStoreReady = await (await getRepo()).checkAp2ReplayStoreReady();
    } catch {
      replayStoreReady = false;
    }
  }
  return loadAp2RuntimeConfig({ replayStoreReady });
}

export async function publicAp2RuntimeStatus(
  options: { readonly replayStoreReady?: boolean } = {},
): Promise<Ap2Readiness> {
  return (await loadPublicAp2RuntimeConfig(options)).readiness;
}
