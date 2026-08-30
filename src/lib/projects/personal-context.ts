import type { PersonalContext } from "./types";
import type { ProjectRepo } from "./repo";

export const PERSONAL_CONTEXT_DEFAULTS = {
  organizationName: "Personal",
  workspaceName: "Personal",
  workspaceSlug: "personal",
  projectName: "My Project",
  projectSlug: "my-project",
  workbookName: "Main",
  workbookSlug: "main",
  environments: [
    { name: "Draft", slug: "draft", kind: "draft" },
    { name: "Test", slug: "test", kind: "test" },
    { name: "Live", slug: "live", kind: "live" },
  ],
} as const;

export class PersonalContextAdapter {
  constructor(private readonly repo: Pick<ProjectRepo, "ensurePersonalContext">) {}

  async ensurePersonalContext(ownerId: string): Promise<PersonalContext> {
    if (ownerId.trim().length === 0) {
      throw new TypeError("ownerId is required");
    }
    return this.repo.ensurePersonalContext(ownerId);
  }
}
