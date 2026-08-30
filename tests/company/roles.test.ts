import { describe, expect, it } from "vitest";
import {
  backfillCompanyRoles,
  isLegacyCompany,
  parseEmployeeRole,
  parseLifecycleStatus,
  resolveEffectiveRole,
  validateHire,
  validateReparent,
  type RoleRosterEntry,
} from "@/lib/company/roles";

function entry(
  agentId: string,
  overrides: Partial<RoleRosterEntry> = {},
): RoleRosterEntry {
  return { agentId, role: null, reportsTo: null, ...overrides };
}

/** Three employees hired before the role column existed, in hire order. */
const LEGACY_ROSTER: RoleRosterEntry[] = [
  entry("agent-first"),
  entry("agent-second"),
  entry("agent-third"),
];

describe("resolveEffectiveRole", () => {
  it("reads a legacy roster as one CEO and the rest workers, without throwing", () => {
    const resolved = LEGACY_ROSTER.map((employee) => ({
      agentId: employee.agentId,
      role: resolveEffectiveRole(employee, LEGACY_ROSTER),
    }));

    expect(resolved).toEqual([
      { agentId: "agent-first", role: "ceo" },
      { agentId: "agent-second", role: "worker" },
      { agentId: "agent-third", role: "worker" },
    ]);
    expect(resolved.filter((item) => item.role === "ceo")).toHaveLength(1);
  });

  it("keeps a stored role and never invents a second CEO", () => {
    const roster: RoleRosterEntry[] = [
      entry("agent-legacy"),
      entry("agent-boss", { role: "ceo" }),
      entry("agent-lead", { role: "manager", reportsTo: "agent-boss" }),
    ];

    expect(resolveEffectiveRole(roster[1], roster)).toBe("ceo");
    expect(resolveEffectiveRole(roster[2], roster)).toBe("manager");
    // The earliest-hired row is role-less, but someone already holds 'ceo'.
    expect(resolveEffectiveRole(roster[0], roster)).toBe("worker");
  });
});

describe("isLegacyCompany", () => {
  it("is true only when every active row predates the role column", () => {
    expect(isLegacyCompany(LEGACY_ROSTER)).toBe(true);
    expect(isLegacyCompany([...LEGACY_ROSTER, entry("agent-new", { role: "worker" })]))
      .toBe(false);
    expect(isLegacyCompany([])).toBe(false);
  });
});

describe("backfillCompanyRoles", () => {
  it("promotes the earliest hire and points the rest at it", () => {
    expect(backfillCompanyRoles(LEGACY_ROSTER)).toEqual([
      { agentId: "agent-first", role: "ceo", reportsTo: null },
      { agentId: "agent-second", role: "worker", reportsTo: "agent-first" },
      { agentId: "agent-third", role: "worker", reportsTo: "agent-first" },
    ]);
  });

  it("is idempotent: applying the patch set empties the next one", () => {
    const patches = backfillCompanyRoles(LEGACY_ROSTER);
    const patched = LEGACY_ROSTER.map((employee) => {
      const patch = patches.find((candidate) => candidate.agentId === employee.agentId);
      return patch ? { ...employee, role: patch.role, reportsTo: patch.reportsTo } : employee;
    });

    expect(backfillCompanyRoles(patched)).toEqual([]);
  });

  it("repairs role-less rows around an existing CEO and leaves roled rows alone", () => {
    const roster: RoleRosterEntry[] = [
      entry("agent-orphan"),
      entry("agent-boss", { role: "ceo" }),
      entry("agent-lead", { role: "manager", reportsTo: "agent-boss" }),
    ];

    expect(backfillCompanyRoles(roster)).toEqual([
      { agentId: "agent-orphan", role: "worker", reportsTo: "agent-boss" },
    ]);
  });

  it("does nothing for an empty roster or a part-roled one with no CEO", () => {
    expect(backfillCompanyRoles([])).toEqual([]);
    expect(
      backfillCompanyRoles([entry("agent-a", { role: "worker" }), entry("agent-b")]),
    ).toEqual([]);
  });
});

describe("validateHire", () => {
  it("accepts a hire under an active manager and one with no manager", () => {
    expect(validateHire({ agentId: "agent-new", reportsTo: "agent-first" }, LEGACY_ROSTER))
      .toEqual({ ok: true });
    expect(validateHire({ agentId: "agent-new", reportsTo: null }, LEGACY_ROSTER))
      .toEqual({ ok: true });
  });

  it("rejects a manager who is not an active employee", () => {
    const result = validateHire(
      { agentId: "agent-new", reportsTo: "agent-fired" },
      LEGACY_ROSTER,
    );
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ violation: "unknown_manager" });
  });
});

describe("validateReparent", () => {
  it("rejects an employee reporting to itself", () => {
    const result = validateReparent("agent-second", "agent-second", LEGACY_ROSTER);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ violation: "self_parent" });
  });

  it("rejects a three-node cycle", () => {
    // a -> b -> c, so pointing a's manager at c closes the loop c -> a -> b -> c.
    const roster: RoleRosterEntry[] = [
      entry("agent-a", { role: "manager", reportsTo: null }),
      entry("agent-b", { role: "manager", reportsTo: "agent-a" }),
      entry("agent-c", { role: "worker", reportsTo: "agent-b" }),
    ];

    const result = validateReparent("agent-a", "agent-c", roster);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ violation: "cycle" });
    // The same move one level shallower is still a cycle, and the walk
    // terminates rather than spinning on the loop it finds.
    expect(validateReparent("agent-b", "agent-c", roster)).toMatchObject({
      violation: "cycle",
    });
    expect(validateReparent("agent-c", "agent-a", roster)).toEqual({ ok: true });
  });

  it("rejects moving an employee who is not on the active roster", () => {
    const result = validateReparent("agent-fired", "agent-first", LEGACY_ROSTER);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ violation: "unknown_employee" });
  });
});

describe("storage value parsing", () => {
  it("narrows roles and falls back to null", () => {
    expect(parseEmployeeRole("ceo")).toBe("ceo");
    expect(parseEmployeeRole("manager")).toBe("manager");
    expect(parseEmployeeRole(null)).toBeNull();
    expect(parseEmployeeRole(undefined)).toBeNull();
    expect(parseEmployeeRole("chief")).toBeNull();
  });

  it("reads any unknown or absent lifecycle value as idle", () => {
    expect(parseLifecycleStatus("running")).toBe("running");
    expect(parseLifecycleStatus("budget_paused")).toBe("budget_paused");
    expect(parseLifecycleStatus(undefined)).toBe("idle");
    expect(parseLifecycleStatus(null)).toBe("idle");
    // Removal is the removed_at tombstone, so this is not a lifecycle value.
    expect(parseLifecycleStatus("terminated")).toBe("idle");
  });
});
