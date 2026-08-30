"use client";

import React from "react";

export type StudioRecoveryBannerState = "restored" | "conflict" | "warning" | "interrupted";

export default function StudioRecoveryBanner({
  state, message, onSaveRecovered, onDiscardRecovered, onRecoverConflict, onKeepSaved, busy = false,
}: {
  readonly state: StudioRecoveryBannerState;
  readonly message: string;
  readonly onSaveRecovered: () => void;
  readonly onDiscardRecovered: () => void;
  readonly onRecoverConflict: () => void;
  readonly onKeepSaved: () => void;
  readonly busy?: boolean;
}): React.JSX.Element {
  const liveRole = state === "conflict" || state === "interrupted" ? "alert" : "status";

  return (
    <section
      role={liveRole}
      aria-live={liveRole === "alert" ? "assertive" : "polite"}
      aria-atomic="true"
      aria-busy={busy}
      className="studio-recovery-banner"
      data-state={state}
    >
      <div className="studio-recovery-banner__copy">
        <span className="studio-recovery-banner__eyebrow">Draft protection</span>
        <strong className="studio-recovery-banner__title">Workflow recovery</strong>
        <p className="studio-recovery-banner__message">{message}</p>
      </div>
      <div className="studio-recovery-banner__actions">
        {state === "restored" ? <>
          <button type="button" className="lp-btn lp-btn--primary lp-btn--sm" onClick={onSaveRecovered} disabled={busy}>Save recovered workflow</button>
          <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" onClick={onDiscardRecovered} disabled={busy}>Discard browser workflow</button>
        </> : null}
        {state === "conflict" ? <>
          <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" onClick={onRecoverConflict} disabled={busy}>Recover browser workflow</button>
          <button type="button" className="lp-btn lp-btn--primary lp-btn--sm" onClick={onKeepSaved} disabled={busy}>Keep saved workflow</button>
        </> : null}
        {(state === "warning" || state === "interrupted") ?
          <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" onClick={onKeepSaved} disabled={busy}>Dismiss</button> : null}
      </div>
    </section>
  );
}
