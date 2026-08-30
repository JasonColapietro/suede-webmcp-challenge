import React, { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...props }, children),
}));

vi.mock("next/image", () => ({
  default: ({ priority, ...props }: Record<string, unknown>) => {
    void priority;
    return createElement("img", props);
  },
}));

vi.mock("@/components/site/SiteNav", () => ({ default: () => null }));
vi.mock("@/components/site/SiteFooter", () => ({ default: () => null }));

import FounderPage from "@/app/founder/page";
import PricingPage from "@/app/pricing/page";
import GumloopAlternativePage from "@/app/compare/gumloop-alternative/page";
import { Faq } from "@/components/landing/Faq";
import SystemMap from "@/components/landing/SystemMap";

beforeAll(() => vi.stubGlobal("React", React));

function markup(...components: React.ReactElement[]): string {
  return components.map((component) => renderToStaticMarkup(component)).join("\n");
}

describe("public payment-role copy", () => {
  it("keeps launch and Live status separate from payment enablement", () => {
    const copy = markup(
      createElement(FounderPage),
      createElement(PricingPage),
      createElement(GumloopAlternativePage),
      createElement(Faq),
    );

    expect(copy).not.toMatch(/every agent launched[^.]*pay-per-call/iu);
    expect(copy).not.toMatch(/every call settles/iu);
    expect(copy).not.toMatch(/launch every one as a pay-per-call endpoint/iu);
    expect(copy).not.toMatch(/when (?:an agent|you) go(?:es)? live[^.]*settle/iu);
    expect(copy).toMatch(/payment-enabled/iu);
    expect(copy).toMatch(/enable payments/iu);
  });

  it("names x402 as caller settlement while keeping A2A and Stripe in their actual roles", () => {
    const copy = markup(
      createElement(FounderPage),
      createElement(PricingPage),
      createElement(GumloopAlternativePage),
      createElement(Faq),
    );

    expect(copy).toMatch(/x402 v2[^.]*caller settlement/iu);
    expect(copy).toMatch(/A2A[^.]*interface/iu);
    expect(copy).toMatch(/Stripe[^.]*builder (?:funding|credit)/iu);
    expect(copy).not.toMatch(/LayerZero[^.]*settlement/iu);
    expect(copy).not.toMatch(/Card via Stripe/iu);
  });

  it("keeps the system-map stat while no longer counting ecosystem references as settlement rails", () => {
    const copy = markup(createElement(SystemMap));

    expect(copy).toContain("5");
    expect(copy).toContain("commerce, interface &amp; identity references");
    expect(copy).not.toContain("settlement rails");
    expect(copy).toMatch(/payment-enabled[^<]*x402 v2/iu);
  });
});
