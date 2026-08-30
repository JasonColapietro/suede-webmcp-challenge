"use client";

import React, { useCallback } from "react";
import type { ArtifactDescriptor } from "@/lib/artifacts/download";

export default function ArtifactDownloadButton({ artifact }: { readonly artifact: ArtifactDescriptor | null }): React.JSX.Element | null {
  const download = useCallback(() => {
    if (!artifact) return;
    const decoded = window.atob(artifact.fileBase64);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: artifact.mimeType }));
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = artifact.fileName;
    link.rel = "noopener";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }, [artifact]);

  if (!artifact) return null;
  return <button
    type="button"
    onClick={download}
    className="mono"
    style={{
      justifySelf: "start",
      border: "1px solid var(--registry-cyan)",
      borderRadius: 4,
      background: "transparent",
      color: "var(--text-info)",
      cursor: "pointer",
      padding: "6px 9px",
      fontSize: "var(--text-xs)",
    }}
  >
    Download {artifact.fileName} · {Math.max(1, Math.ceil(artifact.byteCount / 1024))} KB
  </button>;
}
