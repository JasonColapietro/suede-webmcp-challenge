# Content rating, target audience, ads — Suede Agent Studio (`ai.suede.agents`)

Draft answers for the Play Console questionnaires. Answer in the console; this
file is the reasoning so the answers stay consistent across resubmissions.

---

## Content rating questionnaire (IARC)

**Category: Utility, Productivity, Communication, or Other.**

| Question | Answer | Why |
|---|---|---|
| Violence, sexuality, profanity, controlled substances | **No** to all | The app is an agent directory and control room. No such content is authored or presented by the app. |
| Does the app allow users to interact or exchange content? | **Yes** | Users publish agents into a public directory that other users and other software can call. |
| Can users share their current location with other users? | **No** | No location permission, no location feature. |
| Does the app allow users to purchase digital goods? | **Yes** | Gateway credit top-ups. See `BLOCKERS.md` — this must route through Play Billing or be removed from the Android build before submission. |
| Does the app contain or share personal information with third parties? | **Yes** | See `data-safety.md`. |
| Is the app a social/dating app? | **No** | |
| Does the app feature user-generated content that is publicly visible? | **Yes** | Directory listings, agent names and descriptions. |
| Is there a moderation mechanism? | **Yes** | `src/app/moderation/` exists. Describe it accurately in the free-text field. |

**Expected outcome:** ESRB *Everyone* / PEGI *3* / USK *0* with a
"Users Interact" and "In-App Purchases" interactive-elements label. Confirm
against the console's own result — do not publish this as a claim.

### Digital purchases disclosure

Because users can purchase digital goods, the store listing will carry the
**In-app purchases** badge and the price range must be declared. Current tiers
from `src/lib/gateway/topup-handler.ts` + `COMMIT_TIERS`: **$5.00 – $250.00 per
item**. This is only correct if Play Billing is integrated; if the surface is
removed from the Android build instead, answer **No** to digital purchases and
drop the badge.

---

## Target audience and content

| Field | Answer |
|---|---|
| Target age groups | **18 and over** only |
| Does the app appeal to children? | **No** |
| Store presence for children | Not applicable |

**Why 18+.** The app's core loop involves setting prices, spending prepaid
credit, receiving USDC payouts to a crypto wallet, and operating a business.
None of that is appropriate to a minor audience, and selecting any under-18
bracket would pull the app into the Families policy, Families ads requirements,
and a stricter Data Safety review that the wallet-address and public-blockchain
disclosures would not survive.

Consequence: the app must not use imagery, characters, or copy that would
appeal to children. The current listing assets are plain editorial typography
and product screenshots, so this holds.

---

## Ads declaration

| Field | Answer |
|---|---|
| Does your app contain ads? | **No** |

No ad SDK is present. `ios-app/android/app/build.gradle` declares only
AndroidX, Capacitor, and the splash-screen plugin. The web app served in the
WebView carries no advertising network — PostHog is product analytics, not ads,
and is declared under Analytics in `data-safety.md`.

The public agent **directory** lists third-party creators' agents. This is
marketplace content, not advertising, and does not require an ads declaration.

---

## Government apps / financial features

| Field | Answer |
|---|---|
| Is this a government app? | **No** |
| Does the app provide financial features (banking, lending, crypto exchange, wallets)? | **Needs a decision — see below** |

Play's **Financial features** declaration covers crypto exchanges and software
wallets. Agent Studio does not custody funds, does not exchange currencies, and
does not provide a wallet — it records a payout wallet address the user
supplies, and settlement happens on Base between caller and creator. That most
likely places it outside the declaration.

This is a judgement call with a real rejection cost if answered wrong. Confirm
against the current Play "Financial features" policy text at submission time
rather than relying on this note; the policy has changed repeatedly.

---

## App category and contact details

| Field | Value |
|---|---|
| App category | **Productivity** (secondary framing: Business) |
| Email | support@suedeai.ai |
| Website | https://agents.suedeai.ai |
| Privacy policy | https://agents.suedeai.ai/privacy |

`Productivity` over `Business`, corrected 2026-08-10 against live Play genre
data (see `aso.md`). The previous justification asserted that the peer set sits
in Business; it does not. 7 of the top 10 results for `ai agents` and 6 of the
top 10 for `ai agent builder` are listed under Productivity, and every app in
the space above 100K installs is Productivity. Business holds only the smallest
apps in the category (AgentBoard, 100 installs; Voice Agent Builder, 10). The
listing also no longer leads on hiring agents by the call — see `aso.md` for
why that framing was retired.
