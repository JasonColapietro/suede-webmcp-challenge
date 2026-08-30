/**
 * The zod boundary between the browser storefront and the public shelf feed.
 *
 * The failure direction is the point: anything unreadable must land on
 * not-buyable. A shelf entry the client cannot parse must never be presented to
 * a spending agent as payable.
 */
import { describe, it, expect } from "vitest";
import { isBuyable, isPreviewable, parseShelf } from "@/lib/webmcp/shelf-contract";

const entry = {
  id: "id-1",
  slug: "contract-review",
  name: "Contract Review",
  summary: "Flags renewal risk.",
  priceUsdc: 2,
  inputSchema: { type: "object" },
  readiness: {
    state: "live",
    publishedLive: true,
    acceptsPayment: true,
    previewAvailable: true,
    hasSettledCalls: true,
    settledCalls: 3,
    lastCallAt: 12,
  },
  urls: { public: "p", run: "r", x402: "x", agentCard: "c", a2a: "a" },
};

const envelope = {
  service: "Suede Business Operations",
  operator: "Suede Labs AI",
  collection: "business-operations",
  count: 1,
  services: [entry],
};

describe("parseShelf", () => {
  it("accepts the live /api/services envelope", () => {
    const parsed = parseShelf(envelope);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.shelf.services[0]?.slug).toBe("contract-review");
  });

  it("tolerates server-side fields added later", () => {
    const forward = {
      ...envelope,
      newTopLevelField: 1,
      services: [{ ...entry, somethingNew: true }],
    };
    expect(parseShelf(forward).ok).toBe(true);
  });

  it("rejects a body missing readiness rather than guessing at it", () => {
    const { readiness: _drop, ...withoutReadiness } = entry;
    const parsed = parseShelf({ ...envelope, services: [withoutReadiness] });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain("readiness");
  });

  it("rejects a non-object body without throwing", () => {
    for (const body of [null, undefined, 42, "text", []]) {
      expect(parseShelf(body).ok).toBe(false);
    }
  });

  it("rejects a price that is not a number", () => {
    expect(parseShelf({ ...envelope, services: [{ ...entry, priceUsdc: "2" }] }).ok).toBe(false);
  });
});

describe("buyability is forwarded, never recomputed", () => {
  it("is buyable only when the server says payable AND published live", () => {
    expect(isBuyable(entry)).toBe(true);
    expect(isBuyable({ ...entry, readiness: { ...entry.readiness, acceptsPayment: false } })).toBe(false);
    // publishedLive false also covers "we could not tell", which must fail closed.
    expect(isBuyable({ ...entry, readiness: { ...entry.readiness, publishedLive: false } })).toBe(false);
  });

  it("reads previewability straight from the server projection", () => {
    expect(isPreviewable(entry)).toBe(true);
    expect(isPreviewable({ ...entry, readiness: { ...entry.readiness, previewAvailable: false } })).toBe(false);
  });
});
