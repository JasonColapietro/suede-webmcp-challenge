import { describe, expect, it } from "vitest";
import {
  crawlSite,
  normalizeSiteUrl,
  scoreCandidate,
  SiteCrawlError,
  type CrawlFetch,
} from "@/lib/site/crawl";

const FILLER = "Acme Movers quotes every local move at a flat rate agreed up front. ".repeat(6);

function page(body: string): string {
  return `<!doctype html><html><head><title>Acme Movers</title></head><body>${body}</body></html>`;
}

interface RouteTable {
  readonly [url: string]: { body: string; status?: number; contentType?: string } | undefined;
}

function fakeFetch(routes: RouteTable, calls: string[] = []): CrawlFetch {
  return async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { "content-type": route.contentType ?? "text/html; charset=utf-8" },
    });
  };
}

function responseAt(
  url: string,
  body: BodyInit | null,
  init: ResponseInit = {},
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function observedResponseAt(
  url: string,
  body: string,
  observed: { read: boolean },
  init: ResponseInit = {},
): Response {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  const response = responseAt(url, null, init);
  Object.defineProperty(response, "body", {
    value: {
      async cancel() {},
      getReader() {
        return {
          async cancel() {},
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            observed.read = true;
            return { done: false, value: bytes };
          },
        };
      },
    },
  });
  return response;
}

const HOME = "https://acme.example/";

describe("normalizeSiteUrl", () => {
  it("assumes https when the scheme is missing", () => {
    expect(normalizeSiteUrl("acme.example").toString()).toBe("https://acme.example/");
    expect(normalizeSiteUrl("  www.acme.example/pricing ").toString()).toBe(
      "https://www.acme.example/pricing",
    );
  });

  it("keeps an explicit http scheme", () => {
    expect(normalizeSiteUrl("http://acme.example").protocol).toBe("http:");
  });

  it("strips the fragment", () => {
    expect(normalizeSiteUrl("https://acme.example/pricing#plans").toString()).toBe(
      "https://acme.example/pricing",
    );
  });

  it.each(["", "   ", "ftp://acme.example", "javascript:alert(1)", "localhost", "not a url"])(
    "rejects %j",
    (value) => {
      expect(() => normalizeSiteUrl(value)).toThrow(SiteCrawlError);
    },
  );
});

describe("scoreCandidate", () => {
  it("ranks business pages above deep or boilerplate pages", () => {
    expect(scoreCandidate("https://a.example/about")).toBeGreaterThan(
      scoreCandidate("https://a.example/team"),
    );
    expect(scoreCandidate("https://a.example/pricing")).toBeGreaterThan(
      scoreCandidate("https://a.example/solutions/enterprise/manufacturing/overview"),
    );
    expect(scoreCandidate("https://a.example/privacy")).toBe(Number.NEGATIVE_INFINITY);
    expect(scoreCandidate("https://a.example/login")).toBe(Number.NEGATIVE_INFINITY);
    expect(scoreCandidate(HOME)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("crawlSite", () => {
  it("reads the home page plus prioritised internal pages", async () => {
    const calls: string[] = [];
    const crawl = await crawlSite("acme.example", {
      maxPages: 3,
      fetchImpl: fakeFetch(
        {
          [HOME]: {
            body: page(
              `<h1>Moving without the runaround</h1><p>${FILLER}</p>` +
                `<a href="/blog/2024/moving-tips">Tips</a>` +
                `<a href="/pricing">Pricing</a>` +
                `<a href="/about">About</a>` +
                `<a href="/privacy">Privacy</a>`,
            ),
          },
          "https://acme.example/about": { body: page(`<h2>Our story</h2><p>${FILLER}</p>`) },
          "https://acme.example/pricing": { body: page(`<h2>Flat rates</h2><p>${FILLER}</p>`) },
          "https://acme.example/privacy": { body: page(`<p>${FILLER}</p>`) },
        },
        calls,
      ),
    });

    expect(crawl.host).toBe("acme.example");
    expect(crawl.pages.map((p) => p.url)).toEqual([
      HOME,
      "https://acme.example/about",
      "https://acme.example/pricing",
    ]);
    // Blog and privacy are dropped as irrelevant, not for budget, so the read
    // is complete: nothing worth reading was left behind.
    expect(calls).not.toContain("https://acme.example/privacy");
    expect(calls).not.toContain("https://acme.example/blog/2024/moving-tips");
    expect(crawl.truncated).toBe(false);
  });

  it("flags truncation when there are more useful pages than budget", async () => {
    const links = Array.from({ length: 8 }, (_, i) => `<a href="/services/${i}">Service ${i}</a>`).join("");
    const routes: Record<string, { body: string }> = {
      [HOME]: { body: page(`<p>${FILLER}</p>${links}`) },
    };
    for (let i = 0; i < 8; i++) {
      routes[`https://acme.example/services/${i}`] = { body: page(`<h2>Service ${i}</h2><p>${FILLER}</p>`) };
    }

    const crawl = await crawlSite("acme.example", { maxPages: 3, fetchImpl: fakeFetch(routes) });

    expect(crawl.pages).toHaveLength(3);
    expect(crawl.truncated).toBe(true);
  });

  it("obeys robots.txt for the entry page", async () => {
    await expect(
      crawlSite("acme.example", {
        fetchImpl: fakeFetch({
          "https://acme.example/robots.txt": {
            body: "User-agent: *\nDisallow: /",
            contentType: "text/plain",
          },
          [HOME]: { body: page(`<p>${FILLER}</p>`) },
        }),
      }),
    ).rejects.toMatchObject({ code: "robots-blocked" });
  });

  it("checks a same-origin home redirect against its destination path before reading the body", async () => {
    const observed = { read: false };
    const redirected = "https://acme.example/private";
    const fetchImpl: CrawlFetch = async (url) => {
      if (url === "https://acme.example/robots.txt") {
        return new Response("User-agent: *\nDisallow: /private", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === HOME) {
        return observedResponseAt(redirected, page(`<p>${FILLER}</p>`), observed, {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    await expect(crawlSite(HOME, { fetchImpl })).rejects.toMatchObject({
      code: "robots-blocked",
    });
    expect(observed.read).toBe(false);
  });

  it("loads cross-origin destination robots before reading redirected home bytes", async () => {
    const observed = { read: false };
    const redirected = "https://www.acme.example/private";
    const calls: string[] = [];
    const fetchImpl: CrawlFetch = async (url) => {
      calls.push(url);
      if (url === "https://acme.example/robots.txt") {
        return new Response("User-agent: *\nAllow: /", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://www.acme.example/robots.txt") {
        return new Response("User-agent: *\nDisallow: /private", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === HOME) {
        return observedResponseAt(redirected, page(`<p>${FILLER}</p>`), observed, {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    await expect(crawlSite(HOME, { fetchImpl })).rejects.toMatchObject({
      code: "robots-blocked",
    });
    expect(calls).toContain("https://www.acme.example/robots.txt");
    expect(observed.read).toBe(false);
  });

  it("persists an allowed cross-origin home redirect as the crawl and page URL", async () => {
    const redirected = "https://www.acme.example/welcome";
    const about = "https://www.acme.example/about";
    const calls: string[] = [];
    const fetchImpl: CrawlFetch = async (url) => {
      calls.push(url);
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === HOME) {
        return responseAt(
          redirected,
          page(`<p>${FILLER}</p><a href="/about">About</a>`),
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url === about) {
        return responseAt(about, page(`<h2>About</h2><p>${FILLER}</p>`), {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const crawl = await crawlSite(HOME, { fetchImpl });

    expect(crawl).toMatchObject({
      homeUrl: redirected,
      origin: "https://www.acme.example",
      host: "www.acme.example",
    });
    expect(crawl.pages.map((candidate) => candidate.url)).toEqual([redirected, about]);
    expect(calls).toContain("https://www.acme.example/robots.txt");
  });

  it("skips sub-pages robots.txt disallows and reports them", async () => {
    const calls: string[] = [];
    const crawl = await crawlSite("acme.example", {
      fetchImpl: fakeFetch(
        {
          "https://acme.example/robots.txt": {
            body: "User-agent: *\nDisallow: /pricing",
            contentType: "text/plain",
          },
          [HOME]: {
            body: page(`<p>${FILLER}</p><a href="/pricing">Pricing</a><a href="/about">About</a>`),
          },
          "https://acme.example/about": { body: page(`<h2>Our story</h2><p>${FILLER}</p>`) },
        },
        calls,
      ),
    });

    expect(crawl.skippedByRobots).toEqual(["https://acme.example/pricing"]);
    expect(calls).not.toContain("https://acme.example/pricing");
    expect(crawl.pages.map((p) => p.url)).toEqual([HOME, "https://acme.example/about"]);
  });

  it("skips a sub-page redirected onto a disallowed path before reading its body", async () => {
    const observed = { read: false };
    const redirected = "https://acme.example/private";
    const fetchImpl: CrawlFetch = async (url) => {
      if (url === "https://acme.example/robots.txt") {
        return new Response("User-agent: *\nDisallow: /private", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === HOME) {
        return responseAt(HOME, page(`<p>${FILLER}</p><a href="/about">About</a>`), {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://acme.example/about") {
        return observedResponseAt(redirected, page(`<p>${FILLER}</p>`), observed, {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const crawl = await crawlSite(HOME, { fetchImpl });

    expect(crawl.pages.map((candidate) => candidate.url)).toEqual([HOME]);
    expect(crawl.skippedByRobots).toContain(redirected);
    expect(observed.read).toBe(false);
  });

  it("dedupes one robots skip shared by selected and discovered pages before fetching it", async () => {
    const calls: string[] = [];
    const privateUrl = "https://acme.example/private";
    const crawl = await crawlSite("acme.example", {
      includeUrls: [HOME, privateUrl],
      fetchImpl: fakeFetch(
        {
          "https://acme.example/robots.txt": {
            body: "User-agent: *\nDisallow: /private",
            contentType: "text/plain",
          },
          [HOME]: { body: page(`<p>${FILLER}</p><a href="/private">Private</a>`) },
          [privateUrl]: { body: page(`<h2>Private</h2><p>${FILLER}</p>`) },
        },
        calls,
      ),
    });

    expect(crawl.pages.map((candidate) => candidate.url)).toEqual([HOME]);
    expect(crawl.skippedByRobots).toEqual([privateUrl]);
    expect(calls).not.toContain(privateUrl);
  });

  it("fails with `unreachable` when the home page does not load", async () => {
    await expect(
      crawlSite("acme.example", { fetchImpl: fakeFetch({}) }),
    ).rejects.toMatchObject({ code: "unreachable" });
  });

  it("fails with `unreadable` when the page has no usable text", async () => {
    await expect(
      crawlSite("acme.example", {
        fetchImpl: fakeFetch({ [HOME]: { body: page("<div id='root'></div>") } }),
      }),
    ).rejects.toMatchObject({ code: "unreadable" });
  });

  it("skips sub-pages that are not HTML or text", async () => {
    const crawl = await crawlSite("acme.example", {
      fetchImpl: fakeFetch({
        [HOME]: { body: page(`<p>${FILLER}</p><a href="/pricing">Pricing</a>`) },
        "https://acme.example/pricing": {
          body: JSON.stringify({ plans: [] }),
          contentType: "application/json",
        },
      }),
    });

    expect(crawl.pages).toHaveLength(1);
  });

  it("keeps going when a sub-page errors", async () => {
    const crawl = await crawlSite("acme.example", {
      fetchImpl: fakeFetch({
        [HOME]: {
          body: page(`<p>${FILLER}</p><a href="/about">About</a><a href="/pricing">Pricing</a>`),
        },
        "https://acme.example/about": { body: "boom", status: 500 },
        "https://acme.example/pricing": { body: page(`<h2>Flat rates</h2><p>${FILLER}</p>`) },
      }),
    });

    expect(crawl.pages.map((p) => p.url)).toEqual([HOME, "https://acme.example/pricing"]);
  });

  it("stops at the total character budget", async () => {
    const crawl = await crawlSite("acme.example", {
      maxTotalChars: 200,
      fetchImpl: fakeFetch({
        [HOME]: { body: page(`<p>${FILLER}</p><a href="/about">About</a>`) },
        "https://acme.example/about": { body: page(`<h2>Our story</h2><p>${FILLER}</p>`) },
      }),
    });

    const total = crawl.pages.reduce((sum, p) => sum + p.text.length, 0);
    expect(total).toBeLessThanOrEqual(200);
    expect(crawl.truncated).toBe(true);
  });

  it("never revisits the same URL", async () => {
    const calls: string[] = [];
    await crawlSite("acme.example", {
      fetchImpl: fakeFetch(
        {
          [HOME]: {
            body: page(
              `<p>${FILLER}</p><a href="/about">About</a><a href="/about#team">Again</a><a href="/">Home</a>`,
            ),
          },
          "https://acme.example/about": { body: page(`<h2>Our story</h2><p>${FILLER}</p>`) },
        },
        calls,
      ),
    });

    const pageCalls = calls.filter((url) => !url.endsWith("/robots.txt"));
    expect(new Set(pageCalls).size).toBe(pageCalls.length);
  });
});
