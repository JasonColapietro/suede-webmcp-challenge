import {
  checkpoint,
  jsonObject,
  refuse,
  type OpenApiCompileGuard,
  type ParsedJson,
  type ParsedJsonObject,
} from "./json";

const FORBIDDEN_POINTER_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function decodePointerSegment(segment: string): string {
  if (/~(?:[^01]|$)/u.test(segment)) refuse("REFERENCE_POINTER_REFUSED");
  return segment.replace(/~1/gu, "/").replace(/~0/gu, "~").normalize("NFC");
}

function canonicalPointer(reference: string): { readonly identity: string; readonly segments: readonly string[] } {
  let fragment: string;
  try { fragment = decodeURIComponent(reference.slice(1)); } catch { return refuse("REFERENCE_POINTER_REFUSED"); }
  if (!fragment.startsWith("/")) refuse("REFERENCE_POINTER_REFUSED");
  const segments = fragment.slice(1).split("/").map(decodePointerSegment);
  if (segments.some((segment) => !segment || FORBIDDEN_POINTER_SEGMENTS.has(segment))) refuse("REFERENCE_POINTER_REFUSED");
  const identity = `#/${segments.map((segment) => segment.replace(/~/gu, "~0").replace(/\//gu, "~1")).join("/")}`;
  return { identity, segments };
}

export function resolveLocalReference(
  document: ParsedJsonObject,
  reference: ParsedJson,
  guard: OpenApiCompileGuard,
  activeReferences: ReadonlySet<string>,
): { readonly value: ParsedJson; readonly reference: string; readonly activeReferences: ReadonlySet<string> } {
  checkpoint(guard);
  if (typeof reference !== "string" || !reference.startsWith("#")) refuse("REMOTE_REFERENCE_REFUSED");
  const pointer = canonicalPointer(reference);
  if (activeReferences.has(pointer.identity)) refuse("REFERENCE_CYCLE_REFUSED");
  guard.localReferenceExpansions += 1;
  if (guard.localReferenceExpansions > guard.limits.maxLocalReferenceExpansions) refuse("LOCAL_REFERENCE_LIMIT");

  let current: ParsedJson = document;
  for (const segment of pointer.segments) {
    checkpoint(guard, true);
    const record = jsonObject(current, "REFERENCE_POINTER_REFUSED");
    if (!Object.hasOwn(record, segment)) refuse("REFERENCE_POINTER_REFUSED");
    current = record[segment]!;
  }
  return Object.freeze({
    value: current,
    reference: pointer.identity,
    activeReferences: new Set([...activeReferences, pointer.identity]),
  });
}

export function referenceObject(value: ParsedJson): ParsedJsonObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as ParsedJsonObject;
  return Object.hasOwn(record, "$ref") ? record : null;
}
