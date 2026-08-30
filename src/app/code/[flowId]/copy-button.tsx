"use client";

import { useState, useCallback } from "react";

interface CopyButtonProps {
  source: string;
}

export default function CopyButton({ source }: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable — nothing to do
    }
  }, [source]);

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="cv-copy"
      aria-label="Copy the agent source to the clipboard"
    >
      <span aria-hidden="true">{copied ? "Copied ✓" : "Copy"}</span>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Source copied to the clipboard." : ""}
      </span>
    </button>
  );
}
