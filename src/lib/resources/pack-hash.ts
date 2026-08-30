import { createHash } from "node:crypto";
import { compareResourceCanonical, parseResourcePackContent } from "./schemas";
import type { ResourceJsonValue, ResourcePackContent } from "./types";

export const RESOURCE_PACK_ERROR = "Invalid resource pack.";

function invalid(): never { throw new TypeError(RESOURCE_PACK_ERROR); }

function canonical(value: ResourceJsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, ResourceJsonValue>>;
  return `{${Object.keys(record).sort(compareResourceCanonical).map((key) => `${JSON.stringify(key)}:${canonical(record[key]!)}`).join(",")}}`;
}

/** Canonical immutable projection. Database timestamps and mutable presentation are intentionally absent. */
export function canonicalizeResourcePack(value: unknown): { readonly canonicalBytes: Buffer; readonly content: ResourcePackContent } {
  let content: ResourcePackContent;
  try { content = parseResourcePackContent(value); } catch { invalid(); }
  return Object.freeze({ canonicalBytes: Buffer.from(canonical(content as unknown as ResourceJsonValue), "utf8"), content });
}

export function resourcePackSemanticHash(value: unknown): { readonly canonicalBytes: Buffer; readonly semanticHash: string } {
  const { canonicalBytes } = canonicalizeResourcePack(value);
  return Object.freeze({ canonicalBytes, semanticHash: createHash("sha256").update(canonicalBytes).digest("hex") });
}
