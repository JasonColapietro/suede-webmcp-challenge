import { describe, it, expect, vi } from "vitest";
import {
  createFetchUrlExecutor,
  fetchUrlDryRunStub,
  fetchUrlNode,
  fetchUrlParamsSchema,
} from "@/lib/flow/nodes/web/fetchUrl";
import { createHttpExecutor } from "@/lib/flow/nodes/http";
import { NODE_DEFS } from "@/lib/flow/nodes";
import { NODE_META, getNodeMeta } from "@/lib/flow/node-meta";
import { getNodeDefinition } from "@/lib/flow/node-definitions";
import { makeCtx } from "../../_helpers";

// A lookup that never touches real DNS — every hostname resolves public unless
// a test overrides it (mirrors the http node's own SSRF fixtures).
const publicLookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

function htmlResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
function jsonResponse(status: number, data: unknown) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function fetchUrlWith(fetchFn: ReturnType<typeof vi.fn>) {
  return createFetchUrlExecutor(createHttpExecutor({ fetchFn, lookupFn: publicLookup }));
}

describe("web.fetchUrl registration", () => {
  it("is registered as an executor, catalog definition, and client-safe meta", () => {
    expect(NODE_DEFS.some((d) => d.type === "web.fetchUrl")).toBe(true);
    expect(NODE_META.some((m) => m.type === "web.fetchUrl")).toBe(true);
    expect(getNodeMeta("web.fetchUrl")?.priceUsdc).toBeUndefined();
    expect(getNodeDefinition("web.fetchUrl").category).toBe("Docs & Data");
  });

  it("is cost-bearing and centrally guarded with a dry-run stub", () => {
    const def = NODE_DEFS.find((d) => d.type === "web.fetchUrl")!;
    expect(def.costBearing).toBe(true);
    expect(def.sideEffecting).toBe(false);
    expect(def.dryRunStub).toBeTypeOf("function");
  });
});

describe("web.fetchUrl schema", () => {
  it("defaults extract to text and drops any method a caller tries to smuggle in", () => {
    const parsed = fetchUrlParamsSchema.parse({ url: "https://example.com", method: "POST" });
    expect(parsed.extract).toBe("text");
    expect((parsed as Record<string, unknown>).method).toBeUndefined();
  });

  it("rejects a missing url and an out-of-range maxChars", () => {
    expect(() => fetchUrlParamsSchema.parse({})).toThrow();
    expect(() => fetchUrlParamsSchema.parse({ url: "https://example.com", maxChars: 0 })).toThrow();
    expect(() => fetchUrlParamsSchema.parse({ url: "https://example.com", maxChars: 999_999 })).toThrow();
  });
});

describe("web.fetchUrl executor", () => {
  it("issues a GET (never any other method) to the resolved URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue(htmlResponse("<p>ok</p>"));
    const executor = fetchUrlWith(fetchFn);
    const res = await executor(makeCtx(), { url: "https://example.com/{{in.path}}" }, { in: { path: "status" } });
    expect(res.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(calledUrl).toBe("https://example.com/status");
    if (res.ok) expect((res.outputs.result as { url: string }).url).toBe("https://example.com/status");
  });

  it("strips HTML to bounded readable text and decodes entities", async () => {
    const html =
      "<!doctype html><html><head><title>T</title><style>.x{color:red}</style></head>" +
      "<body><script>evil()</script><h1>Status&nbsp;OK</h1><p>Cats&amp;Dogs</p></body></html>";
    const executor = fetchUrlWith(vi.fn().mockResolvedValue(htmlResponse(html)));
    const res = await executor(makeCtx(), { url: "https://example.com", extract: "text" }, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.outputs.result as { text: string; contentType: string | null };
      expect(result.contentType).toBe("text/html");
      // whitespace collapsed, &nbsp; and &amp; decoded, script/style dropped.
      expect(result.text).toContain("Status OK");
      expect(result.text).toContain("Cats&Dogs");
      expect(result.text).not.toContain("<");
      expect(result.text).not.toContain(">");
      expect(result.text).not.toContain("evil()");
      expect(result.text).not.toContain("color:red");
    }
  });

  it("bounds returned text to maxChars", async () => {
    const long = `<p>${"a".repeat(5000)}</p>`;
    const executor = fetchUrlWith(vi.fn().mockResolvedValue(htmlResponse(long)));
    const res = await executor(makeCtx(), { url: "https://example.com", extract: "text", maxChars: 100 }, {});
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.outputs.result as { text: string }).text.length).toBe(100);
  });

  it("returns parsed JSON under extract:json with no text field", async () => {
    const executor = fetchUrlWith(vi.fn().mockResolvedValue(jsonResponse(200, { price: 42, items: [1, 2] })));
    const res = await executor(makeCtx(), { url: "https://api.example.com/p", extract: "json" }, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.outputs.result as { json: unknown; text?: string; contentType: string | null };
      expect(result.json).toEqual({ price: 42, items: [1, 2] });
      expect(result.contentType).toBe("application/json");
      expect(result.text).toBeUndefined();
    }
  });

  it("extracts the first numeric price via pricePattern, honoring thousands separators", async () => {
    const executor = fetchUrlWith(
      vi.fn().mockResolvedValue(htmlResponse("<span>Now only <b>$1,234.56</b> today</span>")),
    );
    const res = await executor(
      makeCtx(),
      { url: "https://shop.example.com/item", extract: "text", pricePattern: "\\$([0-9,.]+)" },
      {},
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.outputs.result as { price: number | null }).price).toBe(1234.56);
  });

  it("interpolates pricePattern from upstream input and returns null when no match", async () => {
    const executor = fetchUrlWith(vi.fn().mockResolvedValue(htmlResponse("<p>Out of stock</p>")));
    const res = await executor(
      makeCtx(),
      { url: "https://shop.example.com/item", extract: "text", pricePattern: "{{in.pattern}}" },
      { in: { pattern: "\\$([0-9,.]+)" } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.outputs.result as { price: number | null }).price).toBeNull();
  });

  it("returns null price for an invalid regex instead of throwing", async () => {
    const executor = fetchUrlWith(vi.fn().mockResolvedValue(htmlResponse("<p>$9.99</p>")));
    const res = await executor(
      makeCtx(),
      { url: "https://shop.example.com/item", extract: "text", pricePattern: "([0-9" },
      {},
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.outputs.result as { price: number | null }).price).toBeNull();
  });

  it("surfaces a non-2xx status without failing the node", async () => {
    const executor = fetchUrlWith(vi.fn().mockResolvedValue(htmlResponse("<p>gone</p>", 404)));
    const res = await executor(makeCtx(), { url: "https://example.com/missing", extract: "text" }, {});
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.outputs.result as { status: number }).status).toBe(404);
  });

  it("rejects params that fail schema validation", async () => {
    const res = await fetchUrlWith(vi.fn())(makeCtx(), { url: "" }, {});
    expect(res.ok).toBe(false);
  });

  describe("SSRF: delegates blocking to the http executor", () => {
    it.each([
      ["localhost", "http://localhost:8080/admin"],
      ["private IP", "http://10.0.0.5/"],
      ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
      ["disallowed scheme", "file:///etc/passwd"],
    ])("blocks %s and never fetches", async (_label, url) => {
      const fetchFn = vi.fn();
      const res = await fetchUrlWith(fetchFn)(makeCtx(), { url }, {});
      expect(res.ok).toBe(false);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("blocks a hostname that resolves to a private address", async () => {
      const fetchFn = vi.fn();
      const rebinding = vi.fn().mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const executor = createFetchUrlExecutor(createHttpExecutor({ fetchFn, lookupFn: rebinding }));
      const res = await executor(makeCtx(), { url: "http://sneaky.example.com/" }, {});
      expect(res.ok).toBe(false);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });
});

describe("web.fetchUrl dry-run stub", () => {
  it("returns a placeholder envelope without touching the network", async () => {
    const res = await fetchUrlDryRunStub(makeCtx(), { url: "https://example.com", pricePattern: "\\$([0-9.]+)" }, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.outputs.result as { status: number; url: string; text: string; price: number | null };
      expect(result.status).toBe(200);
      expect(result.url).toBe("https://example.com");
      expect(result.text).toMatch(/dry-run/i);
      expect(result.price).toBeNull();
      expect(res.costUsdc).toBe(0);
    }
  });

  it("is the executor the real node exposes for dry runs", () => {
    expect(fetchUrlNode.dryRunStub).toBe(fetchUrlDryRunStub);
  });
});
