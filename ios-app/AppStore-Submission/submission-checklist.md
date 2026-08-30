# Submission Checklist — Suede Agent Studio iOS

## Current record and source state

Reconciled against Apple's public App Store lookup on 2026-08-16:

- App Store app: `Suede Agent Studio`
- App Store ID: `6778880737`
- Public version: `1.0.1`
- Public App Store bundle ID: `ai.suede.factory.agents`
- Checked-in iOS project bundle ID: `ai.suede.agents`
- Apple Team ID: `W3N8SRDK4C`
- Xcode project: `ios-app/ios/App/App.xcodeproj` (Capacitor 8, SPM, no CocoaPods)
- Public listing: `https://apps.apple.com/us/app/suede-agent-studio/id6778880737`

The public bundle ID and the checked-in Xcode bundle ID do not match. Treat the
metadata in this directory as reviewed next-version copy only. Do not archive
or upload a binary from this checkout until the exact source target for
`ai.suede.factory.agents` is recovered or the App Store Connect record and code
are deliberately reconciled.

## Submission assets

- App icon source: `ios-app/assets/icon-only.png`
- Screenshots: `ios-app/AppStore-Submission/screenshots-raw/en-US/`
  - `iphone-69/` at 1320x2868
  - `ipad-13/` at 2048x2732
  - Regenerate from `ios-app/` with
    `node AppStore-Submission/capture-screenshots.mjs`
- Metadata: `ios-app/AppStore-Submission/metadata/en-US/`

## Historical evidence

- An unsigned simulator build succeeded on 2026-06-10.
- The original handoff recorded a signed `1.0` / build `1` archive, but that
  ignored build artifact is not present in this checkout and must not be
  treated as recoverable release evidence.
- The original mobile review covered `/`, `/agents`,
  `/a/the-ownership-loop-dwbjc`, `/flows`, and `/docs` at 440pt width.

All build, URL, rendering, privacy, and review assertions must be reverified for
the next submission.

## Next-release gates

1. Identify the exact source/configuration that produced
   `ai.suede.factory.agents`, then reconcile the checked-in target without
   changing the public app identity by accident.
2. Open or confirm an editable next version on App Store Connect for app
   `6778880737`.
3. Recheck every staged metadata claim against the current app and live Agent
   Studio behavior; then apply the fields from `metadata/en-US/`.
4. Reconfirm App Privacy, the age-rating questionnaire, pricing, screenshots,
   review notes, support URL, and privacy URL.
5. Build and sign with team `W3N8SRDK4C`, upload to the exact live record, and
   read back the processed build and locale metadata.
6. Submit only after the binary, screenshots, metadata, and reviewer walkthrough
   all describe the same release.

## Review-risk notes

- Guideline 4.2: the reviewer walkthrough must demonstrate meaningful mobile
  functionality beyond a passive web wrapper.
- Guideline 3.1.1: the app has no consumer in-app purchase flow; dry runs and
  third-party x402 settlement must remain clearly distinguished.
- Guideline 2.3.7: keep price references out of promotional metadata and
  screenshot captions.
