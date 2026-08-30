/**
 * The /flows purchase surface must be gated on the Play host and untouched
 * everywhere else, and the Android shell must actually load the gated host.
 *
 * This repo has no React testing-library, so these are source-shape
 * assertions rather than renders. They cover the links the middleware tests
 * cannot see: which host the binary points at, and whether the feature was
 * gated or quietly deleted.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const flowsPage = read("src/app/flows/dashboard.tsx");
const flowsLayout = read("src/app/flows/layout.tsx");
const androidConfigSource = read("ios-app/capacitor.config.android.json");
const androidConfig = JSON.parse(androidConfigSource);
const iosConfig = JSON.parse(read("ios-app/capacitor.config.json"));

/*
 * Build artifact: Capacitor's generated ios-app/android/.gitignore excludes
 * the asset copy, so it is absent on a fresh clone and in CI. Asserted only
 * when a local `cap sync android` has produced one.
 */
const ANDROID_ASSETS = "ios-app/android/app/src/main/assets/capacitor.config.json";
const androidAssets = existsSync(join(root, ANDROID_ASSETS))
  ? read(ANDROID_ASSETS)
  : null;

describe("/flows top-up UI gating", () => {
  it("provides the access-only flag from the request host, scoped to /flows", () => {
    expect(flowsLayout).toContain("GooglePlayAccessOnlyProvider");
    expect(flowsLayout).toContain("isGooglePlayAccessOnlyHost");
    expect(flowsLayout).toContain('headers()).get("host")');
  });

  it("branches the whole top-up block on the access-only flag", () => {
    expect(flowsPage).toContain("const googlePlayAccessOnly = useGooglePlayAccessOnly();");
    expect(flowsPage).toContain("{googlePlayAccessOnly ? (");
    // Deliberate update (2026-08-09): the single hardcoded "Add $5 by card"
    // button became a TOPUP_TIERS.map over the $1/$5/$20 card tiers. The gate
    // contract is unchanged: every top-up control (one-time tiers AND commit
    // tiers) must still sit inside the false branch of the Play gate.
    const gateIndex = flowsPage.indexOf("{googlePlayAccessOnly ? (");
    expect(flowsPage.indexOf("TOPUP_TIERS.map")).toBeGreaterThan(gateIndex);
    expect(flowsPage.indexOf("Add $5 by card")).toBeGreaterThan(gateIndex);
    expect(flowsPage.indexOf("Add $${tier} by card")).toBeGreaterThan(gateIndex);
    expect(flowsPage.indexOf("COMMIT_TIERS.map")).toBeGreaterThan(gateIndex);
  });

  it("refuses to open checkout even if a control somehow renders", () => {
    expect(flowsPage).toContain("if (googlePlayAccessOnly) return;");
    expect(flowsPage).toContain("}, [googlePlayAccessOnly]);");
  });

  it("does not delete the feature for web and iOS", () => {
    // Deliberate update (2026-08-09): the top-up buttons now render from
    // TOPUP_TIERS ($1/$5/$20). The $5 tier keeps the exact historical label
    // because scripts/check-play-billing-contract.mjs pins it at prebuild.
    expect(flowsPage).toContain('fetch("/api/gateway/topup/stripe"');
    expect(flowsPage).toContain("Add $5 by card");
    expect(flowsPage).toContain("Add $${tier} by card");
    expect(flowsPage).toContain("TOPUP_TIERS");
    expect(flowsPage).toContain("COMMIT_TIERS");
  });
});

describe("Capacitor shells", () => {
  it("points the Android shell at the access-only host", () => {
    expect(androidConfig.appId).toBe("ai.suede.agents");
    expect(androidConfig.server.url).toBe("https://android-agents.suedeai.ai");
  });

  it("does not let the Android WebView navigate to the canonical host", () => {
    expect(androidConfig.server.allowNavigation).toEqual(["android-agents.suedeai.ai"]);
    expect(androidConfigSource).not.toContain('"agents.suedeai.ai"');
  });

  it.runIf(androidAssets !== null)(
    "keeps a locally synced Android asset copy in step with the committed source",
    () => {
      expect(androidAssets).toBe(androidConfigSource);
    },
  );

  it("leaves iOS on the canonical host", () => {
    expect(iosConfig.server.url).toBe("https://agents.suedeai.ai");
  });
});
