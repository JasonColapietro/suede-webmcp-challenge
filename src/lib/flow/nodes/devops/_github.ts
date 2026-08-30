/** Shared helpers for the GitHub REST nodes in this directory. */
import { connectionBearerToken } from "../connection-material";

/** Conservative owner/repo grammar — GitHub's real rules are looser, but this
 * is enough to keep a path segment from ever containing "/", "..", or a
 * URL-breaking character before it's percent-encoded into the request URL. */
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

export function parseRepo(repo: string): { owner: string; name: string } | null {
  if (!REPO_PATTERN.test(repo)) return null;
  const [owner, name] = repo.split("/");
  return { owner, name };
}

export function githubToken(provenance: Parameters<typeof connectionBearerToken>[0]): string | null {
  return connectionBearerToken(provenance);
}

export function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "suede-agent-studio",
    "content-type": "application/json",
  };
}

export const GITHUB_API_BASE = "https://api.github.com";
