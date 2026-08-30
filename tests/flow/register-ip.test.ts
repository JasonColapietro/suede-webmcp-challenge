/**
 * registerIp on-chain node — everything testable without a chain:
 * stub shape, owner-attribution redaction, and live-mode fail-closed
 * behavior when the registrar wallet isn't configured.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerIpNode, publicOwnerRef } from "@/lib/flow/nodes/suede/registerIp";
import { requiresDryRunStub } from "@/lib/flow/executor";
import { registryAddressFor } from "@/lib/registry/suede-registry";
import { makeCtx } from "../_helpers";

const ENV_KEYS = [
  "X402_PRIVATE_KEY",
  "SUEDE_REGISTRAR_PRIVATE_KEY",
  "SUEDE_REGISTRY_ADDRESS",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("publicOwnerRef — anonymous workspace keys never reach public metadata", () => {
  it("passes sb: ecosystem identities through verbatim (not secrets)", () => {
    expect(publicOwnerRef("sb:1c1f7a1e-0000-4000-8000-000000000001")).toBe(
      "sb:1c1f7a1e-0000-4000-8000-000000000001",
    );
  });

  it("reduces anonymous bearer-key owners to a sha256 reference", () => {
    const anon = "9a1b2c3d-1111-4222-8333-444455556666";
    const ref = publicOwnerRef(anon);
    expect(ref).toMatch(/^anon-sha256:[0-9a-f]{64}$/);
    expect(ref).not.toContain(anon);
  });

  it("is null for missing owners", () => {
    expect(publicOwnerRef(null)).toBeNull();
    expect(publicOwnerRef(undefined)).toBeNull();
  });
});

describe("registerIp node classification", () => {
  it("is side-effecting and therefore gated by the central dry-run dispatch", () => {
    expect(registerIpNode.sideEffecting).toBe(true);
    expect(requiresDryRunStub(registerIpNode)).toBe(true);
    expect(registerIpNode.dryRunStub).toBeDefined();
  });
});

describe("registerIp dry-run stub", () => {
  it("returns the local attestation shape with registered:false and an ipUrl", async () => {
    const res = await registerIpNode.dryRunStub!(makeCtx(), { title: "Demo" }, { in: { a: 1 } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const out = res.outputs.result as Record<string, unknown>;
      expect(out.registered).toBe(false);
      expect(out.dryRun).toBe(true);
      expect(out.txHash).toBeNull();
      expect(String(out.assetHash)).toMatch(/^0x[0-9a-f]{64}$/);
      expect(String(out.ipUrl)).toBe(`https://ip.suedeai.ai/ip/${out.assetHash}`);
      expect(res.costUsdc).toBe(0);
    }
  });
});

describe("registerIp live executor — fail closed without owner-funded authority", () => {
  it("rejects oversized public metadata before authorization or RPC", async () => {
    const res = await registerIpNode.executor(
      makeCtx({ dryRun: false, ownerId: "sb:user-1" }),
      { description: "x".repeat(2_001) },
      { in: { song: "x" } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("2000 character");
  });

  it("returns ok:false when no bounded owner-funded authorization is present", async () => {
    const res = await registerIpNode.executor(
      makeCtx({ dryRun: false, ownerId: "sb:user-1" }),
      { title: "Live attempt" },
      { in: { song: "x" } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("bounded owner-funded gas authorization");
    }
  });

  it.each([
    ["scheduled", "SUEDE_REGISTRAR_PRIVATE_KEY"],
    ["webhook", "X402_PRIVATE_KEY"],
  ])("does not let a %s/free run spend the platform %s", async (_trigger, envKey) => {
    process.env[envKey] = `0x${"01".repeat(32)}`;
    const res = await registerIpNode.executor(
      makeCtx({ dryRun: false, ownerId: "sb:user-1", runId: `free-${_trigger}` }),
      { title: "Unfunded attempt" },
      { in: { source: _trigger } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("bounded owner-funded gas authorization");
  });

  it("rejects a forged capability object", async () => {
    const res = await registerIpNode.executor(
      makeCtx({
        dryRun: false,
        ownerId: "sb:user-1",
        registerIpAuthorization: Object.freeze({
          kind: "owner-funded-registry-gas",
        }),
      }),
      {},
      { in: { song: "x" } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("invalid or forged");
  });
});

describe("registryAddressFor", () => {
  it("defaults to the verified Base mainnet deployment", () => {
    expect(registryAddressFor("base-mainnet")).toBe(
      "0x264eFed8135c36aD15a068d475d99c4030c27a3A",
    );
  });

  it("requires an env override on base-sepolia", () => {
    expect(registryAddressFor("base-sepolia")).toBeNull();
    process.env.SUEDE_REGISTRY_ADDRESS = "0x1111111111111111111111111111111111111111";
    expect(registryAddressFor("base-sepolia")).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });

  it("ignores malformed overrides", () => {
    process.env.SUEDE_REGISTRY_ADDRESS = "not-an-address";
    expect(registryAddressFor("base-mainnet")).toBe(
      "0x264eFed8135c36aD15a068d475d99c4030c27a3A",
    );
  });
});
