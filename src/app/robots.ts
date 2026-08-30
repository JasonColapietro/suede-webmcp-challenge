import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Mirrors the AI-crawler allowlist used across other Suede properties
// (app.suedeai.ai, suedeai.ai, strumly, suedeai.org) so answer engines and
// AI agents get an explicit invite instead of relying on the wildcard rule.
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "Amazonbot",
  "CCBot",
  "Bytespider",
  "Meta-ExternalAgent",
];

const DISALLOW = ["/api/"];

// The root /.well-known/x402 discovery doc advertises per-agent discovery,
// agent-card, and a2a URLs that live under /api/. A compliant marketplace
// crawler that honors robots.txt would be blocked at that second hop by the
// blanket /api/ disallow, breaking the x402 discovery chain. Re-allow exactly
// those machine-discovery paths (longer, more-specific Allow wins for Google
// and the major AI crawlers) while keeping the rest of /api/ closed.
const ALLOW = [
  "/",
  "/api/agents/*/.well-known/",
  "/api/agents/*/a2a",
  "/api/catalog",
  "/api/services",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: ALLOW, disallow: DISALLOW },
      ...AI_CRAWLERS.map((userAgent) => ({
        userAgent,
        allow: ALLOW,
        disallow: DISALLOW,
      })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
