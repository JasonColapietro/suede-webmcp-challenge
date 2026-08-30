import { z } from "zod";

export const SCAN_HANDOFF_FRAGMENT_PREFIX = "#scan=";
export const SCAN_HANDOFF_STORAGE_KEY = "suede.prospect.scan.v1";
export const SCAN_HANDOFF_MAX_ENCODED_LENGTH = 6_144;
export const SCAN_HANDOFF_SESSION_TTL_MS = 10 * 60 * 1_000;
const SCAN_HANDOFF_MAX_STORED_LENGTH = 12_000;
const SCAN_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;

const FORBIDDEN_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;
const FORBIDDEN_MULTI_LINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;
function singleLine(min: number, max: number): z.ZodType<string> {
  return z.string()
    .refine((value) => !FORBIDDEN_SINGLE_LINE.test(value), "Control characters are not allowed.")
    .transform((value) => value.trim())
    .pipe(z.string().min(min).max(max));
}

function multiLine(min: number, max: number): z.ZodType<string> {
  return z.string()
    .refine((value) => !FORBIDDEN_MULTI_LINE.test(value), "Unsafe control characters are not allowed.")
    .transform((value) => value.trim())
    .pipe(z.string().min(min).max(max));
}

const COMMERCIAL_FIRST_PERSON_PATTERN =
  /(?:^|[^\p{L}\p{N}_])(?:i|i'm|i’m|i've|i’ve|i'll|i’ll|me|my|mine|myself|we|we're|we’re|we've|we’ve|we'll|we’ll|us|our|ours|ourselves)(?=$|[^\p{L}\p{N}_])/iu;
const COMMERCIAL_IDENTITY_OR_SIGNOFF_PATTERN =
  /(?:^|\n)\s*(?:best|regards|sincerely|thanks|thank you|from)\s*[:,]?(?:[ \t]+[^\n]*)?(?:\n|$)|\b(?:founder|chief executive(?: officer)?|ceo|creator of|author of|programming insider|proof as infrastructure|jason colapietro|johnny suede)\b/iu;
const COMMERCIAL_PAYLOAD_MARKER_PATTERN =
  /\[(?:BEGIN|END) (?:PREPARED REPAIR|VERIFICATION STEP)\]/iu;

function commercialOperatorText(
  min: number,
  max: number,
  maxLines: number,
): z.ZodType<string> {
  return multiLine(min, max).refine(
    (value) => (
      !COMMERCIAL_FIRST_PERSON_PATTERN.test(value) &&
      !COMMERCIAL_IDENTITY_OR_SIGNOFF_PATTERN.test(value) &&
      !COMMERCIAL_PAYLOAD_MARKER_PATTERN.test(value) &&
      value.split("\n").length <= maxLines
    ),
    `Use no more than ${maxLines} lines of objective repair instructions without sender, signature, credibility, or payload-boundary language.`,
  );
}

const HOSTNAME_LABEL_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isPublicHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  if (
    !HOSTNAME_LABEL_PATTERN.test(hostname) ||
    !hostname.includes(".") ||
    hostname.includes(":") ||
    /^\d+(?:\.\d+){3}$/.test(hostname)
  ) {
    return false;
  }
  return ![
    "localhost",
    ".localhost",
    ".local",
    ".internal",
    ".lan",
    ".home.arpa",
    ".example",
    ".invalid",
    ".test",
  ].some((suffix) => hostname === suffix.replace(/^\./, "") || hostname.endsWith(suffix));
}

const HostnameSchema = singleLine(1, 253).refine(
  isPublicHostname,
  "Use a valid public hostname, not an IP address, reserved suffix, or local-only name.",
);

const SafePublicUrlSchema = singleLine(1, 2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        isPublicHostname(url.hostname)
      );
    } catch {
      return false;
    }
  }, "Use a clean public HTTP(S) URL without credentials, query parameters, or a fragment.");

function safeHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

export const ScanPreparedRepairSchema = z.object({
  kind: z.literal("replace-link-target"),
  ready: z.literal(true),
  before: SafePublicUrlSchema,
  after: SafePublicUrlSchema,
  instruction: singleLine(10, 1_000),
  verification: z.array(singleLine(3, 300)).min(1).max(8),
}).strict().superRefine((value, context) => {
  if (value.before === value.after) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["after"],
      message: "The replacement link target must differ from the broken target.",
    });
  }
});

export const ScanLinkEvidenceSchema = z.object({
  subtype: z.enum(["broken-link", "redirect-link", "unavailable-link"]).optional(),
  sourceUrl: SafePublicUrlSchema,
  targetUrl: SafePublicUrlSchema,
  finalUrl: SafePublicUrlSchema,
  status: z.number().int().min(0).max(599),
  anchorText: singleLine(1, 160),
  redirectChain: z.array(z.object({
    status: z.number().int().min(100).max(599),
    from: SafePublicUrlSchema,
    to: SafePublicUrlSchema,
  }).strict()).max(5).default([]),
}).strict();

export const ScanDiagnosticFindingSchema = z.object({
  id: singleLine(1, 64),
  kind: z.literal("site-integrity"),
  lane: singleLine(1, 80),
  title: singleLine(1, 160),
  priority: z.enum(["high", "medium", "low"]),
  observed: singleLine(1, 300),
  action: singleLine(1, 300),
  evidence: ScanLinkEvidenceSchema.optional(),
  preparedRepair: ScanPreparedRepairSchema.optional(),
}).strict();

export const ScanDiagnosticHandoffSchema = z.object({
  kind: z.literal("suede.audit.prospect"),
  version: z.literal(1),
  source: z.literal("suede-audit"),
  domain: HostnameSchema,
  auditedUrl: SafePublicUrlSchema,
  observedAt: z.string().datetime({ offset: true }),
  totalFindings: z.number().int().min(1).max(200),
  omittedCount: z.number().int().min(0).max(194),
  findings: z.array(ScanDiagnosticFindingSchema).min(1).max(6),
}).strict().superRefine((value, context) => {
  const auditedHost = safeHostname(value.auditedUrl);
  const suppliedHost = value.domain.toLowerCase().replace(/\.$/, "");
  if (auditedHost !== null && auditedHost !== suppliedHost) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["auditedUrl"],
      message: "The audited URL must match the supplied hostname.",
    });
  }
  if (value.totalFindings !== value.findings.length + value.omittedCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["omittedCount"],
      message: "The finding count does not match the imported evidence.",
    });
  }
  const findingIds = new Set(value.findings.map((finding) => finding.id));
  if (findingIds.size !== value.findings.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["findings"],
      message: "Finding identifiers must be unique.",
    });
  }
});

const PendingScanHandoffSchema = z.object({
  version: z.literal(1),
  expiresAt: z.number().int().positive(),
  handoff: ScanDiagnosticHandoffSchema,
}).strict();

export const JASON_OUTBOUND_PROFILE = Object.freeze({
  id: "jason-colapietro" as const,
  name: "Jason Colapietro",
  title: "Founder and CEO, Suede Labs AI",
  credibilityStatement:
    "I'm Jason Colapietro, founder and CEO of Suede Labs AI and creator of Suede Scan. I also wrote Proof as Infrastructure and a Programming Insider article on SEO and AI-readable businesses.",
  identityUrl: "https://suedeai.ai/founder",
  scanUrl: "https://scan.suedeai.ai/",
  articleUrl:
    "https://programminginsider.com/in-the-age-of-infinite-content-spam-is-instant-death/",
  bookUrl: "https://www.amazon.com/dp/B0GMB2VLXQ",
});

const COMMERCIAL_EVIDENCE_BOUNDARY =
  "Client-controlled, unsigned Scan snapshot. The operator attested that Jason reproduced the primary public observation. Review every line before external use.";

export const OutboundDiagnosticInputSchema = z.object({
  handoff: ScanDiagnosticHandoffSchema,
  mode: z.literal("commercial-diagnostic"),
  recipientName: singleLine(1, 120).nullable(),
  senderProfile: z.literal(JASON_OUTBOUND_PROFILE.id),
  postalAddress: singleLine(10, 300),
  contactSource: singleLine(3, 240),
  recipientJurisdiction: z.enum(["united-states", "other-reviewed"]),
  recipientType: z.enum(["corporate-business", "individual-or-unknown"]),
  primaryFindingId: singleLine(1, 64),
  preparedRepair: commercialOperatorText(20, 4_000, 80),
  verificationStep: commercialOperatorText(10, 1_200, 30),
  reproducedAtSource: z.literal(true),
  suppressionChecked: z.literal(true),
  optOutMonitored: z.literal(true),
  outreachRulesReviewed: z.literal(true),
}).strict().superRefine((value, context) => {
  if (!value.handoff.findings.some((finding) => finding.id === value.primaryFindingId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["primaryFindingId"],
      message: "Choose a primary finding from the imported Scan.",
    });
  }
});

export const OutboundDiagnosticDraftSchema = z.object({
  mode: z.literal("commercial-diagnostic"),
  subject: singleLine(1, 240),
  body: multiLine(1, 12_000),
  recipientName: singleLine(1, 120).nullable(),
  domain: HostnameSchema,
  observedAt: z.string().datetime({ offset: true }),
  postalAddress: singleLine(10, 300),
  primaryFinding: ScanDiagnosticFindingSchema,
  supportingFindings: z.array(ScanDiagnosticFindingSchema).max(2),
  preparedRepair: commercialOperatorText(20, 4_000, 80),
  verificationStep: commercialOperatorText(10, 1_200, 30),
  evidenceBoundary: z.literal(COMMERCIAL_EVIDENCE_BOUNDARY),
  snapshotStatus: z.enum(["current", "stale"]),
}).strict().superRefine((value, context) => {
  if (value.subject.includes("—") || value.body.includes("—")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["body"],
      message: "Commercial draft cannot contain an em dash.",
    });
  }
  if (value.subject !== commercialSubject(value.domain)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject"],
      message: "Commercial subject must match the deterministic Jason template.",
    });
  }
  if (value.body !== commercialBody(value, value.primaryFinding, value.supportingFindings)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["body"],
      message: "Commercial body must match the deterministic Jason template.",
    });
  }
});

export const SecurityObservationCategorySchema = z.enum([
  "public-data-exposure",
  "access-control",
  "security-configuration",
  "dependency-or-version",
  "other-security-observation",
]);

const SecurityOperatorNameSchema = z.enum(["Jason", "Johnny"]);
const SECURITY_OBSERVATION_CATEGORY_LABELS: Record<
  z.infer<typeof SecurityObservationCategorySchema>,
  string
> = {
  "public-data-exposure": "public data exposure",
  "access-control": "access control",
  "security-configuration": "security configuration",
  "dependency-or-version": "dependency or version exposure",
  "other-security-observation": "security",
};

export const SecurityDisclosureInputSchema = z.object({
  mode: z.literal("security-disclosure"),
  operatorName: SecurityOperatorNameSchema,
  affectedAsset: SafePublicUrlSchema,
  observedAt: z.string().datetime({ offset: true }),
  discoveryMethod: z.enum(["passive-observation", "authorized-test"]),
  authorizationReference: singleLine(3, 240).nullable(),
  category: SecurityObservationCategorySchema,
  evidenceReference: singleLine(3, 240),
  disclosureChannelConfirmed: z.literal(true),
  operatorAttested: z.literal(true),
}).strict().superRefine((value, context) => {
  if (
    value.discoveryMethod === "authorized-test" &&
    value.authorizationReference === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorizationReference"],
      message: "Document the authorization reference for authorized testing.",
    });
  }
  if (
    value.discoveryMethod === "passive-observation" &&
    value.authorizationReference !== null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorizationReference"],
      message: "Passive observations must not claim an authorization reference.",
    });
  }
});

export const SecurityDisclosureDraftSchema = z.object({
  mode: z.literal("security-disclosure"),
  subject: singleLine(1, 240),
  body: multiLine(1, 12_000),
  operatorName: SecurityOperatorNameSchema,
  affectedAsset: SafePublicUrlSchema,
  observedAt: z.string().datetime({ offset: true }),
  discoveryMethod: z.enum(["passive-observation", "authorized-test"]),
  authorizationReference: singleLine(3, 240).nullable(),
  category: SecurityObservationCategorySchema,
  evidenceReference: singleLine(3, 240),
  disclosureChannelConfirmed: z.literal(true),
  operatorAttested: z.literal(true),
  evidenceBoundary: multiLine(1, 600),
}).strict().superRefine((value, context) => {
  if (
    value.discoveryMethod === "authorized-test" &&
    value.authorizationReference === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorizationReference"],
      message: "Document the authorization reference for authorized testing.",
    });
  }
  if (
    value.discoveryMethod === "passive-observation" &&
    value.authorizationReference !== null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorizationReference"],
      message: "Passive observations must not claim an authorization reference.",
    });
  }
  const canReconstruct = (
    safeHostname(value.affectedAsset) !== null &&
    Number.isFinite(Date.parse(value.observedAt)) &&
    SecurityOperatorNameSchema.safeParse(value.operatorName).success &&
    SecurityObservationCategorySchema.safeParse(value.category).success
  );
  if (canReconstruct) {
    if (value.subject !== securityDisclosureSubject(value.affectedAsset)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subject"],
        message: "Disclosure subject must match the deterministic non-commercial template.",
      });
    }
    if (value.body !== securityDisclosureBody(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: "Disclosure body must match the deterministic non-commercial template.",
      });
    }
  }
});

export type ScanDiagnosticFinding = z.infer<typeof ScanDiagnosticFindingSchema>;
export type ScanDiagnosticHandoff = z.infer<typeof ScanDiagnosticHandoffSchema>;
export type OutboundDiagnosticInput = z.infer<typeof OutboundDiagnosticInputSchema>;
export type OutboundDiagnosticDraft = z.infer<typeof OutboundDiagnosticDraftSchema>;
export type SecurityDisclosureInput = z.infer<typeof SecurityDisclosureInputSchema>;
export type SecurityDisclosureDraft = z.infer<typeof SecurityDisclosureDraftSchema>;

function assertNotFuture(value: string, now: Date): void {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("A valid review time is required.");
  }
  if (Date.parse(value) > now.getTime()) {
    throw new Error("The observation time cannot be in the future.");
  }
}

function decodeBase64Url(value: string): string {
  if (
    value.length < 1 ||
    value.length > SCAN_HANDOFF_MAX_ENCODED_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error("The Scan handoff is malformed or too large.");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("The Scan handoff could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The Scan handoff contains invalid text.");
  }
}

export function parseScanDiagnosticHandoff(
  encoded: string,
  now: Date = new Date(),
): ScanDiagnosticHandoff {
  let value: unknown;
  try {
    value = JSON.parse(decodeBase64Url(encoded));
  } catch (caught: unknown) {
    if (caught instanceof SyntaxError) {
      throw new Error("The Scan handoff does not contain valid JSON.");
    }
    throw caught;
  }
  const parsed = ScanDiagnosticHandoffSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "The Scan handoff is invalid.");
  }
  assertNotFuture(parsed.data.observedAt, now);
  return parsed.data;
}

export function parseScanDiagnosticHash(
  hash: string,
  now: Date = new Date(),
): ScanDiagnosticHandoff | null {
  if (!hash.startsWith(SCAN_HANDOFF_FRAGMENT_PREFIX)) return null;
  return parseScanDiagnosticHandoff(
    hash.slice(SCAN_HANDOFF_FRAGMENT_PREFIX.length),
    now,
  );
}

export function createPendingScanHandoff(
  handoff: ScanDiagnosticHandoff,
  now: Date = new Date(),
): string {
  assertNotFuture(handoff.observedAt, now);
  return JSON.stringify(PendingScanHandoffSchema.parse({
    version: 1,
    expiresAt: now.getTime() + SCAN_HANDOFF_SESSION_TTL_MS,
    handoff,
  }));
}

export function parsePendingScanHandoff(
  value: string,
  now: Date = new Date(),
): ScanDiagnosticHandoff {
  if (value.length < 1 || value.length > SCAN_HANDOFF_MAX_STORED_LENGTH) {
    throw new Error("The temporary Scan handoff is malformed or too large.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("The temporary Scan handoff is invalid.");
  }
  const parsed = PendingScanHandoffSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "The temporary Scan handoff is invalid.");
  }
  if (parsed.data.expiresAt <= now.getTime()) {
    throw new Error("The temporary Scan handoff expired. Reopen it from the Audit report.");
  }
  assertNotFuture(parsed.data.handoff.observedAt, now);
  return parsed.data.handoff;
}

export function scanSnapshotStatus(
  handoff: ScanDiagnosticHandoff,
  now: Date = new Date(),
): "current" | "stale" {
  assertNotFuture(handoff.observedAt, now);
  return now.getTime() - Date.parse(handoff.observedAt) > SCAN_STALE_AFTER_MS
    ? "stale"
    : "current";
}

function emailSafeText(value: string): string {
  return value.replace(/[—–]/g, "-");
}

function greeting(recipientName: string | null): string {
  return recipientName ? `Hi ${emailSafeText(recipientName)},` : "Hi,";
}

function observedDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function quotedTechnicalPayload(value: string): string[] {
  return emailSafeText(value).split("\n").map((line) => `| ${line}`);
}

function securityDisclosureSubject(affectedAsset: string): string {
  return `Security routing notice for ${new URL(affectedAsset).hostname}`;
}

function commercialSubject(domain: string): string {
  return `A public-site issue on ${emailSafeText(domain)}`;
}

interface CommercialBodyInput {
  readonly recipientName: string | null;
  readonly domain: string;
  readonly observedAt: string;
  readonly preparedRepair: string;
  readonly verificationStep: string;
  readonly postalAddress: string;
}

function securityDisclosureBody(value: {
  readonly operatorName: "Jason" | "Johnny";
  readonly affectedAsset: string;
  readonly observedAt: string;
  readonly discoveryMethod: "passive-observation" | "authorized-test";
  readonly category: z.infer<typeof SecurityObservationCategorySchema>;
}): string {
  const methodStatement = value.discoveryMethod === "passive-observation"
    ? "I did not access non-public data or test beyond the passive public observation recorded in the local evidence reference."
    : "This observation came from testing performed under documented authorization. No further testing will be initiated from this draft.";
  return [
    "Hello security team,",
    "",
    `I am requesting the correct private route for a potential ${SECURITY_OBSERVATION_CATEGORY_LABELS[value.category]} observation affecting ${emailSafeText(value.affectedAsset)} from ${observedDate(value.observedAt)}.`,
    "",
    methodStatement,
    "",
    "This routing notice intentionally omits reproduction details and remediation. Supporting technical evidence should be shared only through the recipient's confirmed private disclosure process.",
    "",
    "Please route this notice to the appropriate security or engineering contact. No commercial service is offered in this disclosure.",
    "",
    value.operatorName,
    "Suede Labs AI",
  ].join("\n");
}

function commercialBody(
  input: CommercialBodyInput,
  primary: ScanDiagnosticFinding,
  supporting: readonly ScanDiagnosticFinding[],
): string {
  const supportSection = supporting.length > 0
    ? [
        "",
        `The same snapshot included ${supporting.length === 1 ? "one additional public-site observation" : `${supporting.length} additional public-site observations`}:`,
        ...supporting.map((finding) => (
          `- ${emailSafeText(finding.title)}. Observed: ${emailSafeText(finding.observed)}`
        )),
      ]
    : [];
  return [
    greeting(input.recipientName),
    "",
    `A Suede Audit snapshot dated ${observedDate(input.observedAt)} reported an issue on ${emailSafeText(input.domain)}. I checked the public page and reproduced the primary observation:`,
    "",
    emailSafeText(primary.title),
    `Observed: ${emailSafeText(primary.observed)}`,
    `Audit repair direction: ${emailSafeText(primary.action)}`,
    "",
    "Prepared repair payload (quoted technical content):",
    "[BEGIN PREPARED REPAIR]",
    ...quotedTechnicalPayload(input.preparedRepair),
    "[END PREPARED REPAIR]",
    "",
    "Verification payload (quoted technical content):",
    "[BEGIN VERIFICATION STEP]",
    ...quotedTechnicalPayload(input.verificationStep),
    "[END VERIFICATION STEP]",
    "",
    "This is a prepared fix, not a claim that your site has already changed.",
    "",
    emailSafeText(JASON_OUTBOUND_PROFILE.credibilityStatement),
    ...supportSection,
    "",
    "If you want, I can send the extended Suede Scan with the remaining search visibility and site-integrity findings, ordered by priority and implementation sequence. Suede can also implement approved fixes and re-scan the public site.",
    "",
    "Would that be useful?",
    "",
    JASON_OUTBOUND_PROFILE.name,
    JASON_OUTBOUND_PROFILE.title,
    JASON_OUTBOUND_PROFILE.identityUrl,
    "",
    "Commercial outreach",
    emailSafeText(input.postalAddress),
    'Reply "no" and I will not follow up.',
  ].join("\n");
}

export function buildOutboundDiagnostic(
  value: OutboundDiagnosticInput,
  now: Date = new Date(),
): OutboundDiagnosticDraft {
  const input = OutboundDiagnosticInputSchema.parse(value);
  assertNotFuture(input.handoff.observedAt, now);
  const primary = input.handoff.findings.find(
    (finding) => finding.id === input.primaryFindingId,
  );
  if (!primary) {
    throw new Error("Choose a primary finding from the imported Scan.");
  }
  const supporting = input.handoff.findings
    .filter((finding) => finding.id !== primary.id)
    .slice(0, 2);
  const subject = commercialSubject(input.handoff.domain);
  const body = commercialBody({
    recipientName: input.recipientName,
    domain: input.handoff.domain,
    observedAt: input.handoff.observedAt,
    preparedRepair: input.preparedRepair,
    verificationStep: input.verificationStep,
    postalAddress: input.postalAddress,
  }, primary, supporting);
  if (subject.includes("—") || body.includes("—")) {
    throw new Error("Outbound copy cannot contain an em dash.");
  }
  return OutboundDiagnosticDraftSchema.parse({
    mode: "commercial-diagnostic",
    subject,
    body,
    recipientName: input.recipientName,
    domain: input.handoff.domain,
    observedAt: input.handoff.observedAt,
    postalAddress: input.postalAddress,
    primaryFinding: primary,
    supportingFindings: supporting,
    preparedRepair: input.preparedRepair,
    verificationStep: input.verificationStep,
    evidenceBoundary: COMMERCIAL_EVIDENCE_BOUNDARY,
    snapshotStatus: scanSnapshotStatus(input.handoff, now),
  });
}

export function formatOutboundDiagnosticText(
  draft: OutboundDiagnosticDraft,
): string {
  const parsed = OutboundDiagnosticDraftSchema.parse(draft);
  return `Subject: ${parsed.subject}\n\n${parsed.body}`;
}

export function buildSecurityDisclosure(
  value: SecurityDisclosureInput,
  now: Date = new Date(),
): SecurityDisclosureDraft {
  const input = SecurityDisclosureInputSchema.parse(value);
  assertNotFuture(input.observedAt, now);
  const subject = securityDisclosureSubject(input.affectedAsset);
  const body = securityDisclosureBody(input);
  if (subject.includes("—") || body.includes("—")) {
    throw new Error("Disclosure copy cannot contain an em dash.");
  }
  return SecurityDisclosureDraftSchema.parse({
    mode: "security-disclosure",
    subject,
    body,
    operatorName: input.operatorName,
    affectedAsset: input.affectedAsset,
    observedAt: input.observedAt,
    discoveryMethod: input.discoveryMethod,
    authorizationReference: input.authorizationReference,
    category: input.category,
    evidenceReference: input.evidenceReference,
    disclosureChannelConfirmed: input.disclosureChannelConfirmed,
    operatorAttested: input.operatorAttested,
    evidenceBoundary: "Fixed routing template only. Operator evidence remains local, is not copied into the notice, and does not originate from a Suede Audit site-integrity finding.",
  });
}

export function formatSecurityDisclosureText(
  draft: SecurityDisclosureDraft,
): string {
  const parsed = SecurityDisclosureDraftSchema.parse(draft);
  return `Subject: ${parsed.subject}\n\n${parsed.body}`;
}
