import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface GatedRoute {
  readonly prefix: string;
  readonly layout: string;
  readonly fallback: string;
}

const GATED_ROUTES: readonly GatedRoute[] = [
  { prefix: "/start", layout: "src/app/start/layout.tsx", fallback: "/start" },
  {
    prefix: "/from-website",
    layout: "src/app/from-website/layout.tsx",
    fallback: "/from-website",
  },
  { prefix: "/grade", layout: "src/app/grade/layout.tsx", fallback: "/grade" },
  { prefix: "/build", layout: "src/app/build/layout.tsx", fallback: "/build" },
  { prefix: "/code", layout: "src/app/code/layout.tsx", fallback: "/code" },
  { prefix: "/flows", layout: "src/app/flows/layout.tsx", fallback: "/flows" },
  {
    prefix: "/founding",
    layout: "src/app/founding/layout.tsx",
    fallback: "/founding",
  },
  {
    prefix: "/company",
    layout: "src/app/company/layout.tsx",
    fallback: "/company",
  },
  {
    prefix: "/connections",
    layout: "src/app/connections/layout.tsx",
    fallback: "/connections",
  },
  {
    prefix: "/resources",
    layout: "src/app/resources/layout.tsx",
    fallback: "/resources",
  },
  { prefix: "/runs", layout: "src/app/runs/layout.tsx", fallback: "/runs" },
  {
    prefix: "/portfolio",
    layout: "src/app/portfolio/layout.tsx",
    fallback: "/portfolio",
  },
];

const read = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const SOURCE_ROOT = resolve(process.cwd(), "src");

function sourceFilesUnder(path: string): readonly string[] {
  const absolute = resolve(process.cwd(), path);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) return sourceFilesUnder(child);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [child] : [];
  });
}

function resolveRenderedImport(fromPath: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? resolve(SOURCE_ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(process.cwd(), dirname(fromPath), specifier)
      : null;
  if (base === null) return null;

  const candidates = base.endsWith(".tsx")
    ? [base]
    : [`${base}.tsx`, resolve(base, "index.tsx")];
  const matched = candidates.find(
    (candidate) => candidate.startsWith(`${SOURCE_ROOT}/`) && existsSync(candidate),
  );
  return matched === undefined ? null : relative(process.cwd(), matched);
}

function gatedRenderedSources(): readonly string[] {
  const pending = GATED_ROUTES.flatMap(({ prefix }) =>
    sourceFilesUnder(`src/app${prefix}`).filter((path) => path.endsWith(".tsx")),
  );
  const visited = new Set<string>();

  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);

    const source = read(path);
    const specifiers = new Set([
      ...Array.from(source.matchAll(/\bfrom\s+["']([^"']+)["']/gu), (match) => match[1]),
      ...Array.from(source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu), (match) => match[1]),
      ...Array.from(source.matchAll(/\bimport\s+["']([^"']+)["']/gu), (match) => match[1]),
    ]);
    for (const specifier of specifiers) {
      const imported = resolveRenderedImport(path, specifier);
      if (imported !== null && !visited.has(imported)) pending.push(imported);
    }
  }

  return [...visited].sort();
}

const STALE_OPERATOR_ACCESS_CLAIMS = [
  { label: "no-login", pattern: /\bno[\s-]+login(?:\s+(?:is\s+)?required)?\b/iu },
  { label: "no-sign-in", pattern: /\bno[\s-]+sign[\s-]?in(?:\s+(?:is\s+)?required)?\b/iu },
  { label: "no-account", pattern: /\bno\s+(?:user\s+)?account(?:\s+(?:is\s+)?(?:needed|required))?\b/iu },
  {
    label: "account-free access",
    pattern: /\b(?:without|does(?:n't|\s+not)\s+require)\s+(?:an?\s+)?(?:account|login|sign(?:ing|[\s-])?in)\b/iu,
  },
  {
    label: "public operator surface",
    pattern: /\bpublic\s+(?:(?:agent\s+)?grading\s+(?:page|tool)|grader|operator\s+(?:page|surface|experience)|studio|workspace|access)\b/iu,
  },
] as const;

describe("studio operator route gates", () => {
  it.each(GATED_ROUTES)(
    "gates $prefix through its top-level layout using $fallback as the fallback",
    ({ layout, fallback }) => {
      const source = read(layout);
      expect(source).toContain(
        'import { requireStudioAccount } from "@/lib/studio-auth";',
      );
      expect(source).toContain(`await requireStudioAccount("${fallback}")`);
      expect(source).toMatch(/export default async function/u);
    },
  );

  it("keeps public pages and APIs outside the HTML redirect guard", () => {
    const publicSources = [
      ...sourceFilesUnder("src/app/agents"),
      ...sourceFilesUnder("src/app/a/[slug]"),
      ...sourceFilesUnder("src/app/docs"),
      ...sourceFilesUnder("src/app/pricing"),
      ...sourceFilesUnder("src/app/api"),
    ];

    expect(publicSources.length).toBeGreaterThan(0);
    for (const path of publicSources) {
      expect(read(path), path).not.toContain("@/lib/studio-auth");
    }
  });

  it("keeps gated route copy from promising anonymous operator access", () => {
    const violations = gatedRenderedSources().flatMap((path) => {
      const source = read(path);
      return STALE_OPERATOR_ACCESS_CLAIMS.flatMap(({ label, pattern }) => {
        const match = pattern.exec(source);
        if (match === null) return [];
        const line = source.slice(0, match.index).split("\n").length;
        return [`${path}:${line} (${label}): ${match[0]}`];
      });
    });

    // Public pages, links, endpoints, directories, runs, and releases remain valid
    // published-output language; none of those phrases promises route access.
    expect(violations).toEqual([]);
  });
});
