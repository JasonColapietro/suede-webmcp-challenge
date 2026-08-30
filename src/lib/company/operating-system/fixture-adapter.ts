import {
  OperatingAdapterResultSchema,
  type OperatingAdapterResult,
  type OperatingMilestone,
  type OperatingProject,
} from "./schema";

const FIXTURE_IMPORTED_AT = "2026-07-29T00:00:00.000Z";
const JASON = { kind: "person" as const, label: "Jason / authorized Suede operator" };
const SUEDE_TEAM = { kind: "team" as const, label: "Suede operators" };

const projects: OperatingProject[] = [
  {
    id: "estate:suede-core",
    name: "Suede ownership infrastructure",
    surface: "suedeai.ai",
    objective: "Operate the creator-ownership, rights, provenance, licensing, and agent-commerce entry point.",
    owner: JASON,
    status: "live",
    dependencies: [],
    evidenceIds: ["fixture:suede-core"],
    lastVerifiedAt: null,
    nextAction: "Verify the exact public routes and attach a fresh deployment or HTTP receipt.",
    productionClaim: true,
    sourceAdapter: "suede-estate-fixture",
  },
  {
    id: "estate:agent-studio",
    name: "Suede Agent Studio",
    surface: "agents.suedeai.ai",
    objective: "Build and govern companies of agents with manual approvals, evidence receipts, and explicit operating controls.",
    owner: JASON,
    status: "live",
    dependencies: [
      {
        id: "dep:agent-studio-auth",
        label: "Shared Suede account authentication",
        state: "ready",
        projectId: null,
        evidenceIds: ["fixture:agent-studio"],
      },
    ],
    evidenceIds: ["fixture:agent-studio"],
    lastVerifiedAt: null,
    nextAction: "Verify /company/operations in the authenticated production account and attach the deployment receipt.",
    productionClaim: true,
    sourceAdapter: "suede-estate-fixture",
  },
  {
    id: "estate:suede-social",
    name: "Suede Social",
    surface: "social.suedeai.ai",
    objective: "Operate the creator community and interactive music-gear surfaces without overstating adoption.",
    owner: SUEDE_TEAM,
    status: "live",
    dependencies: [
      {
        id: "dep:social-shared-deploy",
        label: "Shared application deployment",
        state: "unknown",
        projectId: "estate:suede-core",
        evidenceIds: ["fixture:suede-social"],
      },
    ],
    evidenceIds: ["fixture:suede-social"],
    lastVerifiedAt: null,
    nextAction: "Verify the exact live route and current release state before planning the next community change.",
    productionClaim: true,
    sourceAdapter: "suede-estate-fixture",
  },
  {
    id: "estate:strumly",
    name: "Strumly",
    surface: "Strumly product surfaces",
    objective: "Operate musician workflows and guitar-focused tools with evidence-backed release status.",
    owner: SUEDE_TEAM,
    status: "live",
    dependencies: [],
    evidenceIds: ["fixture:strumly"],
    lastVerifiedAt: null,
    nextAction: "Resolve the canonical live surface, then attach a fresh route and deployment receipt.",
    productionClaim: true,
    sourceAdapter: "suede-estate-fixture",
  },
  {
    id: "estate:creation-apps",
    name: "Suede creation apps",
    surface: "Music · Voice · Muse",
    objective: "Ship focused creation products while keeping purchase, restore, pricing, and review claims tied to platform evidence.",
    owner: JASON,
    status: "building",
    dependencies: [
      {
        id: "dep:creation-platform-review",
        label: "Current App Store and Play records",
        state: "unknown",
        projectId: "estate:mobile-distribution",
        evidenceIds: ["fixture:creation-apps"],
      },
    ],
    evidenceIds: ["fixture:creation-apps"],
    lastVerifiedAt: null,
    nextAction: "Read the exact current platform record for the next app in review before changing code or metadata.",
    productionClaim: false,
    sourceAdapter: "suede-estate-fixture",
  },
  {
    id: "estate:ip-registry",
    name: "Suede IP Registry",
    surface: "Registry-backed rights surface",
    objective: "Operate the registry-backed rights and provenance layer behind a current security evidence gate.",
    owner: JASON,
    status: "blocked",
    dependencies: [
      {
        id: "dep:registry-security",
        label: "Current security review closure",
        state: "blocked",
        projectId: null,
        evidenceIds: ["fixture:ip-registry"],
      },
    ],
    evidenceIds: ["fixture:ip-registry"],
    lastVerifiedAt: null,
    nextAction: "Open the current security review, identify the exact unresolved blocker, and verify it against the live branch.",
    productionClaim: false,
    sourceAdapter: "suede-estate-fixture",
  },
  {
    id: "estate:machine-discovery",
    name: "Suede machine discovery",
    surface: "Docs · manifests · catalogs",
    objective: "Keep agent, x402, documentation, and search discovery surfaces accurate to deployed capability.",
    owner: { kind: "agent", label: "Suede release verifier" },
    status: "building",
    dependencies: [
      {
        id: "dep:discovery-source-receipts",
        label: "Fresh source and deployment receipts",
        state: "unknown",
        projectId: "estate:agent-studio",
        evidenceIds: ["fixture:machine-discovery"],
      },
    ],
    evidenceIds: ["fixture:machine-discovery"],
    lastVerifiedAt: null,
    nextAction: null,
    productionClaim: false,
    sourceAdapter: "suede-estate-fixture",
  },
  {
    id: "estate:mobile-distribution",
    name: "Mobile distribution",
    surface: "App Store Connect · Google Play",
    objective: "Move current Suede app releases through review with exact platform issue evidence and no invented approval state.",
    owner: JASON,
    status: "building",
    dependencies: [
      {
        id: "dep:mobile-owner-review",
        label: "Owner review or platform approval",
        state: "unknown",
        projectId: null,
        evidenceIds: ["fixture:mobile-distribution"],
      },
    ],
    evidenceIds: ["fixture:mobile-distribution"],
    lastVerifiedAt: null,
    nextAction: "Open the exact App Store or Play record for the highest-priority release and record its current blocking issue.",
    productionClaim: false,
    sourceAdapter: "suede-estate-fixture",
  },
];

const milestones: OperatingMilestone[] = projects.map((project) => ({
  id: `milestone:${project.id}:fresh-proof`,
  projectId: project.id,
  title: "Attach current proof",
  outcome: `Replace imported ${project.surface} status with a source receipt that another operator can reproduce.`,
  state: project.status === "blocked" ? "blocked" : "in-progress",
  target: null,
  blocker: project.status === "blocked"
    ? project.dependencies.find((dependency) => dependency.state === "blocked")?.label ?? "Blocked dependency"
    : null,
  owner: project.owner,
  evidenceIds: project.evidenceIds,
  ...(project.id === "estate:agent-studio" ? { href: "/company/operations" } : {}),
}));

export function collectSuedeEstateFixture(now: Date): OperatingAdapterResult {
  const result = {
    adapterId: "suede-estate-fixture",
    label: "Suede estate import",
    status: "partial" as const,
    checkedAt: now.toISOString(),
    note: "Deterministic first-party starter map. Imported status is context, not live proof; replace it with connector receipts as adapters land.",
    projects,
    milestones,
    evidence: projects.map((project) => ({
      id: project.evidenceIds[0]!,
      source: "fixture" as const,
      scope: "project" as const,
      label: `${project.name} import record`,
      claim: `The imported operating map declares ${project.name} as ${project.status}; this adapter did not verify the live surface.`,
      observedAt: FIXTURE_IMPORTED_AT,
      verification: "declared" as const,
      statusClaim: project.status,
      production: false,
      ...(project.id === "estate:agent-studio"
        ? { href: "/company/operations" }
        : project.surface.includes(".")
          ? { href: `https://${project.surface}` }
          : {}),
    })),
    approvals: [],
  };
  return OperatingAdapterResultSchema.parse(result);
}
