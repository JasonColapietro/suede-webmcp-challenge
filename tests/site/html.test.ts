import { describe, expect, it } from "vitest";
import {
  extractHeadings,
  extractMetadata,
  extractPage,
  extractSameOriginLinks,
  htmlToText,
  MAX_HEADINGS,
} from "@/lib/site/html";

const PAGE = `<!doctype html>
<html><head>
  <title>Fast, fair moving quotes | Acme Movers</title>
  <meta name="description" content="Local moves, flat rates, no hourly surprises.">
  <meta property="og:site_name" content="Acme Movers">
  <meta property="og:title" content="Acme Movers &mdash; moving without the runaround">
  <link rel="canonical" href="https://acme.example/">
  <style>.hidden { display: none }</style>
  <script>window.tracking = "should never appear";</script>
</head><body>
  <h1>Moving without the runaround</h1>
  <h2>Local moves</h2>
  <h2>Local moves</h2>
  <h3>Packing &amp; unpacking</h3>
  <p>We quote flat.</p><p>You pay that.</p>
  <a href="/pricing">Pricing</a>
  <a href="/pricing#plans">Pricing anchor</a>
  <a href="https://acme.example/about">About</a>
  <a href="https://other.example/partner">Partner</a>
  <a href="/brochure.pdf">Brochure</a>
  <a href="mailto:hi@acme.example">Email</a>
  <a href="#top">Top</a>
</body></html>`;

describe("extractMetadata", () => {
  it("reads title, description, site name, og title and canonical", () => {
    const meta = extractMetadata(PAGE);

    expect(meta.title).toBe("Fast, fair moving quotes | Acme Movers");
    expect(meta.description).toBe("Local moves, flat rates, no hourly surprises.");
    expect(meta.siteName).toBe("Acme Movers");
    expect(meta.ogTitle).toBe("Acme Movers — moving without the runaround");
    expect(meta.canonical).toBe("https://acme.example/");
  });

  it("falls back to og:description when there is no meta description", () => {
    const meta = extractMetadata(
      `<html><head><meta property="og:description" content="Only OG here."></head><body></body></html>`,
    );

    expect(meta.description).toBe("Only OG here.");
  });

  it("returns nulls rather than empty strings for an empty document", () => {
    const meta = extractMetadata("<html><head></head><body></body></html>");

    expect(meta).toEqual({
      title: null,
      description: null,
      siteName: null,
      ogTitle: null,
      ogDescription: null,
      canonical: null,
    });
  });

  it("ignores meta tags inside script and comment blocks", () => {
    const meta = extractMetadata(
      `<html><head><script><meta name="description" content="injected"></script>` +
        `<!-- <meta name="description" content="commented"> -->` +
        `<meta name="description" content="real"></head><body></body></html>`,
    );

    expect(meta.description).toBe("real");
  });
});

describe("extractHeadings", () => {
  it("collects h1-h3 in order, de-duplicated and entity-decoded", () => {
    expect(extractHeadings(PAGE)).toEqual([
      "Moving without the runaround",
      "Local moves",
      "Packing & unpacking",
    ]);
  });

  it("caps the number of headings", () => {
    const many = Array.from({ length: MAX_HEADINGS + 10 }, (_, i) => `<h2>Heading ${i}</h2>`).join("");

    expect(extractHeadings(many)).toHaveLength(MAX_HEADINGS);
  });
});

describe("htmlToText", () => {
  it("drops script and style content and collapses whitespace", () => {
    const text = htmlToText(PAGE, 10_000);

    expect(text).toContain("We quote flat. You pay that.");
    expect(text).not.toContain("should never appear");
    expect(text).not.toContain("display: none");
  });

  it("does not fuse words across element boundaries", () => {
    expect(htmlToText("<p>one</p><p>two</p>", 100)).toBe("one two");
  });

  it("truncates to maxChars", () => {
    expect(htmlToText("<p>abcdefghij</p>", 4)).toBe("abcd");
    expect(htmlToText("<p>abc</p>", 0)).toBe("");
  });
});

describe("extractSameOriginLinks", () => {
  it("keeps same-origin page links, absolutised and fragment-stripped", () => {
    expect(extractSameOriginLinks(PAGE, "https://acme.example/")).toEqual([
      "https://acme.example/pricing",
      "https://acme.example/about",
    ]);
  });

  it("drops cross-origin links, file downloads, and non-http schemes", () => {
    const links = extractSameOriginLinks(PAGE, "https://acme.example/");

    expect(links).not.toContain("https://other.example/partner");
    expect(links.some((link) => link.endsWith(".pdf"))).toBe(false);
    expect(links.some((link) => link.startsWith("mailto:"))).toBe(false);
  });

  it("returns nothing for an unparsable base URL", () => {
    expect(extractSameOriginLinks(PAGE, "not a url")).toEqual([]);
  });
});

describe("extractPage", () => {
  it("returns metadata, text and headings together", () => {
    const page = extractPage(PAGE, 500);

    expect(page.siteName).toBe("Acme Movers");
    expect(page.headings[0]).toBe("Moving without the runaround");
    expect(page.text.length).toBeGreaterThan(0);
    expect(page.text.length).toBeLessThanOrEqual(500);
  });
});
