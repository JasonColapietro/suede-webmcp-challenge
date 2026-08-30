import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { PersonalContextAdapter } from "@/lib/projects/personal-context";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";

describe("PersonalContextAdapter", () => {
  it("silently supplies the stable personal defaults", async () => {
    const adapter = new PersonalContextAdapter(
      new SqliteProjectRepo(new Database(":memory:")),
    );

    const context = await adapter.ensurePersonalContext("owner-1");

    expect({
      organization: context.organization.name,
      workspace: [context.workspace.name, context.workspace.slug],
      project: [context.project.name, context.project.slug],
      workbook: [context.workbook.name, context.workbook.slug],
      environments: context.environments.map(({ name, slug }) => [name, slug]),
    }).toEqual({
      organization: "Personal",
      workspace: ["Personal", "personal"],
      project: ["My Project", "my-project"],
      workbook: ["Main", "main"],
      environments: [
        ["Draft", "draft"],
        ["Test", "test"],
        ["Live", "live"],
      ],
    });
  });

  it("rejects an empty owner instead of creating globally shared context", async () => {
    const adapter = new PersonalContextAdapter(
      new SqliteProjectRepo(new Database(":memory:")),
    );

    await expect(adapter.ensurePersonalContext("   ")).rejects.toThrow("ownerId is required");
  });
});
