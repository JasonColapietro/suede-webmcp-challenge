# Agent Studio Stripe revenue receipts

Status: prepared, not applied. Nothing in this design creates an Airbyte login,
runs a sync, changes a Stripe endpoint, backfills production, or deploys the
application.

## Evidence and accounting boundary

The signed Stripe webhook is the only runtime evidence source. A terminal paid
Checkout Session contributes its provider `amount_total` as positive USD cents.
A terminal succeeded Refund contributes its provider `amount` as negative USD
cents. `event.created` is the exact occurrence time retained for the first
terminal event that records each economic transaction.

New Checkout Sessions also stamp the non-personal
`product=suede-agent-studio` tag on their PaymentIntent. The Stripe account is
shared: if a terminal refund has no private receipt linkage, the handler reads
only that PaymentIntent tag. Another product's refund is acknowledged without a
write; an Agent Studio or temporarily unverifiable refund remains retryable
until its payment receipt exists. The two historical payments must be bridged
before refund subscriptions are activated, so their existing private
PaymentIntent linkage takes precedence over the forward tag.

Cash and gateway credit are intentionally separate:

- `amount_total_cents` is the authoritative cash fact.
- `credit_delta_usdc` is the gateway-credit mutation. It may include the
  committed-use bonus and never changes reported cash.
- A refund reverses cash by the provider refund amount and reverses gateway
  credit proportionally. The final full refund reverses the exact remainder,
  avoiding rounding drift.
- Paid-user free-allowance eligibility follows retained payment evidence:
  partial Stripe refunds keep it, a full Stripe refund revokes it immediately,
  and ordinary gateway spend never revokes it.
- Stripe payments and refunds are the only rows exported. The x402 USDC
  settlement rail remains unrepresented, so it contributes zero to this
  adapter rather than being inferred from another ledger.

The private `airbyte_source_private.stripe_revenue_receipts` ledger stores raw
Stripe and owner identifiers behind RLS. It is append-only. The public credits
ledger receives only an internal `stripe-receipt:<uuid>` reference. The receipt
and credit row are one atomic transaction, with transaction-level advisory
serialization for a unique millisecond `source_revision_at` cursor.
Refund reversal locks the original payment credit and follows that row's
current owner, so anonymous-to-account adoption cannot leave refunded credit on
the adopted account. The refund receipt retains the parent payment's immutable
owner attribution, so payment and refund events keep one stable HMAC account
key even when credit ownership changes. A fail-fast transaction guard
serializes credit-owner updates against Stripe mutations; a racing adoption is
retried instead of committing a split balance.

Checkout creation resolves the verified signed-in owner for browser requests
instead of stamping a possibly stale anonymous cookie. There is still an
unavoidable asynchronous race between a Checkout Session opened under owner A
and its terminal webhook: adoption may move A to B before that webhook arrives.
The private append-only
`airbyte_source_private.stripe_owner_adoptions` ledger records that alias. The
adoption wrapper and receipt writer share one transaction-level advisory lock,
so payment-first is moved by adoption while adoption-first is resolved by the
delayed webhook. Chained adoption resolves to the terminal owner. Existing
receipt owners remain immutable for stable HMAC attribution; payment replay
compares their resolved owner so a valid post-adoption replay remains
idempotent. Raw aliases are private evidence and are never exported.

Alias paths are capped at 31 edges. Under the same global adoption lock, a new
edge computes the longest incoming path to its source plus the new edge plus
the target's forward path. A 32nd edge is rejected before credits, connections,
or the alias ledger can change, so one deep branch cannot make an existing
source unresolvable. The reverse lookup is indexed, and migration verification
resolves every stored source to fail closed on a preexisting cycle or oversized
path. A retry that names a different immediate target is accepted only when the
stored and requested targets resolve to the same terminal owner; the retry can
then move rows that arrived late without rewriting append-only alias evidence.

Runtime EXECUTE on the original `public.agent_studio_adopt_owner` function is
revoked so application adoption cannot bypass alias recording. Runtime callers
use only the Stripe-aware
`public.agent_studio_adopt_owner_with_connections` wrapper. Reapplying either
`connections-production-shared-runtime.sql` or
`production-shared-supabase-runtime.sql` can replace or regrant that older
adoption path; immediately reapply the unchanged, reviewed Stripe migration
before restoring card writes after either base migration.

The migration also installs an insert guard that rejects the legacy
`reason='stripe-topup'` plus raw `cs_...` credit shape. This closes the
old-handler replay gap: a rollback to the pre-receipt webhook fails with a
retryable error instead of double-crediting or reintroducing raw Stripe IDs.

The server runtime receives only EXECUTE on
`public.agent_studio_record_stripe_revenue_event`, the Stripe-aware adoption
wrapper, and the bounded aggregate
`public.agent_studio_has_paid_entitlement`; it receives no private-ledger or
source-view access. The entitlement function reads no rows across the API and
returns only a boolean. A partial credit index and the receipt ledger's unique
credit link keep that aggregate proportional to payment/refund facts rather
than a workspace's lifetime model spend. Stripe netting uses the immutable
receipt link and exact `numeric(20,8)` deltas—not the mutable public credit
reason or the workspace's changing credit balance—so reason drift or ordinary
spend cannot change paid entitlement. A full refund nets to exact zero in both
the production credit column and the private receipt ledger. `service_role`
may call all three through its JWT role claim.
The production shared-project `anon` path may call it only with the existing
server-only `x-agent-studio-secret`; the function revalidates
`agent_studio_private.request_authorized()` before touching data. PUBLIC and
`authenticated` receive no access, and an anon call without the secret fails
closed.
The existing NOLOGIN `suede_agent_studio_airbyte_reader` capability receives
only the hardened reader function and security-invoker/security-barrier view.
The separate Airbyte login remains the only expected member of that capability.

## Normalized contract

The source is `airbyte_source.normalized_revenue_events`, project
`suede-agent-studio`, cursor `source_revision_at`, and primary key `event_id`.
Its 26 columns, in order, are:

1. `event_id`
2. `occurred_at`
3. `source_revision_at`
4. `project_id`
5. `event_name`
6. `currency`
7. `gross_amount_cents`
8. `net_amount_cents`
9. `anonymous_person_key`
10. `account_key`
11. `campaign_id`
12. `ad_set_id`
13. `ad_id`
14. `creative_id`
15. `utm_source`
16. `utm_medium`
17. `utm_campaign`
18. `utm_content`
19. `click_id`
20. `external_transaction_ref`
21. `status`
22. `refund_state`
23. `subscription_state`
24. `product_id`
25. `price_id`
26. `settlement_state`

`event_id`, `account_key`, and `external_transaction_ref` are keyed HMACs using
the existing Vault secret. Present product and price identifiers are HMACed as
well. The adapter never exports an owner, payer, customer, wallet, payment
credential, Checkout Session, PaymentIntent, Refund, or raw Stripe event ID.
Payments are positive; refunds are negative. Both gross and net are the signed
provider amount because this source has no verified Stripe-fee evidence and
does not invent it.

Use adapter version `airbyte-stripe-revenue/v1` and source prefix
`agent_studio_stripe_`. The Marketing Agent OS landing table is
`airbyte_landing.agent_studio_stripe_normalized_revenue_events`. The unique
physical prefix/table deliberately avoids the shared destination's existing
Promo Stripe connection; the logical source and stream remain Stripe and
`normalized_revenue_events`.

The current Marketing WIP defines this second physical landing binding, but it
must be independently verified and deployed before the Agent Studio Airbyte
connection is enabled. Until that cross-repo change is live, keep the
connection disabled even if the source migration and receipt writer are live.

## Historical two-session bridge

`airbyte_source_private.backfill_two_verified_stripe_topups(jsonb)` is an
owner-only, ungranted migration helper. It accepts exactly two slots, each an
already-verified paid, non-refunded $5 USD Checkout Session, and requires an
envelope total of exactly 1,000 cents. It associates the matching existing
`stripe-topup` credit, appends the private receipt, and replaces the legacy raw
Checkout Session value in `public.credits.tx` with the internal receipt
reference in the same transaction.

The checked-in
`agent-studio-stripe-revenue-backfill-request.template.json` contains only
placeholders. Resolve provider and owner identifiers through protected
operator channels, bind the completed JSON as a parameter, and never paste,
print, log, screenshot, commit, or archive the populated request. A migration
operator must independently verify both Stripe objects, paid state, USD
currency, 500-cent amount, no refund, occurrence time, PaymentIntent linkage,
and the matching private credit row before invoking the helper. This invocation
is a production write and requires separate explicit approval; preparing these
files does not perform it.

## Apply and activation runbook

1. Confirm the exact production project and run the general pre-apply readback
   in `docs/migrations/PENDING.md`.
2. Verify the reviewed `public.credits` and `public.connections` shapes,
   Supabase Vault key count, existing Agent Studio Airbyte capability/login
   membership, hardened base adoption owner/search path, and zero unexpected
   grants. Never select decrypted Vault material.
3. Dry-run the unchanged migration twice in disposable PostgreSQL 17 with a
   production-shaped schema. Test payment/refund replay, a forced credit failure
   rollback, cumulative partial then full refunds, cursor monotonicity, mutation
   trigger rejection, payment-before-adoption and adoption-before-payment
   races, chained adoption, post-adoption replay, and every role boundary.
4. Apply `agent-studio-airbyte-source.sql` first if it is not already present,
   then apply `agent-studio-stripe-revenue-source.sql` with the migration-only
   identity. The base source migration normalizes reader grants; if it is ever
   reapplied later, reapply the reviewed Stripe revenue migration afterward
   before restoring the revenue sync. The connections/shared-runtime migrations
   can restore the older adoption wrapper or its grants; if either is reapplied,
   reapply the Stripe migration before restoring card writes. Applying the
   revenue migration activates the legacy-write guard, so coordinate the
   application deploy immediately afterward; the old webhook fails closed
   during that interval and Stripe retries the terminal event.
5. Under separate approval, invoke the owner-only helper once through the
   authenticated linked database query path, constructing and binding the
   populated request only in process memory. Retain only its aggregate
   two-row/1,000-cent result. Do not expose the parameter in SQL history or
   logs, and do not create a public/runtime backfill wrapper.
6. Archive only aggregate/catalog readback: exact view columns/types/options;
   function owners/config; trigger, RLS, membership, and ACL state; two payment
   rows totaling 1,000 cents; zero refund rows; and a count of remaining
   `public.credits.tx` values with a raw Checkout Session prefix. Never archive
   row-level identifiers.
7. Deploy the application only after the writer RPC exists. Then configure the
   Stripe endpoint for `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `refund.created`, and
   `refund.updated`. A missing payment receipt makes a terminal refund return a
   retryable error rather than losing the reversal.
8. Through the existing protected login procedure, configure Airbyte with the
   view, cursor, primary key, adapter version, prefix, and landing table above.
   First verify that Marketing has deployed the distinct Agent Studio physical
   landing binding; do not enable this connection against the existing Promo
   Stripe-only bridge.
   Run a bounded reset/backfill sync, then an incremental sync. Verify aggregate
   counts and sums at the source, raw landing, and final ClickHouse table before
   enabling downstream decisions.

Production readiness requires all eight gates. A checked-in migration, passing
unit test, preview, or local readback is not evidence that any live step ran.

## Readback and rollback

Safe business readback is aggregate-only:

```sql
select
  event_name,
  currency,
  status,
  refund_state,
  pg_catalog.count(*) as event_count,
  pg_catalog.sum(gross_amount_cents) as gross_amount_cents
from airbyte_source.normalized_revenue_events
group by event_name, currency, status, refund_state
order by event_name, currency, status, refund_state;
```

Catalog readback must also prove that only the Airbyte reader can SELECT the
view/call its reader, only `service_role` and protected `anon` can call the
writer, boolean entitlement aggregate, and Stripe-aware adoption wrapper; anon
calls without the request secret are rejected, the original adoption function
has no runtime grant, no runtime role can access either private ledger or the
owner-only backfill helper, and the three reader-facing references are HMAC
output.

For an emergency write stop, apply
`agent-studio-stripe-revenue-source-disable-writes.sql`. It revokes the
service-role and protected-anon writer grants while retaining all evidence and
read access, including the paid-entitlement aggregate. Stripe-aware owner
adoption and its private append-only aliases remain enabled, so identities that
move during the write stop are still routable when receipt writes resume. The
webhook will fail closed and Stripe will retry terminal events. Re-enable only
by reapplying the unchanged, reviewed Stripe revenue migration and repeating
the ACL/readback gate.

Application rollback is forward-fix-only for the Stripe webhook. Do not remove
the legacy-write guard or deploy the pre-receipt handler: the guard intentionally
makes that handler fail closed, because it cannot deduplicate the internal
receipt reference and would otherwise double-credit a replay. If application
rollback is unavoidable, first disable delivery to the endpoint, apply the
write-stop migration, retain the guard and ledger, and preserve Stripe retries
for replay into a corrected receipt-aware deployment. Do not delete or mutate
receipt rows to roll back.
