const MAX_ARTIFACT_BYTES = 3 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export interface ArtifactDescriptor {
  readonly fileBase64: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteCount: number;
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function safeFileName(value: string): string | null {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 && cleaned.length <= 160 ? cleaned : null;
}

function decodedByteCount(base64: string): number {
  if (base64.length === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function hasExpectedSignature(base64: string, mimeType: string): boolean {
  if (mimeType === "application/pdf") return base64.startsWith("JVBERi0");
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return base64.startsWith("UEsDB");
  return false;
}

function hasExpectedExtension(fileName: string, mimeType: string): boolean {
  const lower = fileName.toLocaleLowerCase();
  if (mimeType === "application/pdf") return lower.endsWith(".pdf");
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return lower.endsWith(".xlsx");
  return false;
}

export function artifactDescriptor(value: unknown, depth = 0): ArtifactDescriptor | null {
  if (depth > 4) return null;
  const candidate = record(value);
  if (!candidate) return null;
  const fileBase64 = candidate.fileBase64;
  const fileName = candidate.fileName;
  const mimeType = candidate.mimeType;
  if (typeof fileBase64 === "string" && typeof fileName === "string" && typeof mimeType === "string") {
    const normalizedFileName = safeFileName(fileName);
    if (!normalizedFileName || !ALLOWED_MIME_TYPES.has(mimeType) || !hasExpectedExtension(normalizedFileName, mimeType) ||
        !hasExpectedSignature(fileBase64, mimeType) || fileBase64.length > MAX_BASE64_LENGTH ||
        fileBase64.length % 4 !== 0 || !BASE64.test(fileBase64)) return null;
    const byteCount = decodedByteCount(fileBase64);
    if (byteCount <= 0 || byteCount > MAX_ARTIFACT_BYTES) return null;
    return { fileBase64, fileName: normalizedFileName, mimeType, byteCount };
  }
  for (const child of Object.values(candidate).slice(0, 100)) {
    const found = artifactDescriptor(child, depth + 1);
    if (found) return found;
  }
  return null;
}
