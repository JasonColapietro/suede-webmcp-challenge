#!/usr/bin/env node

/* global console, process */

/**
 * Google Play payment-contract check. Runs as `prebuild`, so the compliance
 * shape cannot be broken by shipping.
 *
 * Mirrors Suede Social's scripts/check-mobile-payment-contract.mjs. The thing
 * being protected is narrow and specific: the Capacitor Android shell for
 * ai.suede.agents renders the live web app, and Google Play's Payments policy
 * makes an in-app non-Play checkout for in-app digital content a REMOVAL, not
 * a rejection. Four links have to hold at once, and each one is individually
 * easy to undo by accident:
 *
 *   1. the Android shell points at the access-only host;
 *   2. that host is a distinct host, never a query flag;
 *   3. middleware denies payment and commerce-discovery routes on it;
 *   4. the /flows top-up UI does not render on it.
 *
 * Break any one and the app is shippable-looking and removable.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.PLAY_CONTRACT_ROOT || process.cwd());
const failures = [];

function fail(message) {
  failures.push(message);
}

function readRequired(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`Missing required file: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function requireText(label, content, expected) {
  if (!content.includes(expected)) {
    fail(`${label} must include: ${expected}`);
  }
}

function refuseText(label, content, forbidden, why) {
  if (content.includes(forbidden)) {
    fail(`${label} must NOT include ${forbidden} — ${why}`);
  }
}

const PLAY_HOST = 'android-agents.suedeai.ai';
const PLAY_URL = `https://${PLAY_HOST}`;

// 1. The script that wires the build to the check.
const packageJson = readRequired('package.json');
requireText(
  'package.json',
  packageJson,
  '"check:play-billing": "node scripts/check-play-billing-contract.mjs"',
);
requireText('package.json', packageJson, '"prebuild": "npm run check:play-billing"');

// 2. The gate module: dedicated host, and every commerce surface enumerated.
const gate = readRequired('src/lib/google-play-access-only.ts');
requireText('Play access-only gate', gate, `GOOGLE_PLAY_ANDROID_HOST = "${PLAY_HOST}"`);
for (const expected of [
  'isGooglePlayAccessOnlyHost',
  'isGooglePlayBlockedPaymentPath',
  'isGooglePlayBlockedCommerceDiscoveryPath',
  'isGooglePlayAllowedAppPath',
  'isGooglePlayAllowedApiPath',
  'sanitizeGooglePlaySearchParams',
]) {
  requireText('Play access-only gate', gate, expected);
}

// Payment routes. /api/gateway/topup covers both the Stripe card checkout and
// the x402/USDC path to the same balance; blocking only one leaves the other.
requireText('Play access-only gate', gate, '"/api/gateway/topup"');

// Commerce discovery. Each of these is a documented way for a caller inside
// the Android binary to find a price and pay outside Play Billing.
for (const discoveryPath of [
  '"/.well-known/agent-card.json"',
  '"/.well-known/ai-plugin.json"',
  '"/.well-known/x402"',
  '"/.well-known/x402.json"',
  '"/api/catalog"',
  '"/api/cli/agents"',
  '"/api/mcp"',
  '"/llms.txt"',
  '"/openapi.json"',
]) {
  requireText('Play blocked commerce discovery list', gate, discoveryPath);
}
for (const pattern of [
  '/^\\/api\\/agents\\/[^/]+\\/\\.well-known(\\/|$)/',
  '/^\\/api\\/agents\\/[^/]+\\/(a2a|discovery|run|settlement)(\\/|$)/',
]) {
  requireText('Play per-agent commerce patterns', gate, pattern);
}

// The purchase surfaces must stay OFF the reachable-page allowlist. These are
// the routes that sell, or explain how to buy, an agent endpoint.
const allowlistBlock = gate.slice(
  gate.indexOf('const ALLOWED_APP_PATH_PREFIXES'),
  gate.indexOf('const ALLOWED_API_PATH_PREFIXES'),
);
for (const purchasePage of ['"/pricing"', '"/a"', '"/docs"', '"/x402-agent-builder"']) {
  refuseText(
    'Play reachable-page allowlist',
    allowlistBlock,
    purchasePage,
    'it is a purchase or purchase-instruction surface',
  );
}

// 3. Middleware enforcement, and the matcher that must reach llms.txt.
const middleware = readRequired('src/middleware.ts');
for (const expected of [
  'isGooglePlayAccessOnlyHost',
  'isGooglePlayBlockedPaymentPath',
  'isGooglePlayBlockedCommerceDiscoveryPath',
  'isGooglePlayAllowedApiPath',
  'isGooglePlayAllowedAppPath',
  'status: 403',
]) {
  requireText('Middleware', middleware, expected);
}
/*
 * The matcher must not exclude llms.txt. It is a static file in public/ that
 * advertises this studio's paid agent endpoints, so excluding it puts it out
 * of middleware's reach entirely — the gate cannot block what it never sees.
 * Matched on the bare token `llms` rather than the escaped `llms\\.txt`,
 * because getting that escape wrong in THIS file silently disables the guard.
 * (It did, on the first version of this script.)
 */
refuseText(
  'Middleware matcher',
  middleware.slice(middleware.indexOf('matcher:')),
  'llms',
  'excluding llms.txt from the matcher puts a commerce-discovery surface out of the Play gate\'s reach',
);

// 4. UI gating on /flows, without removing the feature from web/iOS.
const flowsLayout = readRequired('src/app/flows/layout.tsx');
requireText('Flows layout', flowsLayout, 'GooglePlayAccessOnlyProvider');
requireText('Flows layout', flowsLayout, 'isGooglePlayAccessOnlyHost');

const flowsPage = readRequired('src/app/flows/dashboard.tsx');
requireText('Flows page', flowsPage, 'useGooglePlayAccessOnly');
requireText('Flows page', flowsPage, 'if (googlePlayAccessOnly) return;');
requireText('Flows page', flowsPage, '{googlePlayAccessOnly ? (');
// The card checkout must still exist for web and iOS — this change gates a
// surface on one host, it does not delete a feature.
requireText('Flows page', flowsPage, '/api/gateway/topup/stripe');
requireText('Flows page', flowsPage, 'Add $5 by card');

// 5. The Capacitor Android shell actually points at the access-only host, and
// iOS is not dragged along with it.
const androidConfigSource = readRequired('ios-app/capacitor.config.android.json');
requireText('Android Capacitor config', androidConfigSource, `"url": "${PLAY_URL}"`);
refuseText(
  'Android Capacitor config',
  androidConfigSource,
  '"https://agents.suedeai.ai"',
  'the Android shell must not load the canonical host, where card checkout is live',
);
refuseText(
  'Android Capacitor config',
  androidConfigSource,
  '"agents.suedeai.ai"',
  'allowNavigation must not let the WebView reach the canonical host',
);

/*
 * The asset copy is a build artifact — Capacitor's own generated
 * ios-app/android/.gitignore excludes it, so it is absent on a fresh clone and
 * in CI. It is checked only when a local `cap sync android` has produced one,
 * because a STALE copy is the exact failure that would ship a binary pointed
 * at the canonical host while every committed file looks correct.
 */
const androidAssetsPath = 'ios-app/android/app/src/main/assets/capacitor.config.json';
if (fs.existsSync(path.join(root, androidAssetsPath))) {
  const androidAssetsConfig = fs.readFileSync(path.join(root, androidAssetsPath), 'utf8');
  if (androidAssetsConfig !== androidConfigSource) {
    fail(`${androidAssetsPath} is stale — run \`npm run sync:android\` in ios-app/`);
  }
}

const iosConfig = readRequired('ios-app/capacitor.config.json');
requireText('iOS Capacitor config', iosConfig, '"url": "https://agents.suedeai.ai"');

const iosAppPackageJson = readRequired('ios-app/package.json');
requireText(
  'ios-app package.json',
  iosAppPackageJson,
  'cap sync android && node ./scripts/apply-android-capacitor-config.mjs',
);

if (failures.length > 0) {
  console.error('Google Play payment contract check failed:');
  for (const message of failures) {
    console.error(`- ${message}`);
  }
  process.exit(1);
}

console.log('Google Play payment contract check passed.');
