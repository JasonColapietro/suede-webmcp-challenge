import type { PublicPaymentState } from "@/lib/public-payment-readiness";
import {
  USDC_TOKEN_ADDRESS,
  X402_FACILITATOR_NETWORK,
  X402_SCHEME,
  usdcToAtomic,
} from "@/lib/rails/x402-verify";
import { SITE_URL } from "@/lib/site";

interface TemplatePaymentBounds {
  readonly amountAtomic: string;
  readonly payTo: string;
}

/** Exact generated-client policy. Exported so hostile challenges can be tested. */
export function buildTemplatePaymentPolicyExpression(
  bounds: TemplatePaymentBounds,
): string {
  return [
    "(x402Version, requirements) => {",
    "  if (x402Version !== 2) return [];",
    "  return requirements.filter((requirement) =>",
    `    requirement.scheme === ${JSON.stringify(X402_SCHEME)} &&`,
    `    requirement.network === ${JSON.stringify(X402_FACILITATOR_NETWORK)} &&`,
    "    typeof requirement.asset === 'string' &&",
    `    requirement.asset.toLowerCase() === ${JSON.stringify(USDC_TOKEN_ADDRESS.toLowerCase())} &&`,
    `    requirement.amount === ${JSON.stringify(bounds.amountAtomic)} &&`,
    "    typeof requirement.payTo === 'string' &&",
    `    requirement.payTo.toLowerCase() === ${JSON.stringify(bounds.payTo.toLowerCase())}`,
    "  );",
    "}",
  ].join("\n");
}

export function buildRunScript(
  agentId: string,
  priceUsdc: number,
  paymentState: PublicPaymentState,
  payTo?: string,
): string {
  if (paymentState === "unavailable") {
    return [
      "// This published service currently exposes neither preview nor payment.",
      "throw new Error('agent is unavailable for public calls');",
    ].join("\n");
  }
  if (paymentState === "preview") {
    return [
      "const BASE_URL = process.env.SUEDE_BASE_URL ?? 'https://agents.suedeai.ai';",
      `const RESOURCE = '/api/agents/${agentId}/run';`,
      "",
      "async function run(input) {",
      "  const res = await fetch(BASE_URL + RESOURCE, {",
      "    method: 'POST',",
      "    headers: { 'content-type': 'application/json' },",
      "    body: JSON.stringify({ input, dryRun: true }),",
      "  });",
      "  if (!res.ok) throw new Error('agent preview failed: ' + res.status);",
      "  return res.json();",
      "}",
      "",
      "run({}).then((r) => console.info(JSON.stringify(r, null, 2)));",
    ].join("\n");
  }
  if (!payTo) {
    throw new Error("payment-enabled template requires a configured payout");
  }
  const amountAtomic = usdcToAtomic(priceUsdc);
  const policy = buildTemplatePaymentPolicyExpression({ amountAtomic, payTo });
  const resource = `${SITE_URL}/api/agents/${agentId}/run`;
  return [
    "import { x402Client, wrapFetchWithPayment } from '@x402/fetch';",
    "import { registerExactEvmScheme } from '@x402/evm/exact/client';",
    "import { privateKeyToAccount } from 'viem/accounts';",
    "",
    "// Wallet pays per call in USDC on Base. No API keys required.",
    "const privateKey = process.env.WALLET_PRIVATE_KEY;",
    "if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {",
    "  throw new Error('WALLET_PRIVATE_KEY must be a 32-byte hex private key');",
    "}",
    "const account = privateKeyToAccount(privateKey as `0x${string}`);",
    `const RESOURCE = ${JSON.stringify(resource)};`,
    `const EXPECTED_NETWORK = ${JSON.stringify(X402_FACILITATOR_NETWORK)};`,
    "const client = new x402Client();",
    "registerExactEvmScheme(client, {",
    "  signer: account,",
    "  networks: [EXPECTED_NETWORK],",
    "  policies: [",
    ...policy.split("\n").map((line) => `    ${line}`),
    "  ],",
    "});",
    "const fetchWithPay = wrapFetchWithPayment(fetch, client);",
    "",
    "async function run(input) {",
    "  const res = await fetchWithPay(RESOURCE, {",
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json' },",
    "    body: JSON.stringify({ input }),",
    "  });",
    "  if (!res.ok) throw new Error('agent run failed: ' + res.status);",
    "  return res.json();",
    "}",
    "",
    `// Per-call price: ${priceUsdc} USDC`,
    "run({}).then((r) => console.info(JSON.stringify(r, null, 2)));",
  ].join("\n");
}
