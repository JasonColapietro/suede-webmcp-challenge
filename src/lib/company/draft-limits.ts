/** Maximum employees accepted across every department in one company draft. */
export const MAX_COMPANY_DRAFT_EMPLOYEES = 16;

interface DraftWithEmployees {
  departments: ReadonlyArray<{
    employees: ReadonlyArray<unknown>;
  }>;
}

/** Counts employees across every department without mutating the draft. */
export function countCompanyDraftEmployees(draft: DraftWithEmployees): number {
  return draft.departments.reduce(
    (total, department) => total + department.employees.length,
    0,
  );
}

/** Fails before materialization can issue its first durable write. */
export function assertCompanyDraftEmployeeLimit(draft: DraftWithEmployees): void {
  const employeeCount = countCompanyDraftEmployees(draft);
  if (employeeCount > MAX_COMPANY_DRAFT_EMPLOYEES) {
    throw new RangeError(
      `Company drafts may include at most ${MAX_COMPANY_DRAFT_EMPLOYEES} employees total`,
    );
  }
}
