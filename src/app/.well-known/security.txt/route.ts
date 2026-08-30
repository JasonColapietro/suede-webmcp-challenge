/**
 * RFC 9116 security.txt — machine-readable vulnerability disclosure policy.
 * GET /.well-known/security.txt
 *
 * Contact resolves via the suedeai.ai forwardemail catch-all. `Expires` is
 * computed as now + 365 days on every request so the file never goes stale
 * (RFC 9116 requires a future expiry). The human-readable policy is /security.
 */
import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";

const SECURITY_EMAIL = "security@suedeai.ai";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function GET(): NextResponse {
  const expires = new Date(Date.now() + ONE_YEAR_MS).toISOString();
  const body = [
    `Contact: mailto:${SECURITY_EMAIL}`,
    `Expires: ${expires}`,
    "Preferred-Languages: en",
    `Canonical: ${SITE_URL}/.well-known/security.txt`,
    `Policy: ${SITE_URL}/security`,
    "",
  ].join("\n");

  return new NextResponse(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}
