import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ConnectorImporter, {
  CONNECTOR_SOURCE_MAX_BYTES,
  acceptsLocalJsonFile,
  decodeLocalJsonFile,
  inspectOpenApiSource,
  settleOwnedCall,
} from "@/components/connectors/ConnectorImporter";
import type { ConnectorClient } from "@/lib/connectors/client";

const source = readFileSync("src/components/connectors/ConnectorImporter.tsx", "utf8");
const inertClient = {
  list: vi.fn(), get: vi.fn(), rename: vi.fn(), archive: vi.fn(), reviewOpenApi: vi.fn(),
  addOperation: vi.fn(), listOperations: vi.fn(), resolveOperations: vi.fn(),
} satisfies ConnectorClient;

describe("ConnectorImporter", () => {
  it("accepts only bounded UTF-8 JSON source and local JSON files", () => {
    expect(CONNECTOR_SOURCE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(inspectOpenApiSource('{"openapi":"3.1.0"}')).toEqual({ ok: true, bytes: 19 });
    expect(inspectOpenApiSource(" ")).toEqual({ ok: false, reason: "empty" });
    expect(inspectOpenApiSource("x".repeat(CONNECTOR_SOURCE_MAX_BYTES + 1))).toEqual({ ok: false, reason: "too-large" });
    expect(acceptsLocalJsonFile({ name: "vendor.json", type: "application/json", size: 12 })).toBe(true);
    expect(acceptsLocalJsonFile({ name: "vendor.yaml", type: "application/json", size: 12 })).toBe(false);
    expect(acceptsLocalJsonFile({ name: "vendor.json", type: "text/plain", size: 12 })).toBe(false);
    expect(acceptsLocalJsonFile({ name: "vendor.json", type: "application/json", size: CONNECTOR_SOURCE_MAX_BYTES + 1 })).toBe(false);
  });

  it("decodes local bytes as fatal UTF-8 and refuses mismatched or invalid files", async () => {
    const validBytes = new TextEncoder().encode('{"openapi":"3.1.0"}');
    const valid = { name: "vendor.json", type: "application/json", size: validBytes.byteLength, arrayBuffer: async () => validBytes.buffer.slice(validBytes.byteOffset, validBytes.byteOffset + validBytes.byteLength) };
    await expect(decodeLocalJsonFile(valid)).resolves.toEqual({ ok: true, source: '{"openapi":"3.1.0"}', bytes: 19 });

    const invalidBytes = Uint8Array.from([0xc3, 0x28]);
    const invalid = { name: "vendor.json", type: "application/json", size: invalidBytes.byteLength, arrayBuffer: async () => invalidBytes.buffer.slice(invalidBytes.byteOffset, invalidBytes.byteOffset + invalidBytes.byteLength) };
    await expect(decodeLocalJsonFile(invalid)).resolves.toEqual({ ok: false, reason: "invalid-utf8" });
    await expect(decodeLocalJsonFile({ ...valid, size: valid.size - 1 })).resolves.toEqual({ ok: false, reason: "too-large" });
  });

  it("drops deferred success and refusal settlements after ownership changes", async () => {
    let current = true;
    let resolve!: (value: string) => void;
    const deferred = new Promise<string>((done) => { resolve = done; });
    const staleSuccess = settleOwnedCall(() => deferred, () => current);
    current = false;
    resolve("stale source");
    await expect(staleSuccess).resolves.toEqual({ status: "stale" });

    current = true;
    let reject!: (error: Error) => void;
    const refusal = new Promise<string>((_done, fail) => { reject = fail; });
    const staleRefusal = settleOwnedCall(() => refusal, () => current);
    current = false;
    reject(new Error("source canary"));
    await expect(staleRefusal).resolves.toEqual({ status: "stale" });
  });

  it("renders an honest two-stage review and materialization surface", () => {
    const markup = renderToStaticMarkup(createElement(ConnectorImporter, { client: inertClient }));
    expect(markup).toContain("Review a local OpenAPI file");
    expect(markup).toContain("Raw JSON is kept only in this tab while review is pending");
    expect(markup).toContain("The sanitized API index is created or reused");
    expect(markup).toContain("Prototype: simulation only");
    expect(markup).toContain('accept=".json,application/json"');
    expect(markup).toContain('autoComplete="off"');
    expect(markup).toContain('spellCheck="false"');
    expect(markup).not.toContain("URL");
  });

  it("names every immutable hash receipt with its exact authority", () => {
    expect(source).toContain("Connector projection hash {shortHash(review.definition.connectorProjectionHash)}");
    expect(source).toContain("Operation projection hash {shortHash(materialized.operation.operationProjectionHash)}");
    expect(source).toContain("Schema hash {shortHash(materialized.operation.schemaHash)}");
    expect(source).not.toContain("<span>Projection {");
    expect(source).not.toContain("<span>Schema {");
  });

  it("keeps raw source memory-only and clears it on terminal outcomes and unmount", () => {
    expect(source).toContain("new TextEncoder()");
    expect(source).toContain('new TextDecoder("utf-8", { fatal: true })');
    expect(source).toContain("generationRef.current");
    expect(source).toContain("mountedRef.current");
    expect(source).toContain("source.length > CONNECTOR_SOURCE_MAX_BYTES");
    expect(source.indexOf("source.length > CONNECTOR_SOURCE_MAX_BYTES")).toBeLessThan(source.indexOf("source.trim().length"));
    expect(source).toContain("maxLength={CONNECTOR_SOURCE_MAX_BYTES}");
    expect(source).toContain("updateDisplayLabel");
    expect(source).toContain("setRawSource(\"\")");
    expect(source).toContain("return () =>");
    expect(source).toContain("fileInputRef.current.value = \"\"");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|console\.|URLSearchParams/u);
    expect(source).not.toMatch(/JSON\.stringify\([^)]*rawSource/u);
    expect(source).not.toMatch(/setAnnouncement\([^)]*(?:rawSource|error\.message)/u);
    expect(source).toContain("Operation IDs and paths are untrusted public metadata");
  });

  it("provides focus, announcements, 44px controls, and reduced-motion handling", () => {
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('role="status"');
    expect(source).toContain("reviewHeadingRef.current?.focus()");
    expect(source).toContain("minHeight: 44");
    expect(source).toContain("prefers-reduced-motion: reduce");
  });

  it("server-gates the import route before rendering Connector Lab client surfaces", () => {
    const page = readFileSync("src/app/connections/import-api/page.tsx", "utf8");
    const connections = readFileSync("src/app/connections/page.tsx", "utf8");
    expect(page).toContain("if (!CONNECTOR_LAB_ENABLED) notFound();");
    expect(page.indexOf("if (!CONNECTOR_LAB_ENABLED) notFound();")).toBeLessThan(page.indexOf("<ConnectorImporter"));
    expect(page).toContain('<ConnectorBrowser mode="manage" />');
    expect(connections).toContain("connectorLabEnabled={CONNECTOR_LAB_ENABLED}");
  });
});
