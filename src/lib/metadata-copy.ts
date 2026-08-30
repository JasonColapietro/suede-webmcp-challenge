const TITLE_MAX = 70;
const DESCRIPTION_MAX = 165;
const DESCRIPTION_IDENTITY_MAX = 64;
const TITLE_SITE_SUFFIX = " | Suede Agent Studio";

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return "…".slice(0, Math.max(0, maxLength));

  const candidateBudget = maxLength - 1;
  let candidate = "";
  for (const codePoint of value) {
    if (candidate.length + codePoint.length > candidateBudget) break;
    candidate += codePoint;
  }
  candidate = candidate.trimEnd();
  const lastSpace = candidate.lastIndexOf(" ");
  const readable =
    lastSpace >= Math.floor(candidate.length * 0.6) ? candidate.slice(0, lastSpace) : candidate;
  return `${readable.trimEnd()}…`;
}

function trailingIdentity(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const tail: string[] = [];
  let length = 1;
  for (const codePoint of Array.from(value).reverse()) {
    if (length + codePoint.length > maxLength) break;
    tail.push(codePoint);
    length += codePoint.length;
  }
  return `…${tail.reverse().join("")}`;
}

export function buildTemplateMetadataDescription(detail: {
  readonly pitchProse: string;
  readonly whoPays: string;
}): string {
  return truncate(normalize(`${detail.pitchProse} ${detail.whoPays}`), DESCRIPTION_MAX);
}

export interface PublicAgentMetadataCopy {
  readonly title: string;
  readonly description: string;
}

/**
 * Public agent names and readiness descriptions can repeat when separate
 * owners launch the same company template. The public slug is already the
 * stable route identity, so it truthfully distinguishes each listing without
 * inventing an owner, verification, or performance claim.
 */
export function buildPublicAgentMetadataCopy(input: {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
}): PublicAgentMetadataCopy {
  const titleBudget = TITLE_MAX - TITLE_SITE_SUFFIX.length;
  const separator = " · ";
  const slug = normalize(input.slug);
  const identity = trailingIdentity(slug, Math.min(32, titleBudget - separator.length - 1));
  const name = truncate(
    normalize(input.name),
    Math.max(1, titleBudget - separator.length - identity.length),
  );

  const path = `/a/${trailingIdentity(slug, DESCRIPTION_IDENTITY_MAX)}`;
  const descriptionSuffix = ` Public listing: ${path}.`;
  const fallback = `${normalize(input.name)} is a published service on Suede Agent Studio.`;
  const description = `${truncate(
    normalize(input.description) || fallback,
    DESCRIPTION_MAX - descriptionSuffix.length,
  )}${descriptionSuffix}`;

  return {
    title: `${name}${separator}${identity}${TITLE_SITE_SUFFIX}`,
    description,
  };
}
