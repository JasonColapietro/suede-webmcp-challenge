import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { withBotId } from "botid/next/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  outputFileTracingIncludes: {
    "/*": ["./node_modules/pdfkit/js/data/*.afm"],
  },
  serverExternalPackages: ["better-sqlite3", "pdfkit", "unpdf"],
  async redirects() {
    return [
      {
        // www.agents.suedeai.ai is a second live host for this project: it
        // answers 200 on every path instead of redirecting, the way
        // www.suedeai.ai, www.suedeai.org and www.ip.suedeai.ai all do. The
        // pages self-canonical to the apex, so Search Console files the www
        // copies under "alternate page with proper canonical tag" rather than
        // indexing them twice — but they should not be reachable at all.
        source: "/:path*",
        has: [{ type: "host", value: "www.agents.suedeai.ai" }],
        destination: "https://agents.suedeai.ai/:path*",
        permanent: true,
      },
      {
        // The template's public slug was renamed to drop the repo codename.
        // Permanent so the indexed URL's ranking follows the new path.
        source: "/templates/agentix-rebuilder",
        destination: "/templates/grade-rebuilder",
        permanent: true,
      },
    ];
  },
};

export default withBotId(nextConfig);
