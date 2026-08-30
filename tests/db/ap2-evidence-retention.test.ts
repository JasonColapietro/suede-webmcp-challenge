import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import * as dbRepo from "@/lib/db/repo";
import type { ReserveAp2AuthorizationInput } from "@/lib/db/repo";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SupabaseRepo } from "@/lib/db/supabase-repo";

const OLD_TERMINAL_AT = "2026-01-01T00:00:00.000Z";
const RETENTION_CUTOFF = "2026-05-01T00:00:00.000Z";
const SCRUBBED_AT = "2026-08-14T00:00:00.000Z";

function authorizationInput(
  suffix: string,
  overrides: Partial<ReserveAp2AuthorizationInput> = {},
): ReserveAp2AuthorizationInput {
  return {
    mandateReference: `payment-reference-${suffix}`,
    paymentNonceHash: createHash("sha256").update(`nonce-${suffix}`).digest("hex"),
    requestDigest: createHash("sha256").update(`request-${suffix}`).digest("hex"),
    issuer: "https://issuer.example",
    subjectId: "subject-1",
    checkoutHash: createHash("sha256").update(`checkout-${suffix}`).digest("hex"),
    agentId: "agent-1",
    flowId: "flow-1",
    deploymentId: "deployment-1",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amountAtomic: "250000",
    amountMinorUsd: 25,
    payeeId: "merchant-suede-agent-studio",
    payTo: "0x1111111111111111111111111111111111111111",
    payer: "0x2222222222222222222222222222222222222222",
    expiresAt: "2026-08-13T18:00:00.000Z",
    paymentValidBefore: "2026-08-13T17:59:00.000Z",
    ...overrides,
  };
}

describe("bounded AP2 terminal evidence retention", () => {
  it("defaults invalid retention settings and accepts only a bounded whole-day window", () => {
    const resolve = (dbRepo as unknown as {
      resolveAp2TerminalEvidenceRetentionDays: (raw: string | undefined) => number;
    }).resolveAp2TerminalEvidenceRetentionDays;

    expect(resolve(undefined)).toBe(90);
    expect(resolve("7")).toBe(7);
    expect(resolve("365")).toBe(365);
    for (const unsafe of ["0", "6", "366", "1.5", " 30", "30 ", "-30", "NaN", "Infinity"]) {
      expect(resolve(unsafe)).toBe(90);
    }
  });

  it("rejects an unbounded cleanup batch before querying storage", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repo = new SqliteRepo(db);

    for (const limit of [0, 501, 1.5, Number.NaN]) {
      await expect(repo.scrubExpiredAp2TerminalEvidence({
        terminalBefore: RETENTION_CUTOFF,
        scrubbedAt: SCRUBBED_AT,
        limit,
      })).rejects.toThrow(/batch limit/i);
    }
  });

  it("scrubs only aged terminal payloads while retaining replay and receipt references", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repo = new SqliteRepo(db);
    const input = authorizationInput("terminal");
    const reservation = await repo.reserveAp2Authorization(input);
    if (reservation.status !== "reserved") throw new Error("expected reservation");

    await repo.transitionAp2Authorization({
      id: reservation.authorization.id,
      fromState: "authorized",
      toState: "settling",
      receiptJson: {
        authorization: {
          mode: "direct",
          checkoutReference: "checkout-reference-terminal",
          paymentReference: input.mandateReference,
        },
      },
    });
    await repo.transitionAp2Authorization({
      id: reservation.authorization.id,
      fromState: "settling",
      toState: "settled",
      tx: `0x${"a".repeat(64)}`,
    });
    await repo.transitionAp2Authorization({
      id: reservation.authorization.id,
      fromState: "settled",
      toState: "executing",
      runId: "run-terminal",
    });
    await repo.transitionAp2Authorization({
      id: reservation.authorization.id,
      fromState: "executing",
      toState: "completed",
      decisionCode: "fulfilled",
      receiptJson: {
        authorization: {
          mode: "direct",
          checkoutReference: "checkout-reference-terminal",
          paymentReference: input.mandateReference,
        },
        checkoutReceipt: "signed-sensitive-checkout-receipt",
        ignoredPayload: { customer: "must-be-scrubbed" },
      },
      resultJson: { httpStatus: 200, body: { privateOutput: "must-be-scrubbed" } },
    });
    db.prepare("UPDATE ap2_authorizations SET updated_at = ? WHERE id = ?")
      .run(OLD_TERMINAL_AT, reservation.authorization.id);

    const scrubbed = await repo.scrubExpiredAp2TerminalEvidence({
      terminalBefore: RETENTION_CUTOFF,
      scrubbedAt: SCRUBBED_AT,
      limit: 100,
    });
    const retained = await repo.getAp2AuthorizationByMandateReference(input.mandateReference);

    expect(scrubbed).toBe(1);
    expect(retained).toMatchObject({
      mandateReference: input.mandateReference,
      paymentNonceHash: input.paymentNonceHash,
      requestDigest: input.requestDigest,
      checkoutHash: input.checkoutHash,
      state: "completed",
      decisionCode: "fulfilled",
      runId: "run-terminal",
      tx: `0x${"a".repeat(64)}`,
      updatedAt: OLD_TERMINAL_AT,
      resultJson: null,
      receiptJson: {
        authorization: {
          mode: "direct",
          checkoutReference: "checkout-reference-terminal",
          paymentReference: input.mandateReference,
        },
        evidenceRetention: {
          status: "expired",
          scrubbedAt: SCRUBBED_AT,
          receiptReference: {
            kind: "checkout_receipt_sha256",
            value: createHash("sha256")
              .update("signed-sensitive-checkout-receipt")
              .digest("hex"),
          },
        },
      },
    });
    expect(JSON.stringify(retained)).not.toMatch(/privateOutput|customer|signed-sensitive/iu);

    const retry = await repo.reserveAp2Authorization(input);
    expect(retry).toMatchObject({
      status: "exact-retry",
      authorization: {
        state: "completed",
        resultJson: null,
        runId: "run-terminal",
        tx: `0x${"a".repeat(64)}`,
        receiptJson: { evidenceRetention: { status: "expired" } },
      },
    });
  });

  it("never scrubs pending reconciliation evidence regardless of age", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repo = new SqliteRepo(db);
    const input = authorizationInput("reconciliation");
    const reservation = await repo.reserveAp2Authorization(input);
    if (reservation.status !== "reserved") throw new Error("expected reservation");

    await repo.transitionAp2Authorization({
      id: reservation.authorization.id,
      fromState: "authorized",
      toState: "settling",
      receiptJson: {
        authorization: {
          mode: "autonomous",
          checkoutReference: "checkout-reference-reconciliation",
          paymentReference: input.mandateReference,
        },
        checkoutReceipt: "evidence-needed-for-reconciliation",
      },
    });
    await repo.transitionAp2Authorization({
      id: reservation.authorization.id,
      fromState: "settling",
      toState: "pending_reconciliation",
      decisionCode: "settlement_result_unavailable",
      tx: `0x${"b".repeat(64)}`,
      resultJson: { status: "unknown", evidence: "must-remain" },
    });
    db.prepare("UPDATE ap2_authorizations SET updated_at = ? WHERE id = ?")
      .run(OLD_TERMINAL_AT, reservation.authorization.id);

    expect(await repo.scrubExpiredAp2TerminalEvidence({
      terminalBefore: RETENTION_CUTOFF,
      scrubbedAt: SCRUBBED_AT,
      limit: 100,
    })).toBe(0);
    expect(await repo.getAp2AuthorizationByMandateReference(input.mandateReference))
      .toMatchObject({
        state: "pending_reconciliation",
        decisionCode: "settlement_result_unavailable",
        tx: `0x${"b".repeat(64)}`,
        resultJson: { status: "unknown", evidence: "must-remain" },
        receiptJson: {
          checkoutReceipt: "evidence-needed-for-reconciliation",
        },
        updatedAt: OLD_TERMINAL_AT,
      });
  });

  it("finalizes a reconciled direct-engine run without losing its durable run or payment facts", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repo = new SqliteRepo(db);
    const input = authorizationInput("engine-reconciled");
    const reservation = await repo.reserveAp2Authorization(input);
    if (reservation.status !== "reserved") throw new Error("expected reservation");

    await repo.transitionAp2Authorization({
      id: reservation.authorization.id,
      fromState: "authorized",
      toState: "settling",
    });
    await repo.transitionAp2Authorization({
      id: reservation.authorization.id,
      fromState: "settling",
      toState: "settled",
      tx: `0x${"c".repeat(64)}`,
    });
    await repo.transitionAp2Authorization({
      id: reservation.authorization.id,
      fromState: "settled",
      toState: "executing",
      runId: "run-engine-reconciled",
    });
    await repo.transitionAp2Authorization({
      id: reservation.authorization.id,
      fromState: "executing",
      toState: "pending_reconciliation",
      decisionCode: "fulfillment_exception_ambiguous",
    });

    const completed = await repo.transitionAp2Authorization({
      id: reservation.authorization.id,
      fromState: "pending_reconciliation",
      toState: "completed",
      decisionCode: "fulfilled_run_ledger_reconciled",
      resultJson: { httpStatus: 200, body: { runId: "run-engine-reconciled" } },
    });

    expect(completed).toMatchObject({
      state: "completed",
      decisionCode: "fulfilled_run_ledger_reconciled",
      runId: "run-engine-reconciled",
      tx: `0x${"c".repeat(64)}`,
      resultJson: { httpStatus: 200, body: { runId: "run-engine-reconciled" } },
    });
  });

  it("applies the same terminal-only bounded projection through Supabase", async () => {
    const queryCalls: Array<{ method: string; args: unknown[] }> = [];
    const patches: Array<Record<string, unknown>> = [];
    let fromCount = 0;
    const from = () => {
      fromCount += 1;
      const query: Record<string, unknown> = {};
      let operation: "select" | "update" = "select";
      query.select = (...args: unknown[]) => {
        operation = "select";
        queryCalls.push({ method: "select", args });
        return query;
      };
      query.update = (patch: Record<string, unknown>) => {
        operation = "update";
        patches.push(patch);
        return query;
      };
      for (const method of ["eq", "in", "lt", "or", "order", "limit"] as const) {
        query[method] = (...args: unknown[]) => {
          queryCalls.push({ method, args });
          return query;
        };
      }
      query.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(operation === "select"
        ? {
            data: [{
              id: "authorization-supabase",
              state: "completed",
              updated_at: OLD_TERMINAL_AT,
              result_json: { httpStatus: 200, body: { privateOutput: "remove" } },
              receipt_json: {
                authorization: {
                  mode: "direct",
                  checkoutReference: "checkout-reference-supabase",
                  paymentReference: "payment-reference-supabase",
                },
                checkoutReceipt: "supabase-signed-receipt",
                customer: "remove",
              },
            }],
            error: null,
          }
        : { data: null, error: null }).then(resolve, reject);
      return query;
    };
    const repo = new SupabaseRepo({ from } as unknown as SupabaseClient);

    expect(await repo.scrubExpiredAp2TerminalEvidence({
      terminalBefore: RETENTION_CUTOFF,
      scrubbedAt: SCRUBBED_AT,
      limit: 25,
    })).toBe(1);
    expect(fromCount).toBe(2);
    expect(queryCalls).toContainEqual({
      method: "in",
      args: ["state", ["completed", "rejected", "failed"]],
    });
    expect(queryCalls).toContainEqual({ method: "lt", args: ["updated_at", RETENTION_CUTOFF] });
    expect(queryCalls).toContainEqual({
      method: "or",
      args: [
        "result_json.not.is.null,receipt_json->evidenceRetention->>status.is.null,"
          + "receipt_json->evidenceRetention->>status.neq.expired",
      ],
    });
    expect(queryCalls).toContainEqual({ method: "limit", args: [25] });
    expect(patches).toEqual([{
      result_json: null,
      receipt_json: {
        authorization: {
          mode: "direct",
          checkoutReference: "checkout-reference-supabase",
          paymentReference: "payment-reference-supabase",
        },
        evidenceRetention: {
          status: "expired",
          scrubbedAt: SCRUBBED_AT,
          receiptReference: {
            kind: "checkout_receipt_sha256",
            value: createHash("sha256").update("supabase-signed-receipt").digest("hex"),
          },
        },
      },
    }]);
  });
});
