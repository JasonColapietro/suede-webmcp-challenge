/**
 * Seed the public directory with launched agents built from the template
 * catalog, via the same public API the studio itself uses (POST /api/flows →
 * POST /api/flows/:id/launch). Safe to re-run: any template whose name already
 * appears in the target's /api/catalog is skipped.
 *
 * Only input-triggered templates are seeded — nothing with a schedule node, so
 * seeded agents never run (or spend) on their own; they 402 until a caller
 * pays. Prices come from each template's suggestedPriceUsdc.
 *
 * SEED_OWNER_ID is the anonymous workspace id the flows will belong to. It
 * doubles as a bearer-style secret (see src/lib/auth.ts) — keep it out of git.
 *
 *   SEED_OWNER_ID=<uuid> BASE_URL=https://agents.suedeai.ai \
 *     npx tsx scripts/seed-directory-agents.ts
 */
import { SEED_TEMPLATES } from "../src/lib/templates";

const BASE = (process.env.BASE_URL ?? "http://localhost:3210").replace(/\/$/, "");
const OWNER = process.env.SEED_OWNER_ID;
if (!OWNER) throw new Error("SEED_OWNER_ID is required (an unguessable UUID).");

/** Input-triggered templates only — no schedule nodes, no comms webhooks. */
const SEED_NAMES = [
  "Contract Term Extractor",
  "Refund Decision Desk",
  "Expense Policy Check",
  "Stack-Trace Triage",
  "Function-to-Test-Cases",
  "Regex From Examples",
  "Transaction Categorizer",
  "Bank Rec Discrepancy Finder",
  "Vendor Risk Read",
  "Keyword Cluster Planner",
  "Spec Sheet to Listing + SEO",
  "KB Article Drafter",
  "Decision Memo Builder",
  "RICE Prioritizer",
  "Interview Scorecard Builder",
  "Lead Enrichment Agent",
  "Cold Outreach Sequencer",
  "Blog-to-Social Repurposer",
  "SEO Content Brief Generator",
  "API Docs Generator",
  "Meeting Prep Brief",
  "FAQ Concierge",
  "Meeting Notes to Action Items",
  "Licensing Desk",
  "Data Analysis Agent",
  "Sales Call Scorecard",
];

const headers = { "content-type": "application/json", "x-owner-id": OWNER };

async function main(): Promise<void> {
  const catalogRes = await fetch(`${BASE}/api/catalog?b=${Date.now()}`);
  const catalog = catalogRes.ok
    ? ((await catalogRes.json()) as { agents?: { name: string }[] })
    : { agents: [] };
  const liveNames = new Set((catalog.agents ?? []).map((a) => a.name));
  console.log(`${BASE}: ${liveNames.size} agents already live`);

  let launched = 0;
  for (const name of SEED_NAMES) {
    const template = SEED_TEMPLATES.find((t) => t.name === name);
    if (!template) {
      console.error(`✗ no template named "${name}"`);
      continue;
    }
    if (liveNames.has(name)) {
      console.log(`• already live: ${name}`);
      continue;
    }
    if (template.graph.nodes.some((n) => n.type === "schedule")) {
      console.error(`✗ refusing to seed scheduled template: ${name}`);
      continue;
    }

    const createRes = await fetch(`${BASE}/api/flows`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: template.name, graph: template.graph }),
    });
    if (!createRes.ok) {
      console.error(`✗ create failed (${createRes.status}) for ${name}: ${await createRes.text()}`);
      continue;
    }
    const { flow } = (await createRes.json()) as { flow: { id: string } };

    const launchRes = await fetch(`${BASE}/api/flows/${flow.id}/launch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ priceUsdc: template.suggestedPriceUsdc }),
    });
    if (!launchRes.ok) {
      console.error(`✗ launch failed (${launchRes.status}) for ${name}: ${await launchRes.text()}`);
      continue;
    }
    const launchBody = (await launchRes.json()) as { slug: string };
    launched += 1;
    console.log(`✓ live: ${name} → /a/${launchBody.slug} @ $${template.suggestedPriceUsdc}`);
  }
  console.log(`Done. Launched ${launched} new agents.`);
}

await main();
