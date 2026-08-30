/**
 * A small, deliberately literal robots.txt reader for the site crawler.
 *
 * Suede fetches other people's sites on their owner's behalf, so it obeys
 * robots.txt rather than assuming consent. Scope is exactly what a five-page
 * read needs: User-agent grouping, Disallow, and Allow, with the
 * longest-match-wins precedence the major crawlers use. Crawl-delay,
 * wildcards beyond `*`, and sitemap directives are out of scope and ignored.
 *
 * Pure string handling — the fetch lives in crawl.ts.
 */

export const CRAWLER_USER_AGENT = "SuedeAgentStudio";

interface RobotsRule {
  readonly allow: boolean;
  readonly path: string;
}

export interface RobotsPolicy {
  /** True when the policy places no restriction on this crawler at all. */
  readonly unrestricted: boolean;
  isAllowed(pathname: string): boolean;
}

export const ALLOW_ALL: RobotsPolicy = {
  unrestricted: true,
  isAllowed: () => true,
};

/** `Disallow: /foo*` and `Disallow: /foo$` collapse to a prefix test on `/foo`. */
function normalizePath(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  const withoutAnchors = value.replace(/\$$/, "").replace(/\*+$/, "");
  return withoutAnchors === "" ? "/" : withoutAnchors;
}

function agentMatches(agent: string): boolean {
  const lowered = agent.trim().toLowerCase();
  return lowered === "*" || CRAWLER_USER_AGENT.toLowerCase().includes(lowered);
}

/**
 * Parse robots.txt into a policy for this crawler. A `User-agent` line naming
 * us wins outright over the `*` group; when neither appears the policy is
 * unrestricted.
 */
export function parseRobots(text: string): RobotsPolicy {
  const wildcardRules: RobotsRule[] = [];
  const namedRules: RobotsRule[] = [];
  let sawNamedGroup = false;

  // A run of consecutive User-agent lines shares one rule block.
  let currentAgents: string[] = [];
  let inRuleBody = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0]!.trim();
    if (line === "") continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (directive === "user-agent") {
      if (inRuleBody) {
        currentAgents = [];
        inRuleBody = false;
      }
      currentAgents.push(value);
      continue;
    }
    if (directive !== "disallow" && directive !== "allow") continue;
    if (currentAgents.length === 0) continue;

    inRuleBody = true;
    const path = normalizePath(value);
    // `Disallow:` with an empty value is the documented "allow everything"
    // form, not a rule — skip it rather than treating it as a prefix.
    if (path === null) continue;
    const rule: RobotsRule = { allow: directive === "allow", path };

    for (const agent of currentAgents) {
      if (!agentMatches(agent)) continue;
      if (agent.trim() === "*") {
        wildcardRules.push(rule);
      } else {
        sawNamedGroup = true;
        namedRules.push(rule);
      }
    }
  }

  const rules = sawNamedGroup ? namedRules : wildcardRules;
  if (rules.length === 0) return ALLOW_ALL;

  return {
    unrestricted: false,
    isAllowed(pathname: string): boolean {
      let decision: RobotsRule | null = null;
      for (const rule of rules) {
        if (!pathname.startsWith(rule.path)) continue;
        // Longest match wins; Allow beats Disallow at equal length.
        if (
          decision === null ||
          rule.path.length > decision.path.length ||
          (rule.path.length === decision.path.length && rule.allow)
        ) {
          decision = rule;
        }
      }
      return decision === null ? true : decision.allow;
    },
  };
}
