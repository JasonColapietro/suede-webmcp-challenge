import { z } from "zod";
import {
  AgentManifestV2EnvelopeSchema,
  type AgentManifestV2,
} from "./schema";
import { assertPortableConnectorDependencies } from "./connector-bundle";
import { parseConnectorDependencyBundles } from "./connector-bundle";
import { isProxy } from "node:util/types";

/** Authoritative server parser: envelope, canonical projections, closure, and hashes. */
export const PortableAgentManifestV2Schema: z.ZodType<
  AgentManifestV2,
  z.ZodTypeDef,
  unknown
> = z.unknown().transform((value, context) => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
      throw new TypeError("Invalid portable manifest");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "connectorBundles");
    if (descriptor && (!("value" in descriptor) || !descriptor.enumerable)) {
      throw new TypeError("Invalid portable manifest");
    }
    if (descriptor && descriptor.value !== undefined) {
      parseConnectorDependencyBundles(descriptor.value);
    }
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["connectorBundles"],
      message: error instanceof Error ? error.message : "Invalid portable connector dependencies",
    });
    return z.NEVER;
  }
  const envelope = AgentManifestV2EnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    for (const issue of envelope.error.issues) context.addIssue(issue);
    return z.NEVER;
  }
  try {
    assertPortableConnectorDependencies(
      envelope.data.graph,
      envelope.data.connectorBundles,
    );
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["connectorBundles"],
      message: error instanceof Error ? error.message : "Invalid portable connector dependencies",
    });
    return z.NEVER;
  }
  return envelope.data;
});

export function parsePortableAgentManifestV2(value: unknown): AgentManifestV2 {
  return PortableAgentManifestV2Schema.parse(value);
}
