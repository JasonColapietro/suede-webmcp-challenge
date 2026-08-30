# Data Safety declaration — Suede Agent Studio (`ai.suede.agents`)

Draft answers for the Play Console **Data safety** form. Grounded in the code
and in the live privacy policy, not in intent.

Sources:
- `src/lib/posthog.ts`, `src/components/PostHogProvider.tsx` (analytics config)
- `src/lib/auth.ts` (`agx_owner` cookie, Supabase ecosystem session)
- `src/lib/db/supabase-repo.ts` (flows, agents, runs)
- `src/lib/gateway/stripe-topup.ts`, `src/app/api/gateway/topup/stripe/` (payments)
- `ios-app/android/app/src/main/AndroidManifest.xml` (permissions)
- https://agents.suedeai.ai/privacy (HTTP 200, verified 2026-08-08; last updated 2026-07-20)

**Scope note.** The Android app is a Capacitor shell around the live web app at
`agents.suedeai.ai`. It declares only `android.permission.INTERNET` — no
camera, microphone, location, contacts, or storage. Every item below is
collected by the *website* rendered inside the WebView, which is what the form
must describe.

---

## Does your app collect or share any of the required user data types?

**Yes.**

## Data types

| Category | Type | Collected | Shared | Processed ephemerally | Required / optional | Purpose |
|---|---|---|---|---|---|---|
| Personal info | User IDs | Yes | No | No | Required | App functionality, Analytics |
| Personal info | Email address | Yes (only if the user signs in with a Suede ecosystem account) | No | No | Optional | App functionality, Account management |
| Financial info | Purchase history | Yes (only if the user buys gateway credit) | No | No | Optional | App functionality |
| Financial info | Other financial info — wallet addresses | Yes (only if the user launches or calls a paid agent) | Yes — public blockchain | No | Optional | App functionality |
| App activity | App interactions | Yes | No | No | Required | Analytics, App functionality |
| App activity | Other user-generated content — agent prompts, flow inputs and outputs | Yes | Yes — third-party LLM providers | No | Required | App functionality |

### Notes per row

- **User IDs.** The `agx_owner` first-party cookie is a random UUID with no
  personal information, HttpOnly, SameSite=Lax, up to one year
  (`src/lib/auth.ts`). If the user signs in, the id becomes `sb:<Supabase auth
  user id>` — the same identity as Suede Social and Suede Muse.
- **Email address.** Only present via the optional shared Suede ecosystem
  account. Anonymous use is the default and requires no account.
- **Wallet addresses.** Declared as **shared** because x402/USDC settlement
  happens on Base, a public blockchain. Addresses and amounts are visible
  on-chain by the design of the network. The live policy states this explicitly.
- **Agent prompts / flow inputs and outputs.** Declared as **shared** because
  flows may call third-party LLM providers to produce output. The policy states
  inputs are not used to train models.
- **App interactions.** PostHog. Verified configuration in `src/lib/posthog.ts`:
  `disable_session_recording: true`, `capture_pageview: false` (pageviews fired
  manually per route), `disable_capture_url_hashes: true`. The policy states
  analytics respects Do Not Track and that session replays are not recorded.

### Data types explicitly NOT collected

Location, health and fitness, messages, photos and videos, audio files, files
and docs, calendar, contacts, device or other IDs, approximate/precise location,
name, phone number, race/ethnicity, political or religious beliefs, sexual
orientation. The app requests no runtime permissions at all.

---

## Security practices

| Question | Answer | Basis |
|---|---|---|
| Is all user data encrypted in transit? | **Yes** | `cleartext: false` in `ios-app/capacitor.config.json`; site is HTTPS-only |
| Can users request that data be deleted? | **Yes** | https://agents.suedeai.ai/account-deletion (HTTP 200, verified 2026-08-08) |
| Has your app been independently validated against a global security standard? | **No** | No such audit has been performed |
| Do you follow the Families policy? | **No** | Not a Families app; target audience 18+ |

---

## Gaps to close before submitting

1. **The privacy policy does not mention Stripe.** It lists "Payment
   settlement: USDC on Base" under third parties, but the site charges cards
   through Stripe Checkout (`src/lib/gateway/stripe-topup.ts`) and this form
   declares Purchase history. Google cross-checks the Data Safety form against
   the linked policy. **Add Stripe to the third-parties section of
   `src/app/privacy/page.tsx`** before submission.
2. **Data retention for deleted accounts is unstated.** The account-deletion
   page exists, but neither it nor the policy states how long Supabase backups
   retain deleted rows. Needed for an accurate answer if Google asks.
3. **Purchase history only applies if Blocker 2 is resolved via Play Billing.**
   If the top-up surface is instead hidden inside the Android app (option 2 in
   `BLOCKERS.md`), drop the Financial info → Purchase history row, because the
   Android app would then collect none.

## Privacy policy URL for the listing

```
https://agents.suedeai.ai/privacy
```

Verified `200` on 2026-08-08. Prefer this over `https://suedeai.ai/privacy`
(also `200`): the agents-specific page names PostHog, Supabase, Vercel, wallet
addresses, and the deletion path, and therefore actually corroborates the
declarations above. The apex policy does not describe this app.
