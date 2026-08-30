import { spawnSync } from "node:child_process";

function git(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} exited ${result.status}`);
  }
  return result.stdout.trim();
}

export function requireCleanGitEvidence(base = "origin/main") {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") {
    throw new Error(`worktree must be clean before evidence capture:\n${status}`);
  }
  git(["diff", "--check", `${base}...HEAD`]);
  return {
    commit: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
    dirty: false,
  };
}

export function assertGitEvidenceUnchanged(before, base = "origin/main") {
  const after = requireCleanGitEvidence(base);
  if (after.commit !== before.commit || after.tree !== before.tree) {
    throw new Error("Git commit or tree changed while verification was running");
  }
  return after;
}
