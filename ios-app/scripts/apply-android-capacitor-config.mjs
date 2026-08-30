#!/usr/bin/env node

/* global console, process */

/**
 * Point the Capacitor Android shell at the Google Play access-only host.
 *
 * iOS and Android share one `capacitor.config.json`, and `cap sync android`
 * copies it verbatim into the APK/AAB assets. Left alone, the Play binary
 * would load https://agents.suedeai.ai — the canonical host, where the Stripe
 * card top-up is live. That is the removal-level Google Play Payments
 * violation this whole change exists to close.
 *
 * Editing the shared config would drag iOS onto the restricted host and strip
 * a working feature from the App Store build, so instead this script runs
 * AFTER `cap sync android` and overwrites only the Android asset copy from
 * `capacitor.config.android.json`. Running post-sync is the point: sync
 * regenerates that file every time, so a hand-edit there would silently
 * revert.
 *
 * iOS is untouched. `capacitor.config.json` remains the iOS source of truth.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const SOURCE = path.join(root, 'capacitor.config.android.json');
const TARGET = path.join(
  root,
  'android/app/src/main/assets/capacitor.config.json',
);

if (!fs.existsSync(SOURCE)) {
  console.error(`Missing ${path.relative(root, SOURCE)}`);
  process.exit(1);
}

const source = fs.readFileSync(SOURCE, 'utf8');
let parsed;
try {
  parsed = JSON.parse(source);
} catch (error) {
  console.error(`capacitor.config.android.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

const url = parsed?.server?.url;
if (url !== 'https://android-agents.suedeai.ai') {
  console.error(
    `Android capacitor config server.url must be https://android-agents.suedeai.ai (found ${url ?? 'nothing'}).`,
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, source);

console.log(
  `Android shell pointed at ${url} (${path.relative(root, TARGET)}).`,
);
