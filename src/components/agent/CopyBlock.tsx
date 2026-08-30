"use client";

/** Code block with a copy button — used for curl snippets on public pages. */
import { useState } from "react";

export default function CopyBlock({ code }: { code: string }): React.JSX.Element {
  const [copied, setCopied] = useState<boolean>(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable (permissions/iframe) — leave the text selectable.
    }
  }

  return (
    <div className="lp-code">
      <button type="button" className="lp-copy" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
      {code}
    </div>
  );
}
