"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionClientError,
  createConnectionClient,
  type ConnectionClient,
} from "@/lib/connections/client";
import type { UsageEnvelope } from "@/lib/connections/api-contract";
import type {
  ConnectionCreateInput,
  ConnectionEnvironment,
  ConnectionKind,
  ConnectionSecretInput,
  ConnectionView,
} from "@/lib/connections/types";

type SlotAction = "configure" | "rotate" | "reconfigure" | "revoke";
type DialogState =
  | { readonly kind: "rename"; readonly connection: ConnectionView }
  | {
      readonly kind: SlotAction;
      readonly connection: ConnectionView;
      readonly environment: ConnectionEnvironment;
      readonly usage: UsageEnvelope | null;
    };

export interface ConnectionManagerProps {
  readonly client?: ConnectionClient;
  readonly connectorLabEnabled?: boolean;
}

export const BUSINESS_CONNECTION_PRESETS = Object.freeze([
  Object.freeze({
    id: "webhook",
    label: "Webhook endpoint",
    suggestedName: "Webhook",
    headerNames: Object.freeze(["X-Suede-Webhook-Url"]),
  }),
  Object.freeze({
    id: "authenticated-webhook",
    label: "Webhook + authorization",
    suggestedName: "Authenticated webhook",
    headerNames: Object.freeze(["X-Suede-Webhook-Url", "Authorization"]),
  }),
]);

const control: React.CSSProperties = {
  minHeight: 44,
  width: "100%",
  display: "block",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--hairline)",
  background: "var(--ink-control)",
  color: "var(--text-primary)",
  padding: "10px 12px",
};

/**
 * The trust panel. Every claim here is grounded in code, not aspiration:
 * sealing is AES-256-GCM in connections/crypto.ts (bound to owner, connection,
 * kind, environment, and secret version through the AAD); ConnectionView in
 * connections/types.ts carries no secret field, so nothing sealed can come back
 * over the API; a graph node stores a SecretReference of
 * `{ connectionId, field }` (flow/value-bindings.ts); and revokeSlot NULLs the
 * ciphertext, nonce, and auth tag rather than flagging a row.
 */
const POSTURE = Object.freeze([
  Object.freeze({
    k: "Sealed at rest",
    title: "What a value becomes.",
    body: "A secret is encrypted the moment it arrives, bound to this workspace, this connection, and one environment. It is never returned by the API and never rendered back into this page.",
  }),
  Object.freeze({
    k: "Reference, not value",
    title: "What a flow carries.",
    body: "A node stores a pointer to the connection, not the credential. Versioning, exporting, or handing off a flow moves the pointer. The value stays here.",
  }),
  Object.freeze({
    k: "Metadata is visible",
    title: "What stays readable.",
    body: "The name, the authentication kind, and the header names are ordinary metadata you can read and edit. The header values are the sealed part.",
  }),
  Object.freeze({
    k: "Resolution rules",
    title: "When a credential is used.",
    body: "Test credentials are stored only. Current previews and scoped Test runs do not use this slot. Only published Live runs resolve credentials, and every Live change asks you to type LIVE first.",
  }),
]);

function emptySecrets(): Record<string, string> {
  return { apiKey: "", token: "", username: "", password: "", custom: "" };
}

function slotLabel(status: string): string {
  if (status === "configured") return "Configured";
  if (status === "revoked") return "Revoked";
  return "Missing";
}

/** Short, state-specific truth for one slot; the general rules live in POSTURE. */
function slotNote(status: string, environment: ConnectionEnvironment): string {
  if (status === "configured") {
    return environment === "test"
      ? "Sealed and stored. Nothing resolves it yet."
      : "Sealed. Published Live runs resolve it.";
  }
  if (status === "revoked") return "Sealed value erased. Reconfigure to restore.";
  return "Nothing stored in this slot.";
}

export function connectionManagerDisplayName(
  connection: ConnectionView,
  connections: readonly ConnectionView[],
): string {
  const duplicate = connections.some((candidate) =>
    candidate.id !== connection.id && candidate.name === connection.name);
  return duplicate ? `${connection.name} · …${connection.id.slice(-6)}` : connection.name;
}

function createInput(name: string, kind: ConnectionKind, headerInput: string): ConnectionCreateInput {
  if (kind === "api_key") {
    return { name, kind, publicConfig: { headerName: headerInput.trim() } };
  }
  if (kind === "custom_headers") {
    return {
      name,
      kind,
      publicConfig: { headerNames: headerInput.split(",").map((item) => item.trim()).filter(Boolean) },
    };
  }
  return { name, kind, publicConfig: {} };
}

function secretInput(connection: ConnectionView, values: Record<string, string>): ConnectionSecretInput {
  if (connection.kind === "api_key") return { kind: "api_key", apiKey: values.apiKey };
  if (connection.kind === "bearer") return { kind: "bearer", token: values.token };
  if (connection.kind === "basic") {
    return { kind: "basic", username: values.username, password: values.password };
  }
  const names = Array.isArray(connection.publicConfig.headerNames)
    ? connection.publicConfig.headerNames
    : [];
  const submitted = values.custom.split("\n");
  return {
    kind: "custom_headers",
    values: Object.fromEntries(names.map((name, index) => [name, submitted[index] ?? ""])),
  };
}

export default function ConnectionManager({
  client: suppliedClient,
  connectorLabEnabled = false,
}: ConnectionManagerProps): React.JSX.Element {
  const client = useMemo(() => suppliedClient ?? createConnectionClient(), [suppliedClient]);
  const [connections, setConnections] = useState<readonly ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ConnectionKind>("bearer");
  const [headerInput, setHeaderInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [secretValues, setSecretValues] = useState(emptySecrets);
  const [liveConfirmation, setLiveConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const initialFocusRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const envelope = await client.list({ limit: 100 });
      setConnections(envelope.connections);
    } catch {
      setLoadError("Connection metadata is unavailable. Ordinary workflow editing still works.");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (dialog) {
      const element = dialogRef.current;
      if (element && !element.open && typeof element.showModal === "function") element.showModal();
      initialFocusRef.current?.focus();
    }
  }, [dialog]);

  const closeDialog = useCallback(() => {
    if (dialogRef.current?.open) dialogRef.current.close();
    setDialog(null);
    setRenameValue("");
    setSecretValues(emptySecrets());
    setLiveConfirmation("");
    queueMicrotask(() => returnFocusRef.current?.focus());
  }, []);

  const begin = useCallback(async (
    next: Omit<Extract<DialogState, { kind: SlotAction }>, "usage"> | Extract<DialogState, { kind: "rename" }>,
    trigger: HTMLElement,
  ): Promise<void> => {
    returnFocusRef.current = trigger;
    if (next.kind === "rename") {
      setRenameValue(next.connection.name);
      setDialog(next);
      return;
    }
    const needsReview = next.kind !== "configure";
    if (!needsReview) {
      setDialog({ ...next, usage: null });
      return;
    }
    setAnnouncement("Loading current connection usage before this change.");
    try {
      const usage = await client.usage(next.connection.id, { limit: 100 });
      if (usage.lifecycleRevision !== next.connection.lifecycleRevision) {
        setAnnouncement("Connection state changed. Metadata was refreshed before the action could continue.");
        await load();
        return;
      }
      setDialog({ ...next, usage });
      setAnnouncement("");
    } catch {
      setAnnouncement("Usage review failed. Rotate, reconfigure, and revoke stay disabled.");
    }
  }, [client, load]);

  const handleCreate = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    setCreating(true);
    try {
      const result = await client.create(createInput(name, kind, headerInput));
      setConnections((current) => Object.freeze([result.connection, ...current]));
      setName("");
      setHeaderInput("");
      setAnnouncement("Connection created. Configure Test or Live when you are ready.");
    } catch {
      setAnnouncement("Connection could not be created. Check the metadata and try again.");
    } finally {
      setCreating(false);
    }
  }, [client, headerInput, kind, name]);

  const applyBusinessPreset = useCallback((preset: typeof BUSINESS_CONNECTION_PRESETS[number]) => {
    setName((current) => current.trim() === "" ? preset.suggestedName : current);
    setKind("custom_headers");
    setHeaderInput(preset.headerNames.join(", "));
    setAnnouncement(`${preset.label} fields are ready. Create the connection, then configure its Test or Live values.`);
  }, []);

  const replaceConnection = (updated: ConnectionView): void => {
    setConnections((current) => Object.freeze(current.map((item) => item.id === updated.id ? updated : item)));
  };

  const submitDialog = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dialog || busy) return;
    if (dialog.kind !== "rename" && dialog.environment === "live" && liveConfirmation !== "LIVE") return;
    setBusy(true);
    try {
      let result;
      if (dialog.kind === "rename") {
        result = await client.rename(dialog.connection.id, {
          name: renameValue,
          expectedLifecycleRevision: dialog.connection.lifecycleRevision,
        });
      } else if (dialog.kind === "revoke") {
        result = await client.revokeSlot(dialog.connection.id, dialog.environment, {
          expectedLifecycleRevision: dialog.connection.lifecycleRevision,
        });
      } else {
        result = await client.configureSlot(dialog.connection.id, dialog.environment, {
          expectedLifecycleRevision: dialog.connection.lifecycleRevision,
          secret: secretInput(dialog.connection, secretValues),
        });
      }
      replaceConnection(result.connection);
      setAnnouncement(`${dialog.kind[0].toUpperCase()}${dialog.kind.slice(1)} complete.`);
      closeDialog();
    } catch (error) {
      setSecretValues(emptySecrets());
      if (error instanceof ConnectionClientError && error.status === 409) {
        setAnnouncement("Connection state changed in another tab. Metadata was refreshed.");
        closeDialog();
        await load();
      } else {
        setAnnouncement("The connection change failed. Secret fields were cleared.");
      }
    } finally {
      setBusy(false);
    }
  }, [busy, client, closeDialog, dialog, liveConfirmation, load, renameValue, secretValues]);

  const dialogTitle = dialog?.kind === "rename"
    ? "Rename connection"
    : dialog ? `${dialog.kind[0].toUpperCase()}${dialog.kind.slice(1)} ${dialog.environment}` : "";

  // Says what the confirm button will actually do. Presentation only: the gates
  // themselves live in submitDialog and begin.
  const dialogLede = dialog === null
    ? ""
    : dialog.kind === "rename"
      ? "Metadata only. Neither credential slot is touched."
      : dialog.kind === "revoke"
        ? "Erases the sealed value in this slot. Flows keep their reference and will fail to resolve until it is reconfigured."
        : dialog.kind === "rotate"
          ? "Replaces the sealed value in this slot. The old one is not recoverable."
          : "Seals a value into this slot. It is encrypted on arrival and never shown again.";

  return (
    <main id="main-content" className="connection-manager lp-shell lp-page">
      {/* Motion guard travels with the component: it must hold on any route that
          mounts the manager, not only where /connections/connections.css loads. */}
      <style>{`
        @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
      `}</style>

      <header className="ws-head">
        <h1>Connections</h1>
        <p className="ws-head-sub">
          One connection. Two sealed credential slots. Wire your agents to the accounts and APIs they act on
          — connect endpoints, seal secrets per environment, rotate or revoke a slot, and see which flows use each.
          Suede adds no connector subscription.
          Target APIs and self-hosting may cost money or create side effects.
        </p>
      </header>

      <section aria-label="How connection secrets are handled" className="cx-posture">
        {POSTURE.map((item) => (
          <article key={item.k} className="cx-posture-item">
            <span className="k">{item.k}</span>
            <h2>{item.title}</h2>
            <p>{item.body}</p>
          </article>
        ))}
      </section>

      {connectorLabEnabled ? (
        <aside className="cx-lab">
          <a href="/connections/import-api" className="lp-btn lp-btn--primary lp-btn--sm">
            Connector Lab: Import API
          </a>
          <span className="badge">Prototype: simulation only</span>
        </aside>
      ) : null}

      <section className="cx-new" aria-labelledby="cx-new-title">
        <span className="lp-eyebrow">Add a connection</span>
        <h2 id="cx-new-title">Quick setup for business actions</h2>
        <p className="cx-hint">
          Start from a preset or describe the authentication yourself. Creating a connection stores
          metadata only; credentials come later, one environment at a time.
        </p>

        <div className="cx-presets">
          {BUSINESS_CONNECTION_PRESETS.map((preset) => (
            <button key={preset.id} type="button" className="lp-btn lp-btn--ghost lp-btn--sm" onClick={() => applyBusinessPreset(preset)}>
              {preset.label}
            </button>
          ))}
          <p className="cx-hint">Slack uses only the endpoint. CRM can also forward authorization.</p>
        </div>

        <form className="cx-form" onSubmit={(event) => void handleCreate(event)}>
          <label className="cx-field">
            <span className="cx-field-label">Name</span>
            <input aria-label="Connection name" style={control} value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label className="cx-field">
            <span className="cx-field-label">Authentication</span>
            <select aria-label="Authentication kind" style={control} value={kind} onChange={(event) => setKind(event.target.value as ConnectionKind)}>
              <option value="bearer">Bearer token</option><option value="api_key">API key header</option><option value="basic">Basic auth</option><option value="custom_headers">Custom headers</option>
            </select>
          </label>
          <label className="cx-field">
            <span className="cx-field-label">{kind === "api_key" ? "Header name" : kind === "custom_headers" ? "Header names, comma separated" : "No public fields"}</span>
            <input aria-label="Public header names" disabled={kind === "bearer" || kind === "basic"} style={control} value={headerInput} onChange={(event) => setHeaderInput(event.target.value)} />
          </label>
          <button type="submit" disabled={creating} className="lp-btn lp-btn--primary lp-btn--sm cx-submit">{creating ? "Creating" : "Create connection"}</button>
        </form>
      </section>

      <p aria-live="polite" role="status" className="cx-announce">{announcement}</p>
      {loading ? <p className="lp-loading">Loading connection metadata…</p> : null}
      {loadError ? (
        <div role="alert" className="state-panel state-panel--error cx-retry">
          <p>{loadError}</p>
          <button className="lp-btn lp-btn--ghost lp-btn--sm" onClick={() => void load()}>Retry metadata</button>
        </div>
      ) : null}
      {!loading && !loadError && connections.length === 0 ? (
        <div className="lp-empty" style={{ textAlign: "left" }}>
          <b>No connections yet.</b>
          Create one above, then configure only the slot you need.
        </div>
      ) : null}

      <div className="cx-grid">
        {connections.map((connection) => {
          const displayName = connectionManagerDisplayName(connection, connections);
          return (
            <article key={connection.id} aria-label={`${displayName} connection`} className="cx-card">
              <div className="cx-card-head">
                <div>
                  <h2>{displayName}</h2>
                  <p className="cx-card-meta">{connection.kind.replaceAll("_", " ")}</p>
                </div>
                <button aria-label={`Rename ${displayName}`} className="lp-btn lp-btn--ghost lp-btn--sm" onClick={(event) => void begin({ kind: "rename", connection }, event.currentTarget)}>Rename</button>
              </div>
              <div className="cx-slots" aria-label={`${displayName} credential slots`}>
                {(["test", "live"] as const).map((environment) => {
                  const slot = connection.slots[environment];
                  const action: SlotAction = slot.status === "missing" ? "configure" : slot.status === "revoked" ? "reconfigure" : "rotate";
                  const actionLabel = `${action[0].toUpperCase()}${action.slice(1)}`;
                  return <section className={`cx-slot cx-slot--${slot.status}`} key={environment}>
                    <p className="env">{environment}</p>
                    <p className="cx-state"><span className="cx-dot" aria-hidden="true" /> {slotLabel(slot.status)}</p>
                    <p className="note">{slotNote(slot.status, environment)}</p>
                    <div className="cx-slot-actions">
                      <button aria-label={`${actionLabel} ${environment} slot for ${displayName}`} className="lp-btn lp-btn--ghost lp-btn--sm" onClick={(event) => void begin({ kind: action, connection, environment }, event.currentTarget)}>{actionLabel}</button>
                      {slot.status === "configured" ? <button aria-label={`Revoke ${environment} slot for ${displayName}`} className="lp-btn lp-btn--ghost lp-btn--sm" onClick={(event) => void begin({ kind: "revoke", connection, environment }, event.currentTarget)}>Revoke</button> : null}
                    </div>
                  </section>;
                })}
              </div>
            </article>
          );
        })}
      </div>

      {dialog ? <dialog ref={dialogRef} className="cx-dialog" aria-labelledby="connection-dialog-title" onCancel={(event) => { event.preventDefault(); closeDialog(); }} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); closeDialog(); return; }
        if (event.key !== "Tab") return;
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])') ?? [])];
        if (focusable.length === 0) return;
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <form onSubmit={(event) => void submitDialog(event)}>
          <h2 id="connection-dialog-title">{dialogTitle}</h2>
          <p className="cx-dialog-lede">{dialogLede}</p>
          {dialog.kind === "rename" ? <label className="cx-field"><span className="cx-field-label">New name</span><input ref={(node) => { initialFocusRef.current = node; }} style={control} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} /></label> : null}
          {dialog.kind !== "rename" && dialog.kind !== "revoke" ? <div>
            {dialog.connection.kind === "api_key" ? <label className="cx-field"><span className="cx-field-label">API key</span><input ref={(node) => { initialFocusRef.current = node; }} type="password" autoComplete="off" style={control} value={secretValues.apiKey} onChange={(event) => setSecretValues((current) => ({ ...current, apiKey: event.target.value }))} /></label> : null}
            {dialog.connection.kind === "bearer" ? <label className="cx-field"><span className="cx-field-label">Bearer token</span><input ref={(node) => { initialFocusRef.current = node; }} type="password" autoComplete="off" style={control} value={secretValues.token} onChange={(event) => setSecretValues((current) => ({ ...current, token: event.target.value }))} /></label> : null}
            {dialog.connection.kind === "basic" ? <><label className="cx-field"><span className="cx-field-label">Username</span><input ref={(node) => { initialFocusRef.current = node; }} type="password" autoComplete="off" style={control} value={secretValues.username} onChange={(event) => setSecretValues((current) => ({ ...current, username: event.target.value }))} /></label><label className="cx-field"><span className="cx-field-label">Password</span><input type="password" autoComplete="off" style={control} value={secretValues.password} onChange={(event) => setSecretValues((current) => ({ ...current, password: event.target.value }))} /></label></> : null}
            {dialog.connection.kind === "custom_headers" ? <label className="cx-field"><span className="cx-field-label">Header values, one per line</span><textarea ref={(node) => { initialFocusRef.current = node; }} autoComplete="off" style={{ ...control, minHeight: 100 }} value={secretValues.custom} onChange={(event) => setSecretValues((current) => ({ ...current, custom: event.target.value }))} /></label> : null}
          </div> : null}
          {dialog.kind !== "rename" && dialog.usage ? <div className="cx-usage" aria-label="Usage review"><p>{dialog.usage.truncated ? `at least ${dialog.usage.matchedLowerBound} references, list incomplete` : `${dialog.usage.matchedLowerBound} active references`}</p><ul>{dialog.usage.usage.map((item) => <li key={`${item.artifactKind}:${item.flowId}:${item.flowVersionId}:${item.environment}`}><Link href={`/build/${item.flowId}`}>{item.flowName}</Link> ({item.environment})</li>)}</ul></div> : null}
          {dialog.kind !== "rename" && dialog.environment === "live" ? <label className="cx-field"><span className="cx-field-label">Type LIVE to confirm</span><input ref={dialog.kind === "revoke" ? (node) => { initialFocusRef.current = node; } : undefined} style={control} value={liveConfirmation} onChange={(event) => setLiveConfirmation(event.target.value)} /></label> : null}
          <div className="cx-dialog-actions"><button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" onClick={closeDialog}>Cancel</button><button type="submit" className="lp-btn lp-btn--primary lp-btn--sm" disabled={busy || (dialog.kind !== "rename" && dialog.environment === "live" && liveConfirmation !== "LIVE")}>{busy ? "Working" : dialogTitle}</button></div>
        </form>
      </dialog> : null}
    </main>
  );
}
