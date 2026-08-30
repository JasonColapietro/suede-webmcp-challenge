import { z } from "zod";
import { parseJobContract } from "./schemas";
import type { ResourceJobContract, ResourceQueryReference } from "./types";

export const PUBLIC_RESOURCE_CONTRACT_ERROR = "Invalid public resource contract.";

export interface PublicResourceJobContract extends ResourceQueryReference, ResourceJobContract {}

function invalid(): never { throw new TypeError(PUBLIC_RESOURCE_CONTRACT_ERROR); }

function parse(value: unknown, expected?: ResourceQueryReference): PublicResourceJobContract {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(["resourceProductId", "packVersionId", "semanticHash", "jobStatement", "buyerIntent", "inputSchema", "outputSchema", "unsupportedRequest", "evidenceRequirement", "safeExample", "reviewBoundary", "dataHandlingDisclosure"]);
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.keys(descriptors).some((key) => !allowed.has(key) || !("value" in descriptors[key]!) || !descriptors[key]!.enumerable)) invalid();
  const source = value as Record<string, unknown>;
  if (typeof source.resourceProductId !== "string" || typeof source.packVersionId !== "string" || typeof source.semanticHash !== "string" || !/^[a-f0-9]{64}$/u.test(source.semanticHash)) invalid();
  if (expected && (source.resourceProductId !== expected.resourceProductId || source.packVersionId !== expected.packVersionId || source.semanticHash !== expected.semanticHash)) invalid();
  let job: ResourceJobContract;
  try { job = parseJobContract({ jobStatement: source.jobStatement, buyerIntent: source.buyerIntent, inputSchema: source.inputSchema, outputSchema: source.outputSchema, unsupportedRequest: source.unsupportedRequest, evidenceRequirement: source.evidenceRequirement, safeExample: source.safeExample, reviewBoundary: source.reviewBoundary, dataHandlingDisclosure: source.dataHandlingDisclosure }); } catch { invalid(); }
  return Object.freeze({ resourceProductId: source.resourceProductId, packVersionId: source.packVersionId, semanticHash: source.semanticHash, ...job });
}

export const PublicResourceJobContractSchema: z.ZodType<PublicResourceJobContract, z.ZodTypeDef, unknown> = z.unknown().transform((value, context) => {
  try { return parse(value); } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: PUBLIC_RESOURCE_CONTRACT_ERROR }); return z.NEVER; }
});

export function parsePublicJobContract(value: unknown, expected?: ResourceQueryReference): PublicResourceJobContract {
  try { return parse(value, expected); } catch { invalid(); }
}
