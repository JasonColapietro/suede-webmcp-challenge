# Google Play — Suede Agent Studio

`ai.suede.agents` · Play Console: **Draft, not yet sent for review**

| Document | What it covers |
|---|---|
| [BLOCKERS.md](./BLOCKERS.md) | The two things stopping upload. **Read first.** |
| [data-safety.md](./data-safety.md) | Data Safety form answers, grounded in the code |
| [content-rating-and-audience.md](./content-rating-and-audience.md) | IARC questionnaire, target audience, ads, category |
| [release-runbook.md](./release-runbook.md) | How to produce and verify a signed AAB once unblocked |

Listing text and graphics live at
`ios-app/android/fastlane/metadata/android/en-US/`.

## Status

| Item | State |
|---|---|
| Android project (Capacitor shell) | Present, `ios-app/android` |
| `assembleDebug` | **Passes** (5m13s, 2026-08-08) |
| Runtime on emulator | **Verified** — installs, launches, renders the live app, no crash in logcat |
| Launcher icon | **Fixed** — was a leftover placeholder, now the Suede brand mark, matching iOS and the store icon |
| Release signing wiring | Present in `app/build.gradle`; `keystore.properties.example` added |
| Signed AAB | **BLOCKED** — no upload keystore exists for this package |
| Play Billing compliance | **BLOCKED** — card top-ups reachable in-app bypass Play Billing |
| Listing metadata | Complete — title 26/30, short 77/80, full 2615/4000 (rewritten 2026-08-10, see `aso.md`) |
| Graphics | 512×512 icon, 1024×500 feature graphic, 4 phone screenshots |
| Privacy policy URL | https://agents.suedeai.ai/privacy — verified `200` |
| Account deletion URL | https://agents.suedeai.ai/account-deletion — verified `200` |

## What is deliberately not here

- **No keystore was generated.** See BLOCKERS.md for why, and for the exact
  Play Console page that decides whether generating one is safe.
- **Nothing was uploaded or submitted.** The developer account is mid
  personal→organization conversion and no app can be submitted until it shows
  Organization.
- **No tablet screenshots.** The visual canvas only works on larger displays,
  so tablet screenshots would be the most persuasive assets this listing could
  have — but they need a tablet AVD that does not exist on this machine yet.
