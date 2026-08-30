"use client";

import { useEffect } from "react";
import {
  createPendingScanHandoff,
  parseScanDiagnosticHash,
  SCAN_HANDOFF_FRAGMENT_PREFIX,
  SCAN_HANDOFF_STORAGE_KEY,
} from "@/lib/company/operating-system/outbound-diagnostic";

export default function ScanHandoffCapture(): null {
  useEffect(() => {
    if (!window.location.hash.startsWith(SCAN_HANDOFF_FRAGMENT_PREFIX)) return;

    const rawHash = window.location.hash;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    try {
      const handoff = parseScanDiagnosticHash(rawHash);
      if (handoff) {
        sessionStorage.setItem(
          SCAN_HANDOFF_STORAGE_KEY,
          createPendingScanHandoff(handoff),
        );
      }
    } catch {
      try {
        sessionStorage.removeItem(SCAN_HANDOFF_STORAGE_KEY);
      } catch {
        // Storage can be unavailable. The user can sign in, then reopen Audit.
      }
    }
  }, []);

  return null;
}
