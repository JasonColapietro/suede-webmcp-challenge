import { createHash } from "node:crypto";
import { z } from "zod";
import {
  defineExecutableNode,
  type NodeExecutor,
} from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage } from "../_util";
import {
  ownerFundedRegistryAddress,
  registerWorkOnChain,
  type RegistryNetwork,
} from "../../../registry/suede-registry";

export const registerIpParamsSchema = z.object({
  // Public on-chain calldata must be bounded independently of the UI. This
  // also caps the OP Stack L1 data component that an EIP-1559 gas limit does
  // not directly meter.
  title: z.string().max(200).optional(),
  description: z.string().max(2_000).optional(),
  licenseTemplate: z.string().max(100).optional(),
});

const IP_URL_BASE = "https://ip.suedeai.ai/ip/";

/**
 * Owner attribution safe for PUBLIC, permanent on-chain metadata.
 * `sb:` owners are ecosystem identities (Supabase user ids, not secrets)
 * and go in verbatim. Anonymous owner ids double as bearer-style workspace
 * keys (see src/lib/auth.ts) — leaking one on-chain would hand the
 * workspace to anyone reading the registry, so those are reduced to a
 * sha256 reference: provable mapping, no usable secret.
 */
export function publicOwnerRef(ownerId: string | null | undefined): string | null {
  if (!ownerId) return null;
  if (ownerId.startsWith("sb:")) return ownerId;
  return "anon-sha256:" + createHash("sha256").update(ownerId).digest("hex");
}

function hashAsset(asset: unknown): `0x${string}` {
  return ("0x" +
    createHash("sha256").update(JSON.stringify(asset ?? {})).digest("hex")) as `0x${string}`;
}

/**
 * Dry-run: the previous local attestation, no chain interaction — same
 * shape as the live result so downstream nodes work against either mode.
 */
const registerIpDryRunStub: NodeExecutor = async (ctx, rawParams, inputs) => {
  let params;
  try {
    params = registerIpParamsSchema.parse(rawParams ?? {});
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }
  const assetHash = hashAsset(inputs.in ?? inputs.result ?? null);
  return {
    ok: true,
    outputs: {
      result: {
        assetHash,
        title: params.title ?? null,
        license: params.licenseTemplate ?? "all-rights-reserved",
        registered: false,
        owner: ctx.wallet.address,
        dryRun: true,
        txHash: null,
        tokenId: null,
        ipUrl: IP_URL_BASE + assetHash,
      },
    },
    costUsdc: 0,
  };
};

/**
 * Registers the upstream asset on the SuedeRegistry contract on Base — the
 * IP Registry's (ip.suedeai.ai) system of record. Live mode writes on-chain
 * via an explicit owner-funded signer capability. registerWork() hard-codes
 * creator = msg.sender, so ordinary editor, API, scheduled, webhook, and
 * worker contexts intentionally have no authority to perform the write.
 * Registration is idempotent per asset hash.
 *
 * The canonical descriptor declares testMode: stub plus write/publish effects,
 * so defineExecutableNode marks this side-effecting and the engine's central
 * dry-run dispatch substitutes registerIpDryRunStub. The live executor is
 * never selected during dry runs. Live gas is bounded independently by the
 * owner-funded authorization; platform ETH is never a fallback.
 */
export const registerIpNode = defineExecutableNode(
  getNodeDefinition("suede.registerIp"),
  {
    paramsSchema: registerIpParamsSchema,
    dryRunStub: registerIpDryRunStub,
    executor: async (ctx, rawParams, inputs) => {
      let params;
      try {
        params = registerIpParamsSchema.parse(rawParams ?? {});
      } catch (e) {
        return { ok: false, error: errMessage(e), costUsdc: 0 };
      }
      const asset = inputs.in ?? inputs.result ?? null;
      const assetHash = hashAsset(asset);
      const license = params.licenseTemplate ?? "all-rights-reserved";
      const network: RegistryNetwork = ctx.wallet.network;

      let creator: `0x${string}`;
      try {
        creator = ownerFundedRegistryAddress({
          authorization: ctx.registerIpAuthorization,
          ownerId: ctx.ownerId,
          runId: ctx.runId,
        });
      } catch (e) {
        return {
          ok: false,
          error: `registerIp on-chain write denied: ${errMessage(e)}`,
          costUsdc: 0,
        };
      }

      // Same metadata convention as ip.suedeai.ai's register dialog, so
      // /ip/[hash] renders agent registrations exactly like manual ones.
      const metadata = JSON.stringify({
        title: params.title ?? "Agent flow output",
        description: params.description ?? "",
        type: "agent-flow-output",
        timestamp: Date.now(),
        creator,
        license,
        registeredVia: "suede-agent-studio",
        studioOwner: publicOwnerRef(ctx.ownerId),
        runId: ctx.runId,
      });

      try {
        const reg = await registerWorkOnChain({
          assetHash,
          metadata,
          network,
          ownerId: ctx.ownerId,
          runId: ctx.runId,
          authorization: ctx.registerIpAuthorization,
        });

        // Fire-and-forget sync to the IP Registry's explore index — the same
        // call ip.suedeai.ai's register dialog makes. Never blocks the node.
        const backend = (process.env.SUEDE_IP_BACKEND_URL ?? "https://backend.suedeai.xyz").replace(/\/+$/, "");
        void fetch(`${backend}/api/assets/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            asset_hash: assetHash,
            creator: reg.creator,
            title: params.title ?? "Agent flow output",
            description: params.description ?? "",
            media_type: "agent-flow-output",
          }),
        }).catch(() => {});

        return {
          ok: true,
          outputs: {
            result: {
              assetHash,
              title: params.title ?? null,
              license,
              registered: true,
              alreadyRegistered: reg.alreadyRegistered,
              owner: reg.creator,
              dryRun: false,
              txHash: reg.alreadyRegistered ? null : reg.txHash,
              tokenId: reg.tokenId,
              ipAccount: reg.ipAccount,
              network: reg.network,
              ipUrl: IP_URL_BASE + assetHash,
            },
          },
          costUsdc: 0,
        };
      } catch (e) {
        return {
          ok: false,
          error: `registerIp on-chain write failed: ${errMessage(e)}`,
          costUsdc: 0,
        };
      }
    },
  },
);
