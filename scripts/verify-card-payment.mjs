/**
 * End-to-end verification of the CARD payment rail — the non-x402 way money
 * enters Suede Agent Studio.
 *
 *   Stripe Checkout -> signed webhook -> gateway credit ledger -> spend
 *
 * Unlike tests/gateway/stripe-topup.test.ts (which calls the handler directly),
 * this drives the real HTTP routes on a real Next server it boots itself, on a
 * throwaway SQLite database. Webhook payloads are signed with the app's own
 * Stripe SDK against the server's STRIPE_WEBHOOK_SECRET, so signature
 * verification runs for real — it is local HMAC, no network.
 *
 *   npm run verify:card-payment
 *
 * Checkout-session creation is the one step that needs Stripe's API. Export a
 * TEST-mode key to cover it:
 *
 *   STRIPE_SECRET_KEY=sk_test_... npm run verify:card-payment
 *
 * Without one, the run still passes but reports that step as NOT COVERED
 * rather than pretending otherwise. A live key (sk_live_) is refused outright:
 * this script must never touch a real-money Stripe session.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const Stripe = require("stripe");

const WEBHOOK_SECRET = "whsec_verify_card_payment_local";
const DUMMY_SECRET_KEY = "sk_test_verify_card_payment_dummy_key";
const SERVER_BOOT_TIMEOUT_MS = 120_000;

/** commitGrantUsdc(250) — 250 * (1 + GATEWAY_MARGIN) / (1 + COMMIT_GATEWAY_MARGIN). */
const COMMIT_GRANT_250 = 272.727273;
const stripeFixtureId = (prefix) => `${prefix}${randomUUID().replaceAll("-", "")}`;

// ---------------------------------------------------------------------------
// Stripe key selection
// ---------------------------------------------------------------------------

/**
 * Picks the Stripe secret key for the run. A live key is a hard stop — a real
 * Checkout Session is a real payment surface, and no verification script has
 * any business creating one.
 */
function resolveStripeKey() {
  const supplied = process.env.STRIPE_SECRET_KEY?.trim();
  if (!supplied) return { key: DUMMY_SECRET_KEY, real: false };
  if (supplied.startsWith("sk_live_")) {
    console.error(
      "Refusing to run against a LIVE Stripe key. Use a test key (sk_test_...) or unset STRIPE_SECRET_KEY.",
    );
    process.exit(2);
  }
  return { key: supplied, real: supplied !== DUMMY_SECRET_KEY };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const failures = [];
const notCovered = [];

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  fail += 1;
  failures.push(name);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name, why) {
  notCovered.push(name);
  console.log(`  SKIP  ${name} — ${why}`);
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, child) {
  const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForWebhookRoute(base, child) {
  const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(
        `${base}/api/gateway/topup/stripe/webhook`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      if (res.status === 400) return true;
    } catch {
      // Route may still be compiling.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function makeClient(base) {
  async function request(path, init) {
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON body — callers fall back to text
    }
    return { status: res.status, json, text };
  }

  return {
    get: (path, headers) => request(path, { headers: headers ?? {} }),
    post: (path, { body, headers } = {}) =>
      request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(headers ?? {}) },
        body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
      }),
  };
}

/** A Stripe checkout.session.completed payload shaped like the real thing. */
function checkoutEvent({ sessionId, ownerId, amountCents, grantUsdc, type = "checkout.session.completed" }) {
  const metadata = { product: "suede-agent-studio" };
  if (ownerId) metadata.ownerId = ownerId;
  if (grantUsdc !== undefined) metadata.grantUsdc = String(grantUsdc);
  return JSON.stringify({
    id: stripeFixtureId("evt_"),
    object: "event",
    created: Math.floor(Date.now() / 1_000),
    type,
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        amount_total: amountCents,
        currency: "usd",
        payment_intent: stripeFixtureId("pi_"),
        payment_status: "paid",
        status: "complete",
        metadata,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// The verification itself
// ---------------------------------------------------------------------------

async function verify({ client, stripe, realStripeKey }) {
  const owner = randomUUID();
  const fundedLater = randomUUID();

  const sendWebhook = (payload, signature) =>
    client.post("/api/gateway/topup/stripe/webhook", {
      body: payload,
      headers: {
        "stripe-signature":
          signature ?? stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
      },
    });

  const balanceOf = async (ownerId) => {
    const res = await client.get("/api/me", { cookie: `agx_owner=${ownerId}` });
    return { status: res.status, balance: res.json?.gateway?.creditBalanceUsdc ?? null };
  };

  // -------------------------------------------------------------------------
  section("1. Checkout session: identity + tier validation");
  // -------------------------------------------------------------------------
  // No bearer: browser checkout uses the verified owner resolver. A signed-in
  // user wins over a stale anonymous cookie; an anonymous browser retains the
  // middleware-minted workspace used by the /flows "Pay by card" button.
  const noAuth = await client.post("/api/gateway/topup/stripe", { body: { tier: 5 } });
  check("no-bearer request uses verified browser ownership, not 401", noAuth.status !== 401, `got ${noAuth.status}`);

  const noAuthBadTier = await client.post("/api/gateway/topup/stripe", { body: { tier: 3 } });
  check("no-bearer request is still tier-validated", noAuthBadTier.status === 400, `got ${noAuthBadTier.status}`);

  const malformedBearer = await client.post("/api/gateway/topup/stripe", {
    body: { tier: 5 },
    headers: { authorization: "Basic not-a-workspace-key" },
  });
  check("malformed Authorization is rejected 401", malformedBearer.status === 401, `got ${malformedBearer.status}`);

  const forgedSignedInBearer = await client.post("/api/gateway/topup/stripe", {
    body: { tier: 5 },
    headers: { authorization: "Bearer sb:public-user-id" },
  });
  check("public signed-in owner ids are rejected as bearer tokens", forgedSignedInBearer.status === 401, `got ${forgedSignedInBearer.status}`);

  const badTier = await client.post("/api/gateway/topup/stripe", {
    body: { tier: 3 },
    headers: { authorization: `Bearer ${owner}` },
  });
  check("unsupported tier rejected 400", badTier.status === 400, `got ${badTier.status}`);
  check(
    "the 400 names every supported tier",
    typeof badTier.json?.error === "string" && badTier.json.error.includes("1, 5, 20, 50, 100, 250"),
    badTier.json?.error,
  );

  const session = await client.post("/api/gateway/topup/stripe", {
    body: { tier: 5 },
    headers: { authorization: `Bearer ${owner}` },
  });
  if (realStripeKey) {
    check("valid tier creates a Stripe Checkout Session", session.status === 200, `got ${session.status} ${session.text.slice(0, 200)}`);
    check(
      "the session returns a hosted checkout URL",
      typeof session.json?.url === "string" && session.json.url.startsWith("https://"),
      session.json?.url ?? session.text.slice(0, 200),
    );

    // Close the loop between the two halves. Every webhook assertion below
    // trusts that a real Checkout Session carries metadata.ownerId — without
    // it a completed payment credits nobody. Read the session back from
    // Stripe and prove the stamp is really there, rather than only proving
    // that a hand-built payload containing it would be honored.
    const recent = await stripe.checkout.sessions.list({ limit: 20 });
    const created = recent.data.find((s) => s.metadata?.ownerId === owner);
    check("Stripe returns the session stamped with this workspace's ownerId", created !== undefined, "no session carried the owner id");
    if (created) {
      check("it charges the requested tier ($5 in cents)", created.amount_total === 500, `amount_total ${created.amount_total}`);
      check("it is denominated in USD", created.currency === "usd", `currency ${created.currency}`);
      check(
        "it is tagged as a Suede charge, separable from other products in the same account",
        created.metadata?.product === "suede-agent-studio",
        `product ${created.metadata?.product}`,
      );
      const paymentIntentId = typeof created.payment_intent === "string"
        ? created.payment_intent
        : created.payment_intent?.id;
      if (paymentIntentId) {
        const paymentIntent = await stripe.paymentIntents.retrieve(
          paymentIntentId,
        );
        check(
          "its PaymentIntent carries the refund-classification product tag",
          paymentIntent.metadata?.product === "suede-agent-studio",
          `product ${paymentIntent.metadata?.product}`,
        );
      }
      check("it awaits payment rather than arriving pre-paid", created.payment_status === "unpaid", `payment_status ${created.payment_status}`);
    }
  } else {
    check(
      "valid tier reaches Stripe but keeps the placeholder-key failure opaque",
      session.status === 500
        && session.json?.error === "Stripe session creation failed",
      `status ${session.status}: ${session.json?.error ?? session.text.slice(0, 200)}`,
    );
    skip("Checkout Session creation against Stripe", "no test key — set STRIPE_SECRET_KEY=sk_test_...");
  }

  // -------------------------------------------------------------------------
  section("2. Webhook signature verification");
  // -------------------------------------------------------------------------
  const sessionId = stripeFixtureId("cs_test_");
  const payload = checkoutEvent({ sessionId, ownerId: owner, amountCents: 500 });

  const unsigned = await client.post("/api/gateway/topup/stripe/webhook", { body: payload });
  check("missing stripe-signature rejected 400", unsigned.status === 400, `got ${unsigned.status}`);

  const forged = await sendWebhook(payload, "t=1,v1=deadbeef");
  check("forged signature rejected 400", forged.status === 400, `got ${forged.status}`);

  const tampered = await sendWebhook(
    checkoutEvent({ sessionId, ownerId: owner, amountCents: 99_999_900 }),
    stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
  );
  check("body swapped after signing rejected 400", tampered.status === 400, `got ${tampered.status}`);

  // -------------------------------------------------------------------------
  section("3. Money lands in the ledger");
  // -------------------------------------------------------------------------
  const before = await balanceOf(owner);
  check("fresh workspace starts at zero credit", before.status === 200 && before.balance === 0, `status ${before.status} balance ${before.balance}`);

  const credited = await sendWebhook(payload);
  check("signed checkout.session.completed accepted", credited.status === 200, `got ${credited.status} ${credited.text.slice(0, 200)}`);
  check("credits exactly the amount paid ($5)", credited.json?.creditedUsdc === 5, JSON.stringify(credited.json));

  const after = await balanceOf(owner);
  check("the balance is visible on /api/me", after.balance === 5, `balance ${after.balance}`);

  // -------------------------------------------------------------------------
  section("4. Idempotency — Stripe retries are routine, not an edge case");
  // -------------------------------------------------------------------------
  const replay = await sendWebhook(payload);
  check("replayed delivery acknowledged 200", replay.status === 200, `got ${replay.status}`);
  check("replay does not credit twice", replay.json?.creditedUsdc === undefined, JSON.stringify(replay.json));
  check("balance unchanged after replay", (await balanceOf(owner)).balance === 5, "balance moved on replay");

  const otherType = await sendWebhook(
    checkoutEvent({ sessionId: stripeFixtureId("cs_test_"), ownerId: owner, amountCents: 500, type: "payment_intent.succeeded" }),
  );
  check("unrelated event type acknowledged, not credited", otherType.status === 200, `got ${otherType.status}`);

  const foreign = await sendWebhook(
    checkoutEvent({ sessionId: stripeFixtureId("cs_test_"), ownerId: undefined, amountCents: 500 }),
  );
  check("our paid checkout with no ownerId fails closed", foreign.status === 422, `got ${foreign.status}`);
  check("neither touched the balance", (await balanceOf(owner)).balance === 5, "balance moved on an ignored event");

  // -------------------------------------------------------------------------
  section("5. Committed-tier bonus grant, and its clamp");
  // -------------------------------------------------------------------------
  const commit = await sendWebhook(
    checkoutEvent({
      sessionId: stripeFixtureId("cs_test_"),
      ownerId: owner,
      amountCents: 25_000,
      grantUsdc: COMMIT_GRANT_250,
    }),
  );
  check("commit tier credits the bonus grant", commit.json?.creditedUsdc === COMMIT_GRANT_250, JSON.stringify(commit.json));

  const inflated = await sendWebhook(
    checkoutEvent({ sessionId: stripeFixtureId("cs_test_"), ownerId: owner, amountCents: 100, grantUsdc: 1_000_000 }),
  );
  check(
    "an inflated grantUsdc cannot mint credit above the paid amount's ceiling",
    typeof inflated.json?.creditedUsdc === "number" && inflated.json.creditedUsdc <= 1.1,
    JSON.stringify(inflated.json),
  );

  // -------------------------------------------------------------------------
  section("6. Spend — does card credit actually unlock the gateway?");
  // -------------------------------------------------------------------------
  const runBody = { nodeType: "http", config: { url: "https://example.com", method: "GET" } };

  const gated = await client.post("/api/gateway/run", {
    body: runBody,
    headers: { authorization: `Bearer ${fundedLater}` },
  });
  check("an unpaid workspace is payment-gated 402", gated.status === 402, `got ${gated.status} ${gated.text.slice(0, 200)}`);

  const funding = await sendWebhook(
    checkoutEvent({ sessionId: stripeFixtureId("cs_test_"), ownerId: fundedLater, amountCents: 100 }),
  );
  check("that workspace is funded by card", funding.json?.creditedUsdc === 1, JSON.stringify(funding.json));

  const ungated = await client.post("/api/gateway/run", {
    body: runBody,
    headers: { authorization: `Bearer ${fundedLater}` },
  });
  check("the same call now runs", ungated.status === 200, `got ${ungated.status} ${ungated.text.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const { key, real } = resolveStripeKey();
  const stripe = new Stripe(key);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dbDir = mkdtempSync(join(tmpdir(), "verify-card-payment-"));

  console.log("Card payment rail — end-to-end verification");
  console.log(`  server   ${base}`);
  console.log(`  database ${join(dbDir, "studio.db")} (throwaway)`);
  console.log(`  stripe   ${real ? "test key supplied — checkout creation covered" : "placeholder key — checkout creation NOT covered"}`);

  const child = spawn("npx", ["next", "dev", "-p", String(port)], {
    env: {
      ...process.env,
      SQLITE_PATH: join(dbDir, "studio.db"),
      STRIPE_SECRET_KEY: key,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NEXT_PUBLIC_SITE_URL: base,
      // Keep the rail under test isolated: no x402 settlement, ever.
      X402_SKIP_SETTLEMENT: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  child.stdout.on("data", (chunk) => {
    serverOutput += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += String(chunk);
  });

  const cleanup = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    rmSync(dbDir, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    if (!(await waitForHealth(base, child))) {
      console.error("Server never became healthy.");
      if (serverOutput) console.error(serverOutput.slice(-4000));
      process.exitCode = 1;
      return;
    }
    if (!(await waitForWebhookRoute(base, child))) {
      console.error("Stripe webhook route never became ready.");
      if (serverOutput) console.error(serverOutput.slice(-4000));
      process.exitCode = 1;
      return;
    }

    await verify({ client: makeClient(base), stripe, realStripeKey: real });

    console.log(`\n${pass} passed, ${fail} failed${notCovered.length ? `, ${notCovered.length} not covered` : ""}`);
    if (notCovered.length > 0) console.log(`not covered: ${notCovered.join(", ")}`);
    if (fail > 0) {
      console.log(`failed: ${failures.join(", ")}`);
      if (serverOutput) {
        console.error("\nNext server output (tail):");
        console.error(serverOutput.slice(-4000));
      }
      process.exitCode = 1;
    }
  } finally {
    cleanup();
  }
}

await main();
