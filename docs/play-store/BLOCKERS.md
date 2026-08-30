# Suede Agent Studio — Google Play blockers

`ai.suede.agents` · Play Console status: **Draft, not yet sent for review** (created 2026-07-20)

Two blockers stop this app from being uploadable. Neither can be fixed inside
this repo. Everything else in `docs/play-store/` and
`ios-app/android/fastlane/metadata/` is ready and waiting on them.

---

## Blocker 1 — no upload keystore exists for `ai.suede.agents`

`ios-app/android/app/build.gradle` already reads release signing from a
git-ignored `keystore.properties` (see `keystore.properties.example`). The
wiring is correct. **The key it points at does not exist.**

A full filesystem sweep of this machine found 13 keystores. Every one is
accounted for, and none belongs to this package:

| Keystore | App |
|---|---|
| `~/.android/suede-studio-fretpulse-upload.jks` | fretpulse |
| `~/Documents/android-upload-keystores/fretpulse-upload.jks` | fretpulse (backup) |
| `~/.android/voice-print-upload.jks` | suede-voice |
| `~/.android/suede-keystores/suede-sing-upload.jks` | suede-voice |
| `~/.android/suede-keystores/suede-social-upload.jks` | Suede Social |
| `~/Documents/android-upload-keystores/suede-social-upload.jks` | Suede Social (backup) |
| `~/code/Suede-AI-App.worktrees/android-social/…/suede-social-upload.jks` | Suede Social |
| `~/.suede-secrets/suede-social-android/suede-social-release.keystore` | Suede Social |
| `~/Library/Application Support/Suede/Google Play/xyz.suedeai.app-upload-20260720.jks` | Suede Music (`xyz.suedeai.app`) |
| `~/Documents/suede-inspiration-twa-work/suede-music-upload-key-20260723.keystore` | Suede Music |
| `~/Documents/suede-inspiration-twa-work/android.keystore` | inspiration TWA |
| `~/Documents/storybeamkids-android-twa/android.keystore` | storybeamkids TWA |
| `~/.android/debug.keystore` | Android debug (not usable for release) |

No `keystore.properties` exists in any `suede-agent-studio` checkout or
worktree, and no Keychain entry matches (`Suede Google Play Reviewer - Agent
Studio` is a **reviewer login**, not a signing password).

### Why no key was generated here

Generating one is only safe if Play App Signing has **not** yet locked an
upload certificate for this package. If it has, an AAB signed with a fresh key
is rejected at upload. A sibling lane already made this exact mistake on
`ai.suedeai.suedevoice`, and the artifacts from the same failure on Suede Music
are still on disk, named for what they are:
`~/Documents/suede-inspiration-twa-work/RELEASE-ARTIFACTS/DO-NOT-UPLOAD-wrongkey-*.aab`.

### What has to happen first (Jason, Play Console — read-only check)

Open **Play Console → Suede Agent Studio → Test and release → Setup → App
signing** and read which case applies:

- **"App signing key certificate" is shown** → an upload key is already
  enrolled. The matching `.jks` is lost. Do **not** generate a new one; use
  **Request upload key reset**, then install the replacement and fill in
  `keystore.properties`.
- **The page offers to let Google generate a key on first upload / no
  certificate shown** → nothing is locked. Generate an upload key, back it up
  to `~/Documents/android-upload-keystores/` per that directory's README, and
  record the password in Keychain.

`versionCode` was bumped to `2` on 2026-07-19 (commit `2e2a11f`), and a
`versionCode 3` debug build was installed on the emulator on 2026-07-20 — so a
release-signed artifact may or may not have ever been produced. The console
page above is the only authoritative answer.

---

## Blocker 2 — in-app purchases bypass Google Play Billing — **FIXED (Option 2)**

> **Status update.** Closed in the branch `play/google-play-access-only-host`
> by Option 2 below, implemented as a dedicated access-only host rather than
> the User-Agent / Capacitor-bridge detection originally sketched. See
> "How it was fixed" at the end of this section. The original finding is kept
> verbatim because it is the runtime evidence for why the change exists.
>
> **The app is now shippable, not monetized.** There is still no Play Billing
> integration, so the Android build cannot sell anything at all. That is a
> separate product decision, not a follow-up chore.

**This was a policy violation as the app shipped before that change, and it is
independent of the signing problem.**

The Android app is a Capacitor shell whose `server.url` is
`https://agents.suedeai.ai` (`ios-app/capacitor.config.json`) — it renders the
entire live web app, not a trimmed mobile subset. Every purchase surface on the
website is therefore a purchase surface inside the Android app.

### Verified at runtime, not inferred

Debug build installed on emulator `suede_test` (Android 35), WebView driven to
`/flows` over the Chrome DevTools Protocol. `document.querySelectorAll` inside
the app's own WebView returned these live controls:

```
Add $5 by card
Buy $50  → $54.55 credit
Buy $100 → $109.09 credit
Buy $250 → $272.73 credit
```

Screenshot evidence: the card headed **SPEND BALANCE — $0.00 · "Prepaid credit
for running the LLM gateway"** with all four buttons rendered, reached with no
sign-in.

The handler is `payByCard` in `src/app/flows/page.tsx:185-209`: it POSTs to
`/api/gateway/topup/stripe` and then does
`window.location.href = <Stripe Checkout URL>`.

### Why this violates policy

The credits purchased are **digital content consumed inside the app** (LLM
gateway runs). Google Play's Payments policy requires Play Billing for that,
and specifically prohibits leading users out of the app to an alternative
purchase flow. Because `allowNavigation` lists only `agents.suedeai.ai`,
Capacitor will punt `checkout.stripe.com` to an external browser — which is the
prohibited pattern, not a workaround for it.

The x402/USDC per-call rail is a different question: paying *to call* a
third-party endpoint is closer to a payment-service / peer transaction than to
in-app digital content, and topping up a spend balance that funds in-app runs is
not. Do not assume either way — this needs a policy call before submission.

### Options (product decision, not an engineering fix)

1. **Integrate Google Play Billing** for gateway credit on Android, and route
   `payByCard` through it when running inside the Capacitor shell. Correct and
   compliant; the largest amount of work.
2. **Hide the top-up and purchase surfaces when running inside the Android
   app**, and keep the app read-and-run only (directory, dry-runs, run history,
   docs). Detect via the Capacitor bridge / a custom User-Agent. Smallest change
   that clears the violation.
3. **Do not ship the Capacitor shell to Play.** Ship a TWA/PWA or nothing, and
   keep purchases on the web.

Option 2 is the fastest route to an uploadable build and does not require
removing anything from the web product.

### How it was fixed

Option 2, but the activation mechanism is a **dedicated host**, not User-Agent
or Capacitor-bridge detection.

The Android shell now loads `https://android-agents.suedeai.ai`. It is the same
deployment as `agents.suedeai.ai` — the difference is enforced in middleware
against the request `Host`. Host identity is the *only* thing that turns the
mode on: `sanitizeGooglePlaySearchParams` actively strips the legacy
`play_mode` query flag so no parameter, cookie, or header can enable the
restricted runtime on the canonical host, or leak the canonical host's commerce
into the Play build.

Why not the UA/bridge detection this doc originally suggested: a User-Agent is
client-supplied and cannot be a server-side authorization boundary, so
`/api/gateway/topup/stripe` would have stayed callable from inside the binary
by anything that did not send the custom UA. A host boundary is checked before
any route runs and covers server routes and pages identically.

What the Play host denies, all with `403` and `X-Robots-Tag: noindex, nofollow`:

- **Payment routes** — `/api/gateway/topup` and everything beneath it. That
  covers the Stripe card checkout *and* the x402/USDC path to the same spend
  balance. The policy question this doc raised about the x402 rail is
  deliberately resolved in the conservative direction: topping up a balance
  that funds in-app runs is in-app digital content either way, so both paths
  are blocked rather than only the card one. Per-call x402 pricing of a
  *published* agent endpoint is a different thing and is unaffected on the web.
- **Commerce discovery** — `/.well-known/x402`, `/.well-known/x402.json`,
  `/.well-known/agent-card.json`, `/.well-known/ai-plugin.json`, `/api/catalog`,
  `/api/mcp`, `/api/cli/agents`, `/llms.txt`, `/openapi.json`, `/sitemap.xml`,
  and the per-agent `/api/agents/<slug>/{.well-known/*,run,a2a,discovery,settlement}`.
  Discovery matters as much as checkout: a machine-readable price quote served
  inside the binary is a documented route to paying outside Play Billing.
- **Everything not explicitly allowed.** Pages and API routes are both
  deny-by-default, so `/pricing`, `/a/<slug>`, `/docs/payments`,
  `/x402-agent-builder`, and `/ai-agent-marketplace-payments` are unreachable
  without a second list to keep in sync — and a commerce route added next month
  is unreachable from the Play build until someone allowlists it on purpose.

`/privacy` and `/account-deletion` stay reachable, as the Play listing requires.

Nothing was removed from the web or iOS product. The `/flows` top-up controls
render exactly as before on `agents.suedeai.ai`; they are hidden only on the
Play host, and `ios-app/capacitor.config.json` still points iOS at
`agents.suedeai.ai`.

`npm run prebuild` runs `scripts/check-play-billing-contract.mjs`, which fails
the build if any link in that chain is broken — including if the Android
Capacitor config drifts back to the canonical host.

**Before upload:** `android-agents.suedeai.ai` must exist in DNS and be pointed
at the same Vercel deployment as `agents.suedeai.ai`. Until it resolves, the
Android build has no server to load.

---

## Related finding — the canvas does not work on a phone

Not a blocker; a listing-accuracy and review-quality item.

Navigating the in-app WebView to `/build` on a 1080×2400 phone renders:

> **The studio wants a bigger canvas.** Widen this window or open it on a larger
> display to wire nodes. Guided mode can build the agent for you here, and the
> directory stays ready for browsing and running live agents.

The visual node canvas — the product's headline feature — is unavailable on
phone form factors. Play reviewers test on phones. The listing copy in
`ios-app/android/fastlane/metadata/android/en-US/full_description.txt` was
written around this: it leads with the directory and templates (which do work on
a phone), and states the canvas requirement plainly rather than claiming
drag-and-drop building on mobile. No feature claim was removed — the behaviour
was verified by running the app, and described accurately.

Consider marking the app as supporting tablets prominently, or adding
tablet/10-inch screenshots showing the real canvas.
