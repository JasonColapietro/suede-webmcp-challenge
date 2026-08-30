/**
 * Tests for src/lib/net/safe-url.ts — the single canonical SSRF guard, used
 * by both the agent relay (forwardToRelay, https-only) and the generic HTTP
 * flow node (src/lib/flow/nodes/http.ts, http+https via an explicit
 * `allowedProtocols` override). This file absorbs the former
 * tests/flow/ssrf-guard.test.ts coverage for the http-node guard, which
 * used to live as a separate module (src/lib/flow/nodes/ssrf-guard.ts)
 * before the two guards were deduped into this one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";

const lookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

describe("isBlockedIp", () => {
  it("blocks the cloud metadata address (169.254.169.254)", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("169.254.169.254")).toBe(true);
  });

  it("blocks IPv4 loopback", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.0.0.53")).toBe(true);
  });

  it("blocks IPv6 loopback", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("::1")).toBe(true);
  });

  it("blocks RFC1918 private ranges", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("10.0.0.5")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("172.31.255.255")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
  });

  it("does not block adjacent public-looking ranges outside 172.16-31", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("172.32.0.1")).toBe(false);
    expect(isBlockedIp("172.15.0.1")).toBe(false);
  });

  it("blocks IPv6 link-local (fe80::/10) and unique-local (fc00::/7)", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd12:3456:789a::1")).toBe(true);
  });

  it("blocks 0.0.0.0", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("0.0.0.0")).toBe(true);
  });

  it("allows a public IPv4 address", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("93.184.216.34")).toBe(false);
  });

  it("blocks IPv4-mapped IPv6, textual form (::ffff:a.b.c.d)", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.5")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6, WHATWG hex-normalized form (::ffff:7f00:1)", async () => {
    // `new URL("http://[::ffff:127.0.0.1]/").hostname` normalizes to
    // "[::ffff:7f00:1]" — the hex form, not the dotted-decimal form. A guard
    // that only pattern-matches the dotted form misses this entirely.
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    expect(isBlockedIp("::ffff:a00:5")).toBe(true); // 10.0.0.5
  });

  it("blocks the 0.0.0.0/8 network, not just the literal 0.0.0.0", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("0.1.2.3")).toBe(true);
  });

  it("blocks 100.64.0.0/10 (CGNAT / shared address space)", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("100.64.0.1")).toBe(true);
    expect(isBlockedIp("100.100.100.100")).toBe(true);
    expect(isBlockedIp("100.127.255.255")).toBe(true);
  });

  it("does not block addresses adjacent to the CGNAT range", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("100.63.255.255")).toBe(false);
    expect(isBlockedIp("100.128.0.0")).toBe(false);
  });

  it("does not flag a public IPv6 address", async () => {
    const { isBlockedIp } = await import("@/lib/net/safe-url");
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });
});

describe("isBlockedIPv4 / isBlockedIPv6 (direct range checks)", () => {
  it("does not flag well-known public IPv4 addresses", async () => {
    const { isBlockedIPv4 } = await import("@/lib/net/safe-url");
    expect(isBlockedIPv4("8.8.8.8")).toBe(false);
    expect(isBlockedIPv4("1.1.1.1")).toBe(false);
  });

  it("flags every mandated private/reserved IPv4 range", async () => {
    const { isBlockedIPv4 } = await import("@/lib/net/safe-url");
    expect(isBlockedIPv4("127.0.0.1")).toBe(true);
    expect(isBlockedIPv4("10.255.255.255")).toBe(true);
    expect(isBlockedIPv4("172.31.255.255")).toBe(true);
    expect(isBlockedIPv4("192.168.255.255")).toBe(true);
    expect(isBlockedIPv4("169.254.1.1")).toBe(true);
    expect(isBlockedIPv4("0.0.0.0")).toBe(true);
  });

  it("does not flag a public IPv6 address", async () => {
    const { isBlockedIPv6 } = await import("@/lib/net/safe-url");
    expect(isBlockedIPv6("2606:4700:4700::1111")).toBe(false);
  });

  it("flags loopback, link-local, and unique-local IPv6", async () => {
    const { isBlockedIPv6 } = await import("@/lib/net/safe-url");
    expect(isBlockedIPv6("::1")).toBe(true);
    expect(isBlockedIPv6("fe80::1")).toBe(true);
    expect(isBlockedIPv6("fc00::1")).toBe(true);
    expect(isBlockedIPv6("fd00::1")).toBe(true);
  });
});

describe("assertSafeUrl", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-https schemes", async () => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(assertSafeUrl("http://example.com/relay")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeUrl("ftp://example.com/relay")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects literal localhost", async () => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(assertSafeUrl("https://localhost/relay")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects *.local and *.internal hostnames", async () => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(assertSafeUrl("https://printer.local/relay")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeUrl("https://svc.internal/relay")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects a URL whose literal IP host is the cloud metadata address", async () => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(assertSafeUrl("https://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    expect(lookupMock).not.toHaveBeenCalled(); // literal IP short-circuits DNS
  });

  it("rejects a URL whose literal IP host is a private/loopback address", async () => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(assertSafeUrl("https://127.0.0.1/relay")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeUrl("https://10.0.0.5/relay")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects a hostname that resolves to an internal address (attacker-controlled DNS)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(assertSafeUrl("https://attacker-dns.example.com/relay")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it("rejects a rebinding-style hostname that resolves to a mix of public and internal addresses", async () => {
    // Round-robin DNS: one public answer, one internal answer. Must reject
    // because a client (or a subsequent lookup) could pick the internal one.
    lookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(assertSafeUrl("https://rebind.example.com/relay")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it("allows a normal public https URL", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const { assertSafeUrl } = await import("@/lib/net/safe-url");
    const url = await assertSafeUrl("https://relay.example.com/run");
    expect(url.hostname).toBe("relay.example.com");
    expect(lookupMock).toHaveBeenCalledWith("relay.example.com", { all: true });
  });

  it("fails closed when the hostname cannot be resolved", async () => {
    lookupMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(assertSafeUrl("https://does-not-exist.example.com/relay")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });
});

/**
 * These cover the same ground the generic HTTP node's guard used to cover on
 * its own (formerly validateOutboundUrl in src/lib/flow/nodes/ssrf-guard.ts)
 * — most notably that the guard must permit *both* http and https when the
 * caller opts in via `allowedProtocols`, unlike the relay's https-only
 * default. These use the `lookupFn` option (an injected resolver) instead of
 * mocking the `node:dns/promises` module, exactly like the http node's own
 * tests do, since that's how a real caller (http.ts) supplies it.
 */
describe("assertSafeUrl with an http+https allowlist (http-node style)", () => {
  const httpAndHttps = { allowedProtocols: ["http:", "https:"] };

  it("allows a public hostname over plain http that resolves to a public IPv4 address", async () => {
    const { assertSafeUrl } = await import("@/lib/net/safe-url");
    const lookupFn = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = await assertSafeUrl("http://example.com/api", { ...httpAndHttps, lookupFn });
    expect(url.hostname).toBe("example.com");
    expect(lookupFn).toHaveBeenCalledWith("example.com");
  });

  it("rejects a non-http(s) scheme without doing any DNS lookup", async () => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    const lookupFn = vi.fn();
    await expect(
      assertSafeUrl("ftp://example.com/file", { ...httpAndHttps, lookupFn }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("rejects an unparseable URL", async () => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(assertSafeUrl("not a url", httpAndHttps)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("blocks the literal hostname 'localhost' without a DNS lookup", async () => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    const lookupFn = vi.fn();
    await expect(
      assertSafeUrl("http://localhost:3000/admin", { ...httpAndHttps, lookupFn }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it.each(["http://api.local/x", "http://box.internal/x"])(
    "blocks *.local / *.internal suffixes (%s)",
    async (url) => {
      const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
      await expect(assertSafeUrl(url, { ...httpAndHttps, lookupFn: vi.fn() })).rejects.toBeInstanceOf(
        UnsafeUrlError,
      );
    },
  );

  it.each([
    ["http://127.0.0.1/", "loopback"],
    ["http://10.1.2.3/", "10.0.0.0/8 private"],
    ["http://172.16.0.5/", "172.16.0.0/12 private"],
    ["http://192.168.1.1/", "192.168.0.0/16 private"],
    ["http://169.254.169.254/latest/meta-data", "cloud metadata / link-local"],
    ["http://0.0.0.0/", "0.0.0.0"],
  ])("blocks the literal IPv4 URL %s (%s)", async (url) => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(assertSafeUrl(url, httpAndHttps)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it.each([
    ["http://[::1]/", "loopback"],
    ["http://[fe80::1]/", "link-local"],
    ["http://[fc00::1]/", "unique-local"],
    ["http://[fd12:3456::1]/", "unique-local"],
    ["http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
  ])("blocks the literal IPv6 URL %s (%s)", async (url) => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(assertSafeUrl(url, httpAndHttps)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("allows a public IPv4 literal", async () => {
    const { assertSafeUrl } = await import("@/lib/net/safe-url");
    const url = await assertSafeUrl("http://93.184.216.34/", httpAndHttps);
    expect(url.hostname).toBe("93.184.216.34");
  });

  it("blocks a hostname whose DNS resolution lands in a private range", async () => {
    const { assertSafeUrl } = await import("@/lib/net/safe-url");
    const lookupFn = vi.fn().mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(
      assertSafeUrl("http://sneaky.example.com/", { ...httpAndHttps, lookupFn }),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it("blocks when any one of multiple resolved addresses is private", async () => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    const lookupFn = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(
      assertSafeUrl("http://multi.example.com/", { ...httpAndHttps, lookupFn }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("fails closed when DNS resolution errors", async () => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    const lookupFn = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      assertSafeUrl("http://nowhere.example.com/", { ...httpAndHttps, lookupFn }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("fails closed when DNS resolution returns no addresses", async () => {
    const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/net/safe-url");
    const lookupFn = vi.fn().mockResolvedValue([]);
    await expect(
      assertSafeUrl("http://empty.example.com/", { ...httpAndHttps, lookupFn }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe("createPinnedDispatcher", () => {
  it("connects to the pinned address while preserving the original Host header", async () => {
    const ipv4Server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ server: "ipv4", host: request.headers.host }));
    });
    await new Promise<void>((resolve, reject) => {
      ipv4Server.once("error", reject);
      ipv4Server.listen(0, "127.0.0.1", resolve);
    });

    const address = ipv4Server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }

    const ipv6Server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ server: "ipv6", host: request.headers.host }));
    });
    await new Promise<void>((resolve, reject) => {
      ipv6Server.once("error", reject);
      ipv6Server.listen(address.port, "::1", resolve);
    });

    const { createPinnedDispatcher } = await import("@/lib/net/safe-url");
    const url = `http://localhost:${address.port}/`;

    try {
      const unpinned = await fetch(url);
      const unpinnedBody = await unpinned.json() as { server: "ipv4" | "ipv6"; host: string };
      const pinnedServer = unpinnedBody.server === "ipv4" ? "ipv6" : "ipv4";
      const transport = createPinnedDispatcher({
        hostname: "localhost",
        address: pinnedServer === "ipv4" ? "127.0.0.1" : "::1",
        family: pinnedServer === "ipv4" ? 4 : 6,
      });

      try {
        const response = await fetch(url, {
          dispatcher: transport.dispatcher,
        } as RequestInit & { dispatcher: unknown });
        expect(response.ok).toBe(true);
        expect(await response.json()).toEqual({
          server: pinnedServer,
          host: `localhost:${address.port}`,
        });
      } finally {
        await transport.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        ipv6Server.close((error) => (error ? reject(error) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        ipv4Server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("safeFetch", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("re-validates the URL immediately before the connection, then fetches on success", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const { safeFetch } = await import("@/lib/net/safe-url");

    const res = await safeFetch("https://relay.example.com/run", { method: "POST" });
    expect(res.status).toBe(200);
    expect(lookupMock).toHaveBeenCalledWith("relay.example.com", { all: true });
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  it("pins the socket to the validated address when DNS alternates public then private", async () => {
    const lookupFn = vi.fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const dispatcher = { identity: "pinned-public-dispatcher" };
    const close = vi.fn().mockResolvedValue(undefined);
    const dispatcherFactory = vi.fn(() => ({ dispatcher, close }));
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const { safeFetch } = await import("@/lib/net/safe-url");

    const response = await safeFetch("https://relay.example.com/run", {}, {
      lookupFn,
      dispatcherFactory,
    } as never);
    await response.text();

    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(dispatcherFactory).toHaveBeenCalledWith({
      address: "93.184.216.34",
      family: 4,
      hostname: "relay.example.com",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://relay.example.com/run",
      expect.objectContaining({ dispatcher, redirect: "manual" }),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("performs fresh validation and creates a fresh pin for every redirect hop", async () => {
    const lookupFn = vi.fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "93.184.216.35", family: 4 }]);
    const transports = [
      { dispatcher: { identity: "hop-1" }, close: vi.fn().mockResolvedValue(undefined) },
      { dispatcher: { identity: "hop-2" }, close: vi.fn().mockResolvedValue(undefined) },
    ];
    const dispatcherFactory = vi.fn()
      .mockReturnValueOnce(transports[0])
      .mockReturnValueOnce(transports[1]);
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/final" } }))
      .mockResolvedValueOnce(new Response("done", { status: 200 }));
    const { safeFetch } = await import("@/lib/net/safe-url");

    const response = await safeFetch("https://relay.example.com/start", {}, {
      lookupFn,
      dispatcherFactory,
    } as never);
    expect(response.url).toBe("https://relay.example.com/final");
    await response.text();

    expect(dispatcherFactory.mock.calls).toEqual([
      [{ address: "93.184.216.34", family: 4, hostname: "relay.example.com" }],
      [{ address: "93.184.216.35", family: 4, hostname: "relay.example.com" }],
    ]);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => [call[0], call[1].dispatcher]))
      .toEqual([
        ["https://relay.example.com/start", transports[0].dispatcher],
        ["https://relay.example.com/final", transports[1].dispatcher],
      ]);
    expect(transports[0].close).toHaveBeenCalledTimes(1);
    expect(transports[1].close).toHaveBeenCalledTimes(1);
  });

  it("does not call fetch at all when the URL is unsafe", async () => {
    const { safeFetch, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(safeFetch("https://127.0.0.1/relay")).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-validates every redirect hop and rejects a redirect to an internal address", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]); // initial hop, public
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } }),
    );
    const { safeFetch, UnsafeUrlError } = await import("@/lib/net/safe-url");

    await expect(safeFetch("https://relay.example.com/run")).rejects.toBeInstanceOf(UnsafeUrlError);
    // Only the first (validated) hop should have reached fetch — the redirect target never did.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caps the number of redirects followed", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    for (let i = 0; i < 10; i++) {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: `https://relay.example.com/hop-${i}` } }),
      );
    }
    const { safeFetch, UnsafeUrlError } = await import("@/lib/net/safe-url");
    await expect(safeFetch("https://relay.example.com/run", {}, { maxRedirects: 3 })).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4); // initial + 3 redirects
  });
});
