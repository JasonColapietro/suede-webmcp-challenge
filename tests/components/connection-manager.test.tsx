import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ConnectionManager, {
  BUSINESS_CONNECTION_PRESETS,
  connectionManagerDisplayName,
} from "@/components/connections/ConnectionManager";
import type { ConnectionClient } from "@/lib/connections/client";
import type { ConnectionView } from "@/lib/connections/types";

const source = readFileSync("src/components/connections/ConnectionManager.tsx", "utf8");

const inertClient: ConnectionClient = {
  list: vi.fn(), get: vi.fn(), create: vi.fn(), rename: vi.fn(),
  configureSlot: vi.fn(), revokeSlot: vi.fn(), usage: vi.fn(),
};

describe("ConnectionManager contract", () => {
  it("renders the honest Test, Live, and cost boundaries", () => {
    const markup = renderToStaticMarkup(createElement(ConnectionManager, { client: inertClient, connectorLabEnabled: false }));
    expect(markup).toContain("One connection. Two sealed credential slots.");
    expect(markup).toContain("Current previews and scoped Test runs do not use this slot");
    expect(markup).toContain("Only published Live runs resolve credentials");
    expect(markup).toContain("Suede adds no connector subscription");
    expect(markup).toContain("Target APIs and self-hosting may cost money or create side effects");
  });

  it("renders the Connector Lab entry only when the server-derived flag is enabled", () => {
    const disabled = renderToStaticMarkup(createElement(ConnectionManager, { client: inertClient, connectorLabEnabled: false }));
    const enabled = renderToStaticMarkup(createElement(ConnectionManager, { client: inertClient, connectorLabEnabled: true }));
    expect(disabled).not.toContain("Connector Lab");
    expect(disabled).not.toContain("Prototype: simulation only");
    expect(disabled).not.toContain("/connections/import-api");
    expect(enabled).toContain("Connector Lab: Import API");
    expect(enabled).toContain("Prototype: simulation only");
    expect(enabled).toContain('href="/connections/import-api"');
    expect(source).not.toContain("var(--ink)");
  });

  it("models every slot transition and gates reviewed mutations on the current revision", () => {
    expect(source).toContain('slot.status === "missing" ? "configure"');
    expect(source).toContain('slot.status === "revoked" ? "reconfigure" : "rotate"');
    expect(source).toContain('next.kind !== "configure"');
    expect(source).toContain("client.usage(next.connection.id, { limit: 100 })");
    expect(source).toContain("usage.lifecycleRevision !== next.connection.lifecycleRevision");
    expect(source).toContain("Usage review failed. Rotate, reconfigure, and revoke stay disabled.");
    expect(source).toContain("at least ${dialog.usage.matchedLowerBound} references, list incomplete");
  });

  it("requires typed Live confirmation and handles stale conflicts by refreshing", () => {
    expect(source).toContain('liveConfirmation !== "LIVE"');
    expect(source).toContain("Type LIVE to confirm");
    expect(source).toContain("error.status === 409");
    expect(source).toContain("Connection state changed in another tab. Metadata was refreshed.");
    expect(source).toContain("await load()");
  });

  it("clears secret state and never persists or rehydrates credential material", () => {
    expect(source).toContain("setSecretValues(emptySecrets())");
    expect(source).toContain('type="password"');
    expect(source).toContain('autoComplete="off"');
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/u);
    expect(source).not.toMatch(/setSecretValues\([^)]*(?:connection|response|result)/u);
  });

  it("implements native dialog keyboard behavior, focus return, and accessible controls", () => {
    expect(source).toContain("<dialog");
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain('event.key !== "Tab"');
    expect(source).toContain("returnFocusRef.current?.focus()");
    expect(source).toContain("minHeight: 44");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('role="status"');
    expect(source).toContain("prefers-reduced-motion: reduce");
    expect(source).toContain("Configured");
    expect(source).toContain("Revoked");
    expect(source).toContain("Missing");
  });

  it("disambiguates duplicate names with a stable short ID in cards and action labels", () => {
    const connection = (id: string): ConnectionView => ({
      id,
      name: "Shared API",
      kind: "bearer",
      publicConfig: {},
      lifecycleRevision: 1,
      slots: {
        test: { environment: "test", status: "configured", secretVersion: 1, updatedAt: 1, revokedAt: null },
        live: { environment: "live", status: "configured", secretVersion: 1, updatedAt: 1, revokedAt: null },
      },
      createdAt: 1,
      updatedAt: 1,
    });
    const duplicates = [connection("conn_primary_aaa111"), connection("conn_primary_bbb222")];

    expect(connectionManagerDisplayName(duplicates[0]!, duplicates)).toBe("Shared API · …aaa111");
    expect(connectionManagerDisplayName(duplicates[1]!, duplicates)).toBe("Shared API · …bbb222");
    expect(connectionManagerDisplayName(duplicates[0]!, [duplicates[0]!])).toBe("Shared API");
    expect(source).toContain("aria-label={`${displayName} connection`}");
    expect(source).toContain("aria-label={`Rename ${displayName}`}");
    expect(source).toContain("aria-label={`${actionLabel} ${environment} slot for ${displayName}`}");
    expect(source).toContain("aria-label={`Revoke ${environment} slot for ${displayName}`}");
  });

  it("offers safe webhook presets for Slack and CRM action nodes", () => {
    const markup = renderToStaticMarkup(createElement(ConnectionManager, {
      client: inertClient,
      connectorLabEnabled: false,
    }));
    expect(BUSINESS_CONNECTION_PRESETS).toEqual([
      {
        id: "webhook",
        label: "Webhook endpoint",
        suggestedName: "Webhook",
        headerNames: ["X-Suede-Webhook-Url"],
      },
      {
        id: "authenticated-webhook",
        label: "Webhook + authorization",
        suggestedName: "Authenticated webhook",
        headerNames: ["X-Suede-Webhook-Url", "Authorization"],
      },
    ]);
    expect(markup).toContain("Quick setup for business actions");
    expect(markup).toContain("Webhook endpoint");
    expect(markup).toContain("Webhook + authorization");
    expect(markup).toContain("Slack uses only the endpoint");
    expect(markup).toContain("CRM can also forward authorization");
  });
});
