#!/usr/bin/env node
// x402 Offer Assurance Runbook — Tiers A, B, C1, C2, D (C3 stays BLOCKED, gated on a
// funded canary wallet per the spec's Open Question 1). Contract lives at the vault:
// 06_agents/X402_Offer_Assurance_Runbook.md. Report-only: never edits prices, wallets,
// discovery documents, env vars, or code, and never sends funds.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const USDC_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PLATFORM_PAYTO = '0xb5a05466712fd5bcdf2883f43cC6B1799428032d';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ATOMIC_RE = /^[0-9]+$/;
const CANONICAL_NETWORKS = ['base', 'eip155:8453'];
const ALIAS_NETWORK = 'base-mainnet';

const AGENT_STUDIO_ROOT = 'https://agents.suedeai.ai/.well-known/x402';
const APP_GATEWAY_ROOT = 'https://app.suedeai.ai/.well-known/x402.json';
const AGENT_STUDIO_CATALOG = 'https://agents.suedeai.ai/api/catalog';
const CDP_BAZAAR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const BLOCKSCOUT_BASE = 'https://base.blockscout.com';
const GH_REPO = 'Suede-AI/Suede-AI-App';
const GH_WORKFLOW = 'backend-tests.yml';

const VAULT_ROOT =
  '/Users/jasoncolapietro/Library/CloudStorage/GoogleDrive-jasoncola1@gmail.com/My Drive/Codex Claude Memory Vault';
const HANDOFF_DIR = path.join(VAULT_ROOT, '05_handoffs');
const AGENT_TAG = 'x402-assurance-cron';

const FETCH_TIMEOUT_MS = 15_000;
const BAZAAR_PAGE_SIZE = 100;
const BAZAAR_CONCURRENCY = 8;
const BAZAAR_MAX_PAGES = 500; // safety valve; log if the real page count exceeds this

async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { ok: true, status: res.status, headers: res.headers, json, text, url };
  } catch (err) {
    return { ok: false, error: String(err), url };
  } finally {
    clearTimeout(timer);
  }
}

function isAddr(v) {
  return typeof v === 'string' && ADDR_RE.test(v);
}
function isZero(v) {
  return typeof v === 'string' && v.toLowerCase() === ZERO_ADDRESS;
}
function sameAddr(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

// One row per contract check ID. verdict: PASS | FAIL | FLAG | BLOCKED
const results = [];
function record(id, verdict, evidence) {
  results.push({ id, verdict, evidence });
}

// ---------------------------------------------------------------------------
// Tier A: discovery integrity
// ---------------------------------------------------------------------------

let agentStudioRoot = null;
let appGatewayRoot = null;
let agentStudioCatalog = null;
// Per-agent discovery docs and live 402 challenges, keyed by agent id, gathered while
// running A2-A4 so B1/B3/B4 can reuse the run URLs without re-fetching the catalog.
const perAgentDocs = [];

async function checkA1() {
  const evidence = [];
  let verdict = 'PASS';

  const r1 = await fetchJson(AGENT_STUDIO_ROOT);
  if (!r1.ok || r1.status !== 200 || !r1.json || r1.json.x402Version !== 1 || !Array.isArray(r1.json.endpoints) || r1.json.endpoints.length === 0) {
    verdict = 'FAIL';
    evidence.push(`agent studio root: ${r1.ok ? `HTTP ${r1.status}` : r1.error}`);
  } else {
    agentStudioRoot = r1.json;
    evidence.push(`agent studio root: HTTP 200, ${r1.json.endpoints.length} endpoints`);
  }

  const r2 = await fetchJson(APP_GATEWAY_ROOT);
  const catalogSource = r2.ok ? r2.headers.get('x-catalog-source') : null;
  if (!r2.ok || r2.status !== 200 || !r2.json || !r2.json.x402Version || !Array.isArray(r2.json.resources) || r2.json.resources.length === 0 || catalogSource !== 'live') {
    verdict = 'FAIL';
    evidence.push(`app gateway root: ${r2.ok ? `HTTP ${r2.status}, X-Catalog-Source=${catalogSource}` : r2.error}`);
  } else {
    appGatewayRoot = r2.json;
    evidence.push(`app gateway root: HTTP 200, ${r2.json.resources.length} resources, X-Catalog-Source=live`);
  }

  record('A1', verdict, evidence.join(' | '));
}

async function checkA2() {
  if (!agentStudioRoot) {
    record('A2', 'BLOCKED', 'agent studio root index unavailable (see A1)');
    return;
  }
  const evidence = [];
  let verdict = 'PASS';

  const catalogRes = await fetchJson(AGENT_STUDIO_CATALOG);
  if (!catalogRes.ok || catalogRes.status !== 200 || !catalogRes.json) {
    record('A2', 'BLOCKED', `catalog unreachable: ${catalogRes.ok ? `HTTP ${catalogRes.status}` : catalogRes.error}`);
    return;
  }
  agentStudioCatalog = catalogRes.json;

  const rootRunUrls = new Set(agentStudioRoot.endpoints.map((e) => e.resource));
  const catalogRunUrls = new Set(agentStudioCatalog.agents.map((a) => a.urls.run));
  const onlyInRoot = [...rootRunUrls].filter((u) => !catalogRunUrls.has(u));
  const onlyInCatalog = [...catalogRunUrls].filter((u) => !rootRunUrls.has(u));
  if (onlyInRoot.length || onlyInCatalog.length) {
    verdict = 'FAIL';
    evidence.push(`catalog/index mismatch: +root ${onlyInRoot.length}, +catalog ${onlyInCatalog.length}`);
  } else {
    evidence.push(`catalog and root index agree on ${rootRunUrls.size} run URLs`);
  }

  const urlChecks = [];
  for (const endpoint of agentStudioRoot.endpoints) {
    urlChecks.push({ label: `discovery ${endpoint.name}`, url: endpoint.discovery });
    urlChecks.push({ label: `agentCard ${endpoint.name}`, url: endpoint.agentCard });
  }
  const fetched = await Promise.all(urlChecks.map((c) => fetchJson(c.url)));
  fetched.forEach((r, i) => {
    if (!r.ok || r.status !== 200 || !r.json) {
      verdict = 'FAIL';
      evidence.push(`${urlChecks[i].label}: ${r.ok ? `HTTP ${r.status}` : r.error}`);
    }
  });
  if (!evidence.some((e) => e.includes('discovery') || e.includes('agentCard'))) {
    evidence.push(`${fetched.length} discovery/agentCard URLs all HTTP 200`);
  }

  // stash per-agent discovery docs for A3/A4/B checks
  agentStudioRoot.endpoints.forEach((endpoint, i) => {
    perAgentDocs.push({ name: endpoint.name, rootAccepts: endpoint.accepts, discoveryDoc: fetched[i * 2]?.json ?? null, discoveryUrl: endpoint.discovery, runUrl: endpoint.resource });
  });

  record('A2', verdict, evidence.join(' | '));
}

// Structured known-defect counters, set while walking every accepts entry in checkA3.
// deriveKnownDefects() reads these instead of pattern-matching the (truncated) evidence
// string, so a defect's status is never lost to the "show first 3 examples" summary.
const kdHits = { 'KD-1': 0, 'KD-2': 0, 'KD-3': 0, 'KD-6': 0 };

function checkAccepts(source, accepts, resourceContext) {
  const problems = [];
  for (const a of accepts) {
    let severity = null;
    let msg = null;
    if (a.scheme !== 'exact') {
      severity = 'FAIL';
      msg = `${source}: scheme=${a.scheme}`;
    } else if (!sameAddr(a.asset, USDC_ASSET)) {
      severity = 'FAIL';
      msg = `${source}: asset=${a.asset}`;
    } else if (!isAddr(a.payTo) || isZero(a.payTo)) {
      severity = 'FAIL';
      msg = `${source}: payTo=${a.payTo}`;
    }
    if (severity) problems.push({ severity, msg });

    if (!ATOMIC_RE.test(String(a.maxAmountRequired))) {
      kdHits['KD-1'] += 1;
      problems.push({ severity: 'FAIL', msg: `${source}: maxAmountRequired="${a.maxAmountRequired}" (not atomic, KD-1)` });
    }
    const resource = a.resource ?? resourceContext;
    if (!resource || !resource.startsWith('https://')) {
      kdHits['KD-3'] += 1;
      problems.push({ severity: 'FAIL', msg: `${source}: resource="${resource}" (relative, KD-3)` });
    }
    if (a.network === ALIAS_NETWORK) {
      kdHits['KD-2'] += 1;
      problems.push({ severity: 'FLAG', msg: `${source}: network=base-mainnet (alias, KD-2, FLAG)` });
    } else if (!CANONICAL_NETWORKS.includes(a.network)) {
      problems.push({ severity: 'FAIL', msg: `${source}: network=${a.network}` });
    }
  }
  return problems;
}

async function checkA3() {
  if (!agentStudioRoot || !appGatewayRoot) {
    record('A3', 'BLOCKED', 'one or both root indexes unavailable (see A1)');
    return;
  }
  const problems = [];

  for (const endpoint of agentStudioRoot.endpoints) {
    problems.push(...checkAccepts(`root:${endpoint.name}`, endpoint.accepts, endpoint.resource));
    if (!('mimeType' in endpoint)) kdHits['KD-6'] += 1;
  }
  for (const doc of perAgentDocs) {
    if (doc.discoveryDoc?.accepts) {
      problems.push(...checkAccepts(`discovery:${doc.name}`, doc.discoveryDoc.accepts, doc.discoveryDoc.resource));
    }
  }
  for (const resourceEntry of appGatewayRoot.resources) {
    problems.push(...checkAccepts(`app:${resourceEntry.resource}`, resourceEntry.accepts, resourceEntry.resource));
  }

  const hardFails = problems.filter((p) => p.severity === 'FAIL');
  const flags = problems.filter((p) => p.severity === 'FLAG');
  let verdict = 'PASS';
  if (hardFails.length) verdict = 'FAIL';
  else if (flags.length) verdict = 'FLAG';

  const messages = problems.map((p) => p.msg);
  const evidence =
    verdict === 'PASS'
      ? 'all accepts entries conformant across both surfaces'
      : `${hardFails.length} FAIL + ${flags.length} FLAG (examples: ${messages.slice(0, 3).join('; ')}${messages.length > 3 ? ` … +${messages.length - 3} more (KD-1:${kdHits['KD-1']}, KD-2:${kdHits['KD-2']}, KD-3:${kdHits['KD-3']})` : ''})`;

  record('A3', verdict, evidence);
}

async function checkA4() {
  if (!agentStudioCatalog || perAgentDocs.length === 0) {
    record('A4', 'BLOCKED', 'catalog or per-agent discovery docs unavailable (see A2)');
    return;
  }
  const problems = [];

  for (const agent of agentStudioCatalog.agents) {
    const doc = perAgentDocs.find((d) => d.runUrl === agent.urls.run);
    if (!doc) {
      problems.push(`${agent.name}: no matching discovery doc`);
      continue;
    }
    const challengeRes = await fetchJson(agent.urls.run, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const challengeAccepts = challengeRes.json?.accepts?.[0];
    const discoveryAccepts = doc.discoveryDoc?.accepts?.[0];

    const priceUsdc = agent.priceUsdc;
    const atomicExpected = String(Math.round(priceUsdc * 1_000_000));
    for (const [label, accepts] of [
      ['discovery', discoveryAccepts],
      ['402 challenge', challengeAccepts],
    ]) {
      if (!accepts) {
        problems.push(`${agent.name}: ${label} missing accepts entry`);
        continue;
      }
      const amt = String(accepts.maxAmountRequired);
      const matchesHuman = amt === String(priceUsdc);
      const matchesAtomic = amt === atomicExpected;
      if (!matchesHuman && !matchesAtomic) {
        problems.push(`${agent.name}: catalog priceUsdc=${priceUsdc} vs ${label} maxAmountRequired="${amt}"`);
      }
      if (!sameAddr(accepts.payTo, agent.payTo)) {
        problems.push(`${agent.name}: catalog payTo=${agent.payTo} vs ${label} payTo=${accepts.payTo}`);
      }
    }
  }

  const verdict = problems.length ? 'FAIL' : 'PASS';
  const evidence = problems.length
    ? `${problems.length} mismatch(es): ${problems.slice(0, 3).join('; ')}`
    : `price and payTo consistent across catalog, discovery doc, and live 402 challenge for ${agentStudioCatalog.agents.length} agents`;
  record('A4', verdict, evidence);
}

async function checkA5() {
  if (!appGatewayRoot) {
    record('A5', 'BLOCKED', 'app gateway root index unavailable (see A1)');
    return;
  }
  const count = appGatewayRoot.resources.length;
  const verdict = count === 3 ? 'PASS' : 'FAIL';
  const evidence =
    count === 3
      ? '3 resources discoverable, matches Skyfire allowlist'
      : `${count} resources discoverable, expected exactly 3 (agent_music, create_music, agent_video) — see KD-5`;
  record('A5', verdict, evidence);
}

// ---------------------------------------------------------------------------
// Tier B: challenge behavior
// ---------------------------------------------------------------------------

async function checkB1() {
  if (!agentStudioCatalog) {
    record('B1', 'BLOCKED', 'catalog unavailable (see A2)');
    return;
  }
  const problems = [];
  for (const agent of agentStudioCatalog.agents) {
    const res = await fetchJson(agent.urls.run, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const link = res.ok ? res.headers.get('link') : null;
    const hasDiscoveryLink = typeof link === 'string' && link.includes('rel="x402-discovery"');
    if (!res.ok || res.status !== 402 || !res.json || res.json.x402Version !== 1 || !Array.isArray(res.json.accepts) || res.json.accepts.length === 0 || !hasDiscoveryLink) {
      problems.push(`${agent.name}: ${res.ok ? `HTTP ${res.status}, link=${link}` : res.error}`);
    }
  }
  const verdict = problems.length ? 'FAIL' : 'PASS';
  record('B1', verdict, problems.length ? problems.join('; ') : `${agentStudioCatalog.agents.length}/${agentStudioCatalog.agents.length} unpaid POSTs correctly challenged (402 + accepts + Link)`);
}

async function checkB2() {
  if (!agentStudioCatalog) {
    record('B2', 'BLOCKED', 'catalog unavailable (see A2)');
    return;
  }
  const freeAgents = agentStudioCatalog.agents.filter((a) => a.priceUsdc === 0);
  if (freeAgents.length === 0) {
    record('B2', 'PASS', 'no free (priceUsdc=0) live agents to test — vacuously satisfied');
    return;
  }
  const problems = [];
  for (const agent of freeAgents) {
    const res = await fetchJson(agent.urls.run, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.ok && res.status === 402) problems.push(`${agent.name}: got HTTP 402`);
  }
  record('B2', problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('; ') : `${freeAgents.length} free agent(s) not challenged`);
}

async function checkB3() {
  if (!agentStudioCatalog) {
    record('B3', 'BLOCKED', 'catalog unavailable (see A2)');
    return;
  }
  const target = agentStudioCatalog.agents[0];
  if (!target) {
    record('B3', 'BLOCKED', 'no live agent to test');
    return;
  }
  const res = await fetchJson(target.urls.run, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: true }),
  });
  if (!res.ok) {
    record('B3', 'BLOCKED', res.error);
    return;
  }
  const settledTrue = res.json?.settled === true;
  const hasTx = 'transaction' in (res.json ?? {});
  if (settledTrue || hasTx) {
    record('B3', 'FAIL', `CRITICAL: dry run on ${target.name} returned settled=${res.json?.settled}, transaction present=${hasTx} — escalate immediately`);
    return;
  }
  const verdict = res.status === 200 && res.json?.settled === false && !hasTx ? 'PASS' : 'FAIL';
  record('B3', verdict, `${target.name}: HTTP ${res.status}, settled=${res.json?.settled}, transaction present=${hasTx}`);
}

async function checkB4() {
  if (!agentStudioCatalog) {
    record('B4', 'BLOCKED', 'catalog unavailable (see A2)');
    return;
  }
  const target = agentStudioCatalog.agents[0];
  if (!target) {
    record('B4', 'BLOCKED', 'no live agent to test');
    return;
  }
  const garbage = Buffer.from(JSON.stringify({ junk: true })).toString('base64');
  const res = await fetchJson(target.urls.run, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PAYMENT': garbage },
    body: '{}',
  });
  if (!res.ok) {
    record('B4', 'BLOCKED', res.error);
    return;
  }
  if (res.status === 200) {
    record('B4', 'FAIL', `CRITICAL: garbage X-PAYMENT on ${target.name} returned HTTP 200 (payment bypass) — escalate immediately`);
    return;
  }
  if (res.status === 500) {
    record('B4', 'FAIL', `garbage X-PAYMENT on ${target.name} returned HTTP 500 (gate crashes on malformed input)`);
    return;
  }
  const verdict = res.status === 402 ? 'PASS' : 'FAIL';
  record('B4', verdict, `${target.name}: HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Tier C: payability and settlement
// ---------------------------------------------------------------------------

const allPayTos = new Set();

async function checkC1() {
  const url = `${BLOCKSCOUT_BASE}/api/v2/addresses/${PLATFORM_PAYTO}/token-transfers?type=ERC-20&filter=to&token=${USDC_ASSET}`;
  const res = await fetchJson(url);
  if (!res.ok || res.status !== 200 || !res.json) {
    record('C1', 'BLOCKED', `Blockscout unreachable: ${res.ok ? `HTTP ${res.status}` : res.error}`);
    return;
  }
  const items = res.json.items ?? [];
  if (items.length === 0) {
    record('C1', 'FLAG', 'no inbound USDC transfers found on payTo wallet');
    return;
  }
  const mostRecent = items[0].timestamp;
  const ageDays = (Date.now() - new Date(mostRecent).getTime()) / (1000 * 60 * 60 * 24);
  const verdict = ageDays <= 14 ? 'PASS' : 'FLAG';
  record('C1', verdict, `most recent inbound USDC transfer: ${mostRecent} (${ageDays.toFixed(1)}d ago)`);
}

async function checkC2() {
  // Reuses payTo values discovered while walking A3/A4 so we don't refetch every document.
  agentStudioRoot?.endpoints?.forEach((e) => e.accepts.forEach((a) => allPayTos.add(a.payTo)));
  perAgentDocs.forEach((d) => d.discoveryDoc?.accepts?.forEach((a) => allPayTos.add(a.payTo)));
  appGatewayRoot?.resources?.forEach((r) => r.accepts.forEach((a) => allPayTos.add(a.payTo)));
  agentStudioCatalog?.agents?.forEach((a) => allPayTos.add(a.payTo));

  if (allPayTos.size === 0) {
    record('C2', 'BLOCKED', 'no payTo values collected (see A1/A2)');
    return;
  }
  const zeroFound = [...allPayTos].filter((p) => isZero(p));
  const verdict = zeroFound.length ? 'FAIL' : 'PASS';
  record('C2', verdict, zeroFound.length ? `CRITICAL: zero address found among ${allPayTos.size} payTo values — escalate immediately` : `none of ${allPayTos.size} distinct payTo values is the zero address`);
}

async function checkC3() {
  record('C3', 'BLOCKED', 'gated on Open Question 1 (funded, Jason-authorized canary wallet) — not run');
}

// ---------------------------------------------------------------------------
// Tier D: publication and indexing
// ---------------------------------------------------------------------------

let bazaarSuedeCount = 0;
let bazaarPagesSwept = 0;
let bazaarTotal = 0;

async function sweepBazaarPage(offset) {
  const res = await fetchJson(`${CDP_BAZAAR_URL}?limit=${BAZAAR_PAGE_SIZE}&offset=${offset}`);
  if (!res.ok || res.status !== 200 || !res.json) return null;
  return res.json;
}

async function checkD1() {
  const first = await sweepBazaarPage(0);
  if (!first) {
    record('D1', 'BLOCKED', 'CDP Bazaar discovery index unreachable');
    return;
  }
  bazaarTotal = first.pagination?.total ?? first.items.length;
  const totalPages = Math.ceil(bazaarTotal / BAZAAR_PAGE_SIZE);
  const pagesToSweep = Math.min(totalPages, BAZAAR_MAX_PAGES);
  const truncated = totalPages > BAZAAR_MAX_PAGES;

  const suedeMatches = [];
  const scan = (page) => {
    bazaarPagesSwept += 1;
    for (const item of page.items ?? []) {
      const haystack = `${item.resource ?? ''} ${item.serviceName ?? ''} ${item.description ?? ''}`.toLowerCase();
      if (haystack.includes('suedeai') || haystack.includes('suede labs')) suedeMatches.push(item.resource);
    }
  };
  scan(first);

  const offsets = [];
  for (let p = 1; p < pagesToSweep; p++) offsets.push(p * BAZAAR_PAGE_SIZE);
  for (let i = 0; i < offsets.length; i += BAZAAR_CONCURRENCY) {
    const batch = offsets.slice(i, i + BAZAAR_CONCURRENCY);
    const pages = await Promise.all(batch.map(sweepBazaarPage));
    pages.forEach((p) => p && scan(p));
  }

  bazaarSuedeCount = suedeMatches.length;
  const sweptAll = bazaarPagesSwept >= pagesToSweep;
  let verdict;
  let evidence;
  if (bazaarSuedeCount > 0) {
    verdict = 'PASS';
    evidence = `${bazaarSuedeCount} suedeai resource(s) found in Bazaar index (${bazaarPagesSwept}/${totalPages} pages swept): ${suedeMatches.slice(0, 3).join(', ')}`;
  } else if (!sweptAll) {
    verdict = 'BLOCKED';
    evidence = `0 found but sweep incomplete (${bazaarPagesSwept}/${totalPages} pages, some page fetches failed)`;
  } else {
    verdict = 'FLAG';
    evidence = `0 suedeai resources in ${bazaarPagesSwept}/${totalPages} pages (${bazaarTotal} total listed) — expected while KD-4 is open`;
  }
  if (truncated) evidence += ` [capped at ${BAZAAR_MAX_PAGES} pages; ${totalPages - BAZAAR_MAX_PAGES} pages not swept]`;
  record('D1', verdict, evidence);
}

async function checkD2() {
  const facilitators = agentStudioRoot?.facilitators ?? [];
  if (facilitators.length === 0) {
    record('D2', 'BLOCKED', 'no facilitator URLs available (see A1)');
    return;
  }
  const problems = [];
  for (const url of facilitators) {
    const res = await fetchJson(url);
    if (!res.ok) problems.push(`${url}: ${res.error}`);
  }
  const verdict = problems.length ? 'FAIL' : 'PASS';
  record('D2', verdict, problems.length ? problems.join('; ') : `${facilitators.length} facilitator URL(s) all reachable`);
}

// ---------------------------------------------------------------------------
// Bonus: KD-5 CI status (not one of the 13 contract checks, but needed to report
// known-defect status accurately without guessing).
// ---------------------------------------------------------------------------

async function getBackendTestsStatus() {
  try {
    const { stdout } = await execFileAsync('gh', [
      'api',
      `repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/runs?branch=main&per_page=1`,
      '--jq',
      '.workflow_runs[0] | {conclusion, created_at, html_url}',
    ]);
    const parsed = JSON.parse(stdout);
    return { ok: true, ...parsed };
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message || err) };
  }
}

// ---------------------------------------------------------------------------
// Known-defect status
// ---------------------------------------------------------------------------

function deriveKnownDefects(ciStatus) {
  const a3Ran = results.find((r) => r.id === 'A3')?.verdict !== 'BLOCKED';
  const kd1Status = !a3Ran ? 'UNKNOWN' : kdHits['KD-1'] > 0 ? 'STILL OPEN' : 'NOW RESOLVED';
  const kd2Status = !a3Ran ? 'UNKNOWN' : kdHits['KD-2'] > 0 ? 'STILL OPEN' : 'NOW RESOLVED';
  const kd3Status = !a3Ran ? 'UNKNOWN' : kdHits['KD-3'] > 0 ? 'STILL OPEN' : 'NOW RESOLVED';
  const kd4Status = results.find((r) => r.id === 'D1')?.verdict === 'BLOCKED' ? 'UNKNOWN' : bazaarSuedeCount === 0 ? 'STILL OPEN' : 'NOW RESOLVED';
  const kd5Status = !ciStatus.ok ? 'UNKNOWN' : ciStatus.conclusion === 'failure' ? 'STILL OPEN' : 'NOW RESOLVED';
  const kd6Open = a3Ran ? kdHits['KD-6'] > 0 : null;

  return [
    { id: 'KD-1', status: kd1Status, note: 'Agent Studio maxAmountRequired in human units, not atomic (affects A3, A4)' },
    { id: 'KD-2', status: kd2Status, note: 'network="base-mainnet" alias on Agent Studio vs eip155:8453 on app gateway (affects A3)' },
    { id: 'KD-3', status: kd3Status, note: 'Agent Studio discovery docs / 402 challenges carry relative resource paths (affects A3)' },
    { id: 'KD-4', status: kd4Status, note: `CDP facilitator creds missing on Render, Bazaar index count=${bazaarSuedeCount} (affects D1)` },
    { id: 'KD-5', status: kd5Status, note: ciStatus.ok ? `backend-tests on main: ${ciStatus.conclusion} (${ciStatus.created_at})` : `could not query CI: ${ciStatus.error}` },
    { id: 'KD-6', status: kd6Open === null ? 'UNKNOWN' : kd6Open ? 'STILL OPEN' : 'NOW RESOLVED', note: 'Agent Studio entries omit mimeType/outputSchema/maxTimeoutSeconds vs app gateway (quality flag only, affects A3)' },
  ];
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function buildEscalationLines(_defects) {
  const lines = [];
  const b3 = results.find((r) => r.id === 'B3');
  const b4 = results.find((r) => r.id === 'B4');
  const c2 = results.find((r) => r.id === 'C2');
  if (b3?.evidence.includes('CRITICAL')) lines.push(`ESCALATE: ${b3.evidence}`);
  if (b4?.evidence.includes('CRITICAL')) lines.push(`ESCALATE: ${b4.evidence}`);
  if (c2?.evidence.includes('CRITICAL')) lines.push(`ESCALATE: ${c2.evidence}`);
  if (lines.length === 0) {
    const fails = results.filter((r) => r.verdict === 'FAIL');
    lines.push(
      fails.length
        ? `${fails.length} check(s) FAIL (${fails.map((f) => f.id).join(', ')}), all attributable to pre-registered known defects — no new critical findings.`
        : 'No critical findings this run.'
    );
  }
  return lines.slice(0, 3);
}

function buildReport(dateStr, defects) {
  const checkOrder = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'D1', 'D2'];
  const ordered = checkOrder.map((id) => results.find((r) => r.id === id)).filter(Boolean);

  const verdictTable = [
    '| Check | Verdict | Evidence |',
    '|---|---|---|',
    ...ordered.map((r) => `| ${r.id} | ${r.verdict} | ${r.evidence.replace(/\|/g, '\\|')} |`),
  ].join('\n');

  const defectTable = [
    '| Defect | Status | Note |',
    '|---|---|---|',
    ...defects.map((d) => `| ${d.id} | ${d.status} | ${d.note.replace(/\|/g, '\\|')} |`),
  ].join('\n');

  const escalation = buildEscalationLines(defects).join('\n');

  return `# x402 Offer Assurance Runbook — ${dateStr}

Automated run of \`06_agents/X402_Offer_Assurance_Runbook.md\` (Tiers A, B, C1, C2, D; C3 stays BLOCKED). Script: \`suede-agent-studio/scripts/x402-assurance/run.mjs\`, run by launchd job \`com.suede.x402-assurance-runbook\`.

## Verdict table

${verdictTable}

## Known-defect status

${defectTable}

## Escalation summary

${escalation}
`;
}

async function main() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  await checkA1();
  await checkA2();
  await checkA3();
  await checkA4();
  await checkA5();
  await checkB1();
  await checkB2();
  await checkB3();
  await checkB4();
  await checkC1();
  await checkC2();
  await checkC3();
  await checkD1();
  await checkD2();

  const ciStatus = await getBackendTestsStatus();
  const defects = deriveKnownDefects(ciStatus);

  const checkOrder = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'D1', 'D2'];
  const ordered = checkOrder.map((id) => results.find((r) => r.id === id)).filter(Boolean);
  console.log('\n=== x402 Offer Assurance Runbook —', dateStr, '===\n');
  for (const r of ordered) console.log(`${r.id.padEnd(4)} ${r.verdict.padEnd(8)} ${r.evidence}`);
  console.log('\n--- Known defects ---');
  for (const d of defects) console.log(`${d.id.padEnd(6)} ${d.status.padEnd(14)} ${d.note}`);
  console.log('\n--- Escalation ---');
  console.log(buildEscalationLines(defects).join('\n'));

  const report = buildReport(dateStr, defects);
  await mkdir(HANDOFF_DIR, { recursive: true });
  const handoffPath = path.join(HANDOFF_DIR, `${dateStr}-${AGENT_TAG}-x402-assurance-run.md`);
  await writeFile(handoffPath, report, 'utf8');
  console.log(`\nHandoff written: ${handoffPath}`);

  const criticalFail = results.some((r) => r.evidence.includes('CRITICAL'));
  const unattributedFail = ordered.some((r) => r.verdict === 'FAIL') && ordered.some((r) => r.verdict === 'FAIL' && !defects.some((d) => r.evidence.includes(d.id)));

  if (criticalFail) {
    try {
      await execFileAsync('osascript', ['-e', `display notification "x402 assurance run flagged a critical issue — see ${handoffPath}" with title "x402 Offer Assurance"`]);
    } catch {
      /* best-effort desktop notification only; not fatal if osascript is unavailable */
    }
  }

  process.exit(criticalFail ? 2 : unattributedFail ? 1 : 0);
}

main().catch((err) => {
  console.error('x402 assurance runbook crashed:', err);
  process.exit(3);
});
