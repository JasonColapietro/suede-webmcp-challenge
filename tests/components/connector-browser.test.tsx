import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ConnectorBrowser, {
  archiveConnectorForBrowser,
  connectorBrowserWorkAvailable,
  connectorBrowserDisplayLabel,
  loadConnectorBrowserDetails,
  loadConnectorBrowserPage,
  renameConnectorForBrowser,
  resolveOwnedPickerClosure,
  resolvedPickerClosure,
  settleOwnedBrowserCall,
} from "@/components/connectors/ConnectorBrowser";
import type { ConnectorClient } from "@/lib/connectors/client";
import type { ApiOperationBrowserClosureProjection } from "@/lib/connectors/operation-closure";

const source = readFileSync("src/components/connectors/ConnectorBrowser.tsx", "utf8");
const ID = "10000000-0000-4000-8000-000000000001";
const OP = "20000000-0000-4000-8000-000000000002";
const closure = {
  reference: {
    connectorDefinitionVersionId: "30000000-0000-4000-8000-000000000003",
    operationVersionId: OP,
    operationId: "createThing",
    connectorProjectionHash: "a".repeat(64), operationProjectionHash: "b".repeat(64), schemaHash: "c".repeat(64),
  },
  connectorId: ID, connectorDisplayLabel: "Vendor API", lifecycleRevision: 1, archivedAt: null,
  definitionVersionNumber: 1, method: "POST", path: "/things", authentication: { kind: "none" },
  requestSchema: { type: "object", properties: { path: { type: "object", properties: {}, required: [], additionalProperties: false }, query: { type: "object", properties: {}, required: [], additionalProperties: false }, headers: { type: "object", properties: {}, required: [], additionalProperties: false } }, required: ["path", "query", "headers"], additionalProperties: false },
  resultSchema: { type: "object", properties: { status: { type: "integer", minimum: 201, maximum: 201 }, body: { type: "object", properties: {}, required: [], additionalProperties: false } }, required: ["status", "body"], additionalProperties: false },
  systemPolicy: { effects: ["write"], retry: "unsafe", cost: "unknown", idempotency: "none" },
  authorAnnotation: null, executionAvailability: "simulation_only",
} satisfies ApiOperationBrowserClosureProjection;
const inertClient = {
  list: vi.fn(), get: vi.fn(), rename: vi.fn(), archive: vi.fn(), reviewOpenApi: vi.fn(),
  addOperation: vi.fn(), listOperations: vi.fn(), resolveOperations: vi.fn(),
} satisfies ConnectorClient;

describe("ConnectorBrowser", () => {
  it("uses a stable short suffix and returns only the exact resolved closure", () => {
    expect(connectorBrowserDisplayLabel({ id: ID, displayLabel: "Vendor API" })).toBe("Vendor API · …000001");
    expect(connectorBrowserDisplayLabel({ id: ID, displayLabel: "Vendor API" })).not.toContain(ID);
    expect(resolvedPickerClosure({ closures: [closure] }, OP)).toBe(closure);
    expect(resolvedPickerClosure({ closures: [closure] }, "40000000-0000-4000-8000-000000000004")).toBeNull();
    expect(resolvedPickerClosure({ closures: [closure, closure] }, OP)).toBeNull();
  });

  it("renders server-side search, pagination controls, and the import empty-state route", () => {
    const markup = renderToStaticMarkup(createElement(ConnectorBrowser, { client: inertClient, mode: "manage" }));
    expect(markup).toContain("Search APIs");
    expect(markup).toContain("Include archived");
    expect(markup).toContain("Connector Lab: Import API");
    expect(markup).toContain('href="/connections/import-api"');
    expect(markup).toContain("Prototype: simulation only");
  });

  it("loads details only for the expanded connector and resolves before picker callbacks", () => {
    expect(source).toContain("loadConnectorBrowserPage(client");
    expect(source).toContain("loadConnectorBrowserDetails(client, connector.id");
    expect(source).toContain("resolveOwnedPickerClosure({");
    expect(source).toContain("onPick(outcome.closure)");
    expect(source).not.toMatch(/connectors\.map\([\s\S]{0,400}client\.(?:get|listOperations)/u);
  });

  it("performs one server search and exactly one detail pair for the expanded connector", async () => {
    const list = vi.fn().mockResolvedValue({ connectors: [], nextCursor: null });
    const get = vi.fn().mockResolvedValue({ connector: { id: ID, displayLabel: "Vendor API", archivedAt: null, lifecycleRevision: 7, createdAt: 1, updatedAt: 1 }, history: [], nextCursor: null });
    const listOperations = vi.fn().mockResolvedValue({ operations: [], nextCursor: null });
    const client = { ...inertClient, list, get, listOperations } satisfies ConnectorClient;
    const controller = new AbortController();

    await loadConnectorBrowserPage(client, { cursor: "cursor_2", search: "vendor", includeArchived: true }, controller.signal);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ limit: 30, cursor: "cursor_2", search: "vendor", includeArchived: true }, controller.signal);

    await loadConnectorBrowserDetails(client, ID, controller.signal);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(ID, { limit: 30 }, controller.signal);
    expect(listOperations).toHaveBeenCalledTimes(1);
    expect(listOperations).toHaveBeenCalledWith(ID, { limit: 30 }, controller.signal);
  });

  it("binds rename and archive to the observed lifecycle revision", async () => {
    const identity = { id: ID, displayLabel: "Vendor API", archivedAt: null, lifecycleRevision: 7, createdAt: 1, updatedAt: 1 };
    const rename = vi.fn().mockResolvedValue({ connector: identity });
    const archive = vi.fn().mockResolvedValue({ connector: { ...identity, archivedAt: 2, lifecycleRevision: 8 } });
    const client = { ...inertClient, rename, archive } satisfies ConnectorClient;
    const signal = new AbortController().signal;
    await renameConnectorForBrowser(client, identity, "Vendor Two", signal);
    await archiveConnectorForBrowser(client, identity, signal);
    expect(rename).toHaveBeenCalledWith(ID, { action: "rename", displayLabel: "Vendor Two", expectedLifecycleRevision: 7 }, signal);
    expect(archive).toHaveBeenCalledWith(ID, 7, signal);
  });

  it("resolves before selection and drops a deferred closure after ownership changes", async () => {
    let release!: (value: { closures: readonly ApiOperationBrowserClosureProjection[] }) => void;
    const deferred = new Promise<{ closures: readonly ApiOperationBrowserClosureProjection[] }>((done) => { release = done; });
    const resolveOperations = vi.fn().mockReturnValue(deferred);
    const client = { ...inertClient, resolveOperations } satisfies ConnectorClient;
    let current = true;
    const pending = resolveOwnedPickerClosure({ client, operationVersionId: OP, signal: new AbortController().signal, isCurrent: () => current });
    expect(resolveOperations).toHaveBeenCalledWith([OP], expect.any(AbortSignal));
    current = false;
    release({ closures: [closure] });
    await expect(pending).resolves.toEqual({ status: "stale" });

    await expect(resolveOwnedPickerClosure({
      client: { ...client, resolveOperations: vi.fn().mockResolvedValue({ closures: [closure] }) },
      operationVersionId: OP,
      signal: new AbortController().signal,
      isCurrent: () => true,
    })).resolves.toEqual({ status: "resolved", closure });
  });

  it("mutually excludes detail pagination and mutations and drops an older deferred page", async () => {
    expect(connectorBrowserWorkAvailable(null, false)).toBe(true);
    expect(connectorBrowserWorkAvailable("rename", false)).toBe(false);
    expect(connectorBrowserWorkAvailable(null, true)).toBe(false);

    let generation = 1;
    let release!: (value: string) => void;
    const deferredPage = new Promise<string>((done) => { release = done; });
    const pending = settleOwnedBrowserCall(() => deferredPage, () => generation === 1);
    generation = 2;
    release("old connector revision");
    await expect(pending).resolves.toEqual({ status: "stale" });
  });

  it("supports a keyboard-contained picker with cancellation and fixed receipts", () => {
    const markup = renderToStaticMarkup(createElement(ConnectorBrowser, { client: inertClient, mode: "pick", onPick: vi.fn(), onClose: vi.fn() }));
    expect(markup).toContain("Choose an API operation");
    expect(markup).toContain("dialog");
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain('event.key !== "Tab"');
    expect(source).toContain("returnFocusRef?.current?.focus()");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("AbortController");
    expect(source).toContain("prefers-reduced-motion: reduce");
    expect(source).not.toContain('role="listbox"');
    expect(source).not.toContain('role="option"');
    expect(source).toContain("More definition history");
    expect(source).toContain("Operation IDs and paths are untrusted public metadata");
    expect(source).toMatch(/onPick\(outcome\.closure\);[\s\S]{0,180}queueMicrotask\(\(\) => returnFocusRef\?\.current\?\.focus\(\)\)/u);
  });

  it("never renders or persists source, credentials, rejected values, or full IDs", () => {
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|console\./u);
    expect(source).not.toMatch(/rawSource|credentialValue|rejectedValue/u);
    expect(source).not.toMatch(/>\{connector\.id\}</u);
    expect(source).not.toMatch(/>\{operation\.operationVersionId\}</u);
  });
});
